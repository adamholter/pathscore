'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { getConfig } = require('./config/index.cjs');
const { createDatabase } = require('./db/index.cjs');
const { createRepositories } = require('./repositories/index.cjs');
const { createOpenRouterService } = require('./services/openrouter.cjs');
const svg = require('./services/svg.cjs');
const stats = require('./services/stats.cjs');
const { createSSEBus } = require('./services/sse.cjs');
const { createExtensionRuntime } = require('./extensions/runtime.cjs');
const { createPipeline } = require('./orchestrator/pipeline.cjs');
const { createRunEngine } = require('./orchestrator/run-engine.cjs');
const { registerRoutes } = require('./api/register-routes.cjs');

function createServer() {
  const config = getConfig();
  const db = createDatabase(config);
  const repos = createRepositories(db);

  const services = {
    openrouter: createOpenRouterService(config),
    svg,
    stats,
    sse: createSSEBus(),
  };

  const extensionHelpers = {
    generateOneSVG: (...args) => pipeline.generateOneSVG(...args),
    judgeOnePair: (...args) => pipeline.judgeOnePair(...args),
    runParallelGenAndJudge: (...args) => pipeline.runParallelGenAndJudge(...args),
    emit: services.sse.emit,
    db,
    uuidv4,
    svgToPngDataUrl: svg.svgToPngDataUrl,
    orFetch: (...args) => services.openrouter.orFetch(...args),
    orStream: (...args) => services.openrouter.orStream(...args),
    extractSVG: svg.extractSVG,
  };

  const baseCtx = {
    config,
    repos,
    services,
    uuidv4,
    extensionHelpers,
  };

  const extensions = createExtensionRuntime({
    repos,
    helpers: extensionHelpers,
    mode: config.extensionRuntime,
  });
  extensions.installBuiltins();
  extensions.rebuild();

  const pipeline = createPipeline({ ...baseCtx, extensions });
  const runEngine = createRunEngine({ ...baseCtx, createPipeline: () => pipeline, extensions });

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static('public'));

  registerRoutes(app, { ...baseCtx, runEngine, extensions, createPipeline: () => pipeline, config });

  return {
    app,
    config,
    db,
  };
}

module.exports = {
  createServer,
};
