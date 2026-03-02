'use strict';

async function execute(ctx) {
  const { runId, runConfig, abortCtrl, pipeline } = ctx;
  const genList = [];
  for (const model of runConfig.models) {
    for (const prompt of runConfig.prompts) {
      genList.push({ modelId: model.id || model, prompt, reasoningEffort: model.reasoning_effort });
    }
  }
  return pipeline.runParallelGenAndJudge(runId, runConfig, abortCtrl, genList);
}

module.exports = { execute };
