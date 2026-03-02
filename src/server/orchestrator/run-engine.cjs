'use strict';

const modeHandlers = require('../modes/index.cjs');

function createRunEngine(ctx) {
  const { repos, services, createPipeline, extensions } = ctx;
  const abortControllers = {};

  async function run(runId) {
    const runRow = repos.runs.getById(runId);
    if (!runRow) return;

    const runConfig = JSON.parse(runRow.config);
    const modeId = runRow.mode || runConfig.mode || 'standard';

    const abortCtrl = new AbortController();
    abortControllers[runId] = abortCtrl;

    repos.runs.setRunning(runId, Date.now());
    services.sse.emit(runId, 'run_start', {
      runId,
      mode: modeId,
      modelIds: runConfig.models.map(m => m.id || m),
      promptCount: runConfig.prompts.length,
    });

    try {
      const pipeline = createPipeline({ ...ctx, abortControllers });
      const modeCtx = {
        ...ctx,
        runId,
        runConfig,
        abortCtrl,
        pipeline,
      };

      let result;
      const extMode = extensions.getRegistry().mode[modeId];
      if (extMode) {
        result = await extMode(runId, runConfig, {
          ...ctx.extensionHelpers,
          abortCtrl,
        });
      } else {
        const handler = modeHandlers[modeId] || modeHandlers.standard;
        result = await handler.execute(modeCtx);
      }

      if (result === 'stopped') {
        repos.runs.setStopped(runId, Date.now());
        services.sse.emit(runId, 'run_stopped', { runId });
      } else {
        repos.runs.setComplete(runId, Date.now());
        services.sse.emit(runId, 'run_complete', { runId });
      }
      return result;
    } catch (err) {
      console.error('[runEngine]', err.message);
      repos.runs.setError(runId, Date.now(), err.message);
      services.sse.emit(runId, 'run_error', { runId, error: err.message });
      return 'error';
    } finally {
      delete abortControllers[runId];
    }
  }

  function stop(runId) {
    const ctrl = abortControllers[runId];
    if (ctrl) ctrl.abort();
  }

  return {
    run,
    stop,
  };
}

module.exports = {
  createRunEngine,
};
