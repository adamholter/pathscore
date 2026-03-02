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
          { role: 'system', content: 'You are an expert SVG artist. Reproduce the given reference image as an SVG. Respond with ONLY the SVG code.' },
          { role: 'user', content: [
            { type: 'text', text: `Reproduce this image as SVG as accurately as possible. Use viewBox="0 0 400 400". Output ONLY the <svg> element.${prompt.text ? '\n\nAdditional context: ' + prompt.text : ''}` },
            ...(prompt.reference_image ? [{ type: 'image_url', image_url: { url: prompt.reference_image } }] : []),
          ] },
        ],
      });
    }
  }
  return pipeline.runParallelGenAndJudge(runId, runConfig, abortCtrl, genList);
}

module.exports = { execute };
