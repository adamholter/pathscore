'use strict';

function createPipeline(ctx) {
  const {
    config,
    repos,
    services,
    uuidv4,
    abortControllers,
    extensions,
  } = ctx;

  async function generateOneSVG(runId, modelId, prompt, runConfig, reasoningEffort, signal, extraMessages) {
    const genId = uuidv4();
    repos.generations.insertGenerating(genId, runId, modelId, prompt.id, prompt.text, Date.now());
    services.sse.emit(runId, 'generation_start', { genId, modelId, promptId: prompt.id, promptText: prompt.text });

    const timeoutCtrl = new AbortController();
    const timeoutId = setTimeout(() => timeoutCtrl.abort(), config.generationTimeoutMs);
    const combinedSignal = AbortSignal.any ? AbortSignal.any([signal, timeoutCtrl.signal]) : timeoutCtrl.signal;

    const t0 = Date.now();
    try {
      const messages = extraMessages || [
        { role: 'system', content: 'You are an expert SVG artist. Generate clean, well-structured SVG code. Respond with ONLY the SVG code — no explanation, no markdown fences, just the raw <svg>...</svg> element.' },
        { role: 'user', content: `Generate an SVG image depicting: ${prompt.text}\n\nRequirements:\n- Use viewBox="0 0 400 400"\n- Make it visually detailed and accurate\n- No scripts, no HTML, SVG only\n- Output ONLY the <svg> element` },
      ];

      const body = {
        model: modelId,
        messages,
        temperature: runConfig.generation?.temperature ?? 0.7,
      };
      if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

      const providerExt = extensions.getRegistry().provider;
      const result = providerExt
        ? await providerExt(modelId, messages, runConfig)
        : await services.openrouter.orStream('/chat/completions', body, () => {}, combinedSignal);

      clearTimeout(timeoutId);
      const svg = services.svg.extractSVG(result.content) || result.content.trim();
      const elapsed = Date.now() - t0;
      repos.generations.setComplete(genId, svg, elapsed, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0, Date.now());
      services.sse.emit(runId, 'generation_complete', { genId, modelId, promptId: prompt.id, promptText: prompt.text, svgPreview: svg?.substring(0, 300), timeMs: elapsed });
      return genId;
    } catch (err) {
      clearTimeout(timeoutId);
      if (signal.aborted) return null;
      const errMsg = timeoutCtrl.signal.aborted ? `Timeout after ${config.generationTimeoutMs / 1000}s` : err.message;
      repos.generations.setError(genId, errMsg, Date.now());
      services.sse.emit(runId, 'generation_error', { genId, modelId, promptId: prompt.id, error: errMsg });
      return null;
    }
  }

  async function judgeOnePair(runId, genA, genB, judgeModel, judgeRun, signal, extraContext) {
    if (!genA.svg_content || !genB.svg_content) return null;
    const cmpId = uuidv4();
    repos.comparisons.insertJudging({
      id: cmpId,
      runId,
      promptId: genA.prompt_id,
      promptText: genA.prompt_text,
      modelA: genA.model_id,
      modelB: genB.model_id,
      genAId: genA.id,
      genBId: genB.id,
      judgeModel,
      judgeRun,
      createdAt: Date.now(),
    });

    services.sse.emit(runId, 'comparison_start', { cmpId, promptId: genA.prompt_id, promptText: genA.prompt_text, modelA: genA.model_id, modelB: genB.model_id });

    try {
      let parsed = {};
      const judgeExt = extensions.getRegistry().judge;
      if (judgeExt) {
        parsed = await judgeExt(genA, genB, { id: genA.prompt_id, text: genA.prompt_text }, { judge: { model: judgeModel } }, {
          svgToPngDataUrl: services.svg.svgToPngDataUrl,
          orFetch: services.openrouter.orFetch,
          orStream: services.openrouter.orStream,
        });
      } else {
        const pngA = services.svg.svgToPngDataUrl(genA.svg_content);
        const pngB = services.svg.svgToPngDataUrl(genB.svg_content);
        const promptContext = extraContext || `You are evaluating two SVG images for the prompt: "${genA.prompt_text}"`;
        const result = await services.openrouter.orFetch('/chat/completions', {
          model: judgeModel,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `${promptContext}\n\nModel A:` },
              { type: 'image_url', image_url: { url: pngA } },
              { type: 'text', text: 'Model B:' },
              { type: 'image_url', image_url: { url: pngB } },
              { type: 'text', text: 'Which better follows the prompt and has better visual quality?\n\nRespond with ONLY this JSON (no markdown):\n{"thought_process":"brief analysis","winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"improvement suggestion"}' },
            ],
          }],
          temperature: 0.1,
        });

        const content = result.choices?.[0]?.message?.content || '';
        const m = content.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
      }

      const winner = ['A', 'B', 'tie'].includes(parsed.winner) ? parsed.winner : null;
      repos.comparisons.setComplete(cmpId, {
        winner,
        model_a_score: parsed.model_a_score,
        model_b_score: parsed.model_b_score,
        thought_process: parsed.thought_process,
        feedback: parsed.feedback,
      }, Date.now());
      services.sse.emit(runId, 'comparison_complete', {
        cmpId,
        promptId: genA.prompt_id,
        promptText: genA.prompt_text,
        modelA: genA.model_id,
        modelB: genB.model_id,
        winner,
        scoreA: parsed.model_a_score,
        scoreB: parsed.model_b_score,
        thoughtProcess: parsed.thought_process,
        feedback: parsed.feedback,
      });
      return { cmpId, winner, feedback: parsed.feedback, thoughtProcess: parsed.thought_process };
    } catch (err) {
      if (signal?.aborted) return null;
      repos.comparisons.setError(cmpId, err.message, Date.now());
      services.sse.emit(runId, 'comparison_error', { cmpId, promptId: genA.prompt_id, modelA: genA.model_id, modelB: genB.model_id, error: err.message });
      return null;
    }
  }

  async function runParallelGenAndJudge(runId, runConfig, abortCtrl, genList) {
    const judgeModel = runConfig.judge?.model || 'google/gemini-3-flash-preview';
    const judgeRuns = runConfig.judge?.runs || 1;

    const completedByPrompt = {};
    const launchedPairs = new Set();
    const cmpPromises = [];

    function launchNewPairs(promptId) {
      const done = completedByPrompt[promptId];
      if (!done || done.length < 2) return;
      for (let i = 0; i < done.length; i++) {
        for (let j = i + 1; j < done.length; j++) {
          const key = [done[i].id, done[j].id].sort().join('|||');
          if (launchedPairs.has(key)) continue;
          launchedPairs.add(key);
          const [ga, gb] = Math.random() < 0.5 ? [done[i], done[j]] : [done[j], done[i]];
          for (let r = 1; r <= judgeRuns; r++) {
            cmpPromises.push(judgeOnePair(runId, ga, gb, judgeModel, r, abortCtrl.signal));
          }
        }
      }
    }

    const genPromises = genList.map(({ modelId, prompt, reasoningEffort, extraMessages }) =>
      generateOneSVG(runId, modelId, prompt, runConfig, reasoningEffort || null, abortCtrl.signal, extraMessages).then(genId => {
        if (!genId || abortCtrl.signal.aborted) return;
        const gen = repos.generations.getById(genId);
        if (!gen || gen.status !== 'complete') return;
        if (!completedByPrompt[prompt.id]) completedByPrompt[prompt.id] = [];
        completedByPrompt[prompt.id].push(gen);
        launchNewPairs(prompt.id);
      })
    );

    await Promise.allSettled(genPromises);
    if (abortCtrl.signal.aborted) return 'stopped';
    await Promise.allSettled(cmpPromises);
    if (abortCtrl.signal.aborted) return 'stopped';

    return 'complete';
  }

  return {
    generateOneSVG,
    judgeOnePair,
    runParallelGenAndJudge,
  };
}

module.exports = {
  createPipeline,
};
