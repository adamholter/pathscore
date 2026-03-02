'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

function getConfig(cwd = process.cwd()) {
  loadEnv(cwd);
  return {
    cwd,
    port: process.env.PORT || 7642,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    openrouterBase: 'https://openrouter.ai/api/v1',
    generationTimeoutMs: 5 * 60 * 1000,
    extensionRuntime: process.env.PATHSCORE_EXTENSION_RUNTIME || 'legacy',
    invariantChecks: process.env.PATHSCORE_INVARIANT_CHECKS === '1',
  };
}

module.exports = {
  getConfig,
};
