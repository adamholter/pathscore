'use strict';

async function execute(ctx) {
  const { runId, runConfig, abortCtrl, pipeline, repos, services, uuidv4 } = ctx;
  const runLLMJudge = runConfig.human_eval_llm_judge !== false;

  const genList = runConfig.models.flatMap(model =>
    runConfig.prompts.map(prompt => ({ modelId: model.id || model, prompt, reasoningEffort: model.reasoning_effort }))
  );

  if (runLLMJudge) {
    await pipeline.runParallelGenAndJudge(runId, runConfig, abortCtrl, genList);
  } else {
    await Promise.allSettled(genList.map(({ modelId, prompt, reasoningEffort }) =>
      pipeline.generateOneSVG(runId, modelId, prompt, runConfig, reasoningEffort || null, abortCtrl.signal)
    ));
  }

  if (abortCtrl.signal.aborted) return 'stopped';

  const gens = repos.generations.listByRunStatus(runId, 'complete');
  const byPrompt = {};
  for (const g of gens) {
    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = [];
    byPrompt[g.prompt_id].push(g);
  }

  const cmpPromises = [];
  for (const pg of Object.values(byPrompt)) {
    for (let i = 0; i < pg.length; i++) {
      for (let j = i + 1; j < pg.length; j++) {
        const [ga, gb] = Math.random() < 0.5 ? [pg[i], pg[j]] : [pg[j], pg[i]];
        const cmpId = uuidv4();
        repos.comparisons.insertPendingHuman({
          id: cmpId,
          runId,
          promptId: ga.prompt_id,
          promptText: ga.prompt_text,
          modelA: ga.model_id,
          modelB: gb.model_id,
          genAId: ga.id,
          genBId: gb.id,
          judgeModel: 'human',
          judgeRun: 1,
          createdAt: Date.now(),
        });
        services.sse.emit(runId, 'comparison_pending_human', { cmpId, promptId: ga.prompt_id, modelA: ga.model_id, modelB: gb.model_id });
        if (runLLMJudge) {
          cmpPromises.push(pipeline.judgeOnePair(runId, ga, gb, runConfig.judge?.model || 'google/gemini-3-flash-preview', 2, abortCtrl.signal));
        }
      }
    }
  }

  await Promise.allSettled(cmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

module.exports = { execute };
