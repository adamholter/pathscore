'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let server;
let baseUrl;
let originalCwd;

test.before(async () => {
  originalCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathscore-test-'));
  process.chdir(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'public', 'index.html'), '<!doctype html><html></html>');
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';

  const { createServer } = require('../src/server/index.cjs');
  const { app } = createServer();
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  process.chdir(originalCwd);
});

test('runs lifecycle create/get/update/delete works', async () => {
  const config = {
    mode: 'standard',
    models: [{ id: 'google/gemini-2.5-flash' }],
    prompts: [{ id: 'p1', text: 'a red square' }],
    judge: { model: 'google/gemini-2.5-flash', runs: 1 },
    generation: { temperature: 0.7 },
  };

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test run', config, mode: 'standard' }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.ok(created.id);

  const getRes = await fetch(`${baseUrl}/api/runs/${created.id}`);
  assert.equal(getRes.status, 200);
  const run = await getRes.json();
  assert.equal(run.name, 'test run');

  const updateRes = await fetch(`${baseUrl}/api/runs/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test run 2' }),
  });
  assert.equal(updateRes.status, 200);

  const delRes = await fetch(`${baseUrl}/api/runs/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
});

test('extensions CRUD and toggle works', async () => {
  const createRes = await fetch(`${baseUrl}/api/extensions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'test extension',
      description: 'desc',
      hook_type: 'results',
      fn_body: 'return function(){ return { scores: {}, label: "ok" }; };',
    }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json();
  assert.ok(created.id);

  const getRes = await fetch(`${baseUrl}/api/extensions/${created.id}`);
  assert.equal(getRes.status, 200);

  const toggleRes = await fetch(`${baseUrl}/api/extensions/${created.id}/toggle`, { method: 'POST' });
  assert.equal(toggleRes.status, 200);

  const delRes = await fetch(`${baseUrl}/api/extensions/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
});

test('results and defaults endpoints return expected shapes', async () => {
  const dp = await fetch(`${baseUrl}/api/default-prompts`);
  assert.equal(dp.status, 200);
  const prompts = await dp.json();
  assert.ok(Array.isArray(prompts));
  assert.ok(prompts.length > 0);

  const config = {
    mode: 'standard',
    models: [{ id: 'google/gemini-2.5-flash' }],
    prompts: [{ id: 'p1', text: 'a red square' }],
    judge: { model: 'google/gemini-2.5-flash', runs: 1 },
    generation: { temperature: 0.7 },
  };
  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'results shape run', config, mode: 'standard' }),
  });
  const created = await createRes.json();

  const resultsRes = await fetch(`${baseUrl}/api/runs/${created.id}/results`);
  assert.equal(resultsRes.status, 200);
  const results = await resultsRes.json();
  assert.ok(results.run);
  assert.ok(Array.isArray(results.leaderboard));
  assert.ok(Array.isArray(results.models));
  assert.ok(Array.isArray(results.generations));
  assert.ok(Array.isArray(results.comparisons));
});
