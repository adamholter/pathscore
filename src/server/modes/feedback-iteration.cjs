'use strict';

const standardMode = require('./standard.cjs');

async function execute(ctx) {
  const { runId, runConfig, abortCtrl, pipeline, repos, services, uuidv4 } = ctx;

  const phase12Result = await standardMode.execute(ctx);
  if (phase12Result === 'stopped') return 'stopped';

  services.sse.emit(runId, 'phase_start', { phase: 3, label: 'Generating iterations based on feedback' });

  const gens = repos.generations.listByRunStatus(runId, 'complete');
  const cmps = repos.comparisons.listByRunStatus(runId, 'complete');
  const iterModels = runConfig.iteration_models || runConfig.models;

  const byPrompt = {};
  for (const g of gens) {
    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = { gens: [], wins: {} };
    byPrompt[g.prompt_id].gens.push(g);
  }
  for (const c of cmps) {
    if (!c.winner || !byPrompt[c.prompt_id]) continue;
    const winnerId = c.winner === 'A' ? c.generation_a_id : c.winner === 'B' ? c.generation_b_id : null;
    if (winnerId) byPrompt[c.prompt_id].wins[winnerId] = (byPrompt[c.prompt_id].wins[winnerId] || 0) + 1;
  }

  const iterPromises = [];
  for (const [promptId, data] of Object.entries(byPrompt)) {
    const promptGens = data.gens;
    const wins = data.wins;
    let bestGen = promptGens[0];
    let bestWins = wins[bestGen?.id] || 0;
    for (const g of promptGens) {
      const w = wins[g.id] || 0;
      if (w > bestWins) {
        bestWins = w;
        bestGen = g;
      }
    }
    if (!bestGen) continue;

    const bestCmp = cmps.find(c => c.prompt_id === promptId && (c.generation_a_id === bestGen.id || c.generation_b_id === bestGen.id) && c.feedback);
    const feedback = bestCmp?.feedback || 'Improve visual quality, accuracy, and detail.';

    for (const iterModelObj of iterModels) {
      const iterModelId = iterModelObj.id || iterModelObj;
      iterPromises.push((async () => {
        const iterId = uuidv4();
        repos.iterations.insertGenerating({
          id: iterId,
          runId,
          parentGenerationId: bestGen.id,
          modelId: iterModelId,
          promptId,
          promptText: bestGen.prompt_text,
          feedback,
          createdAt: Date.now(),
        });
        services.sse.emit(runId, 'iteration_start', { iterId, modelId: iterModelId, promptId, feedback });

        try {
          const result = await services.openrouter.orStream('/chat/completions', {
            model: iterModelId,
            messages: [
              { role: 'system', content: 'You are an expert SVG artist. Improve the given SVG based on the feedback provided. Respond with ONLY the improved SVG code.' },
              { role: 'user', content: [{ type: 'text', text: `Original SVG prompt: ${bestGen.prompt_text}\n\nFeedback for improvement: ${feedback}\n\nOriginal SVG:\n${bestGen.svg_content}\n\nPlease create an improved version of this SVG based on the feedback. Output ONLY the <svg> element.` }] },
            ],
            temperature: 0.7,
          }, () => {}, abortCtrl.signal);
          const svg = services.svg.extractSVG(result.content) || result.content.trim();
          repos.iterations.setComplete(iterId, svg, Date.now());
          services.sse.emit(runId, 'iteration_complete', { iterId, modelId: iterModelId, promptId });
        } catch (err) {
          repos.iterations.setError(iterId, err.message, Date.now());
          services.sse.emit(runId, 'iteration_error', { iterId, modelId: iterModelId, error: err.message });
        }
      })());
    }
  }

  await Promise.allSettled(iterPromises);
  if (abortCtrl.signal.aborted) return 'stopped';

  services.sse.emit(runId, 'phase_start', { phase: 4, label: 'Judging iterations' });
  const iters = repos.iterations.listByRunStatus(runId, 'complete');
  const itersByPrompt = {};
  for (const it of iters) {
    if (!itersByPrompt[it.prompt_id]) itersByPrompt[it.prompt_id] = [];
    itersByPrompt[it.prompt_id].push(it);
  }

  const iterCmpPromises = [];
  for (const [promptId, promptIters] of Object.entries(itersByPrompt)) {
    const origGen = repos.db.prepare(`SELECT * FROM generations WHERE run_id=? AND prompt_id=? AND status='complete' LIMIT 1`).get(runId, promptId);
    if (!origGen || !origGen.svg_content) continue;

    for (let i = 0; i < promptIters.length; i++) {
      for (let j = i + 1; j < promptIters.length; j++) {
        const itA = promptIters[i];
        const itB = promptIters[j];
        iterCmpPromises.push((async () => {
          if (!itA.svg_content || !itB.svg_content) return;
          const icmpId = uuidv4();
          repos.iterationComparisons.insertJudging({
            id: icmpId,
            runId,
            promptId,
            promptText: origGen.prompt_text,
            originalGenerationId: origGen.id,
            iterAId: itA.id,
            iterBId: itB.id,
            judgeModel: runConfig.judge?.model || 'google/gemini-3-flash-preview',
            createdAt: Date.now(),
          });

          try {
            const result = await services.openrouter.orFetch('/chat/completions', {
              model: runConfig.judge?.model || 'google/gemini-3-flash-preview',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: `You are evaluating improved SVG versions for prompt: \"${origGen.prompt_text}\"\n\nOriginal feedback: ${itA.feedback_used || 'N/A'}\n\nOriginal SVG:` },
                  { type: 'image_url', image_url: { url: services.svg.svgToPngDataUrl(origGen.svg_content) } },
                  { type: 'text', text: 'Improved version A:' },
                  { type: 'image_url', image_url: { url: services.svg.svgToPngDataUrl(itA.svg_content) } },
                  { type: 'text', text: 'Improved version B:' },
                  { type: 'image_url', image_url: { url: services.svg.svgToPngDataUrl(itB.svg_content) } },
                  { type: 'text', text: 'Which improved version is better? Note: if BOTH improved versions are WORSE than the original, set both_bad to 1.\n\nRespond with ONLY this JSON:\n{"thought_process":"analysis","winner":"A" or "B","model_a_score":0-10,"model_b_score":0-10,"both_bad":0 or 1,"feedback":"notes"}' },
                ],
              }],
              temperature: 0.1,
            });
            const content = result.choices?.[0]?.message?.content || '';
            let parsed = {};
            try { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
            repos.iterationComparisons.setComplete(icmpId, {
              winner: ['A', 'B'].includes(parsed.winner) ? parsed.winner : 'A',
              model_a_score: parsed.model_a_score,
              model_b_score: parsed.model_b_score,
              both_bad: parsed.both_bad ? 1 : 0,
              thought_process: parsed.thought_process,
              feedback: parsed.feedback,
            }, Date.now());
            services.sse.emit(runId, 'iter_comparison_complete', { icmpId, promptId, modelA: itA.model_id, modelB: itB.model_id, winner: parsed.winner, bothBad: parsed.both_bad ? 1 : 0 });
          } catch (err) {
            repos.iterationComparisons.setError(icmpId, err.message, Date.now());
          }
        })());
      }
    }
  }

  await Promise.allSettled(iterCmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

module.exports = { execute };
