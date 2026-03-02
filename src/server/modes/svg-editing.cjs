'use strict';

async function execute(ctx) {
  const { runId, runConfig, abortCtrl, pipeline } = ctx;
  const genList = [];
  for (const model of runConfig.models) {
    for (const prompt of runConfig.prompts) {
      genList.push({
        modelId: model.id || model,
        prompt,
        reasoningEffort: model.reasoning_effort,
        extraMessages: [
          { role: 'system', content: 'You are an expert SVG editor. Apply the requested edit to the SVG code. Respond with ONLY the complete edited SVG.' },
          { role: 'user', content: `Edit this SVG according to the instruction:\n\nInstruction: ${prompt.edit_instruction || prompt.text}\n\nOriginal SVG:\n${prompt.source_svg || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"></svg>'}\n\nOutput ONLY the edited <svg> element.` },
        ],
      });
    }
  }
  return pipeline.runParallelGenAndJudge(runId, runConfig, abortCtrl, genList);
}

module.exports = { execute };
