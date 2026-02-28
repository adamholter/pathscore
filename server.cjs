// PathScore — SVG Generation Benchmark Server
'use strict';

const fs = require('fs');
fs.mkdirSync('./data', { recursive: true });
fs.mkdirSync('./logs', { recursive: true });

// Load env
if (fs.existsSync('./.env')) {
  fs.readFileSync('./.env', 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 7642;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ── Database ────────────────────────────────────────────────────────────────
const db = new Database('./data/pathscore.db');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL,
  started_at INTEGER, completed_at INTEGER, error TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL, prompt_text TEXT NOT NULL, svg_content TEXT,
  generation_time_ms INTEGER, tokens_prompt INTEGER, tokens_completion INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL, model_a_id TEXT NOT NULL, model_b_id TEXT NOT NULL,
  generation_a_id TEXT NOT NULL, generation_b_id TEXT NOT NULL,
  judge_model TEXT NOT NULL, judge_run INTEGER NOT NULL DEFAULT 1,
  winner TEXT, model_a_score REAL, model_b_score REAL,
  thought_process TEXT, feedback TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
)`);

// ── SSE state ───────────────────────────────────────────────────────────────
const sseClients = {};
const runAbortControllers = {};
const runEventLogs = {};

function getLog(runId) {
  if (!runEventLogs[runId]) runEventLogs[runId] = [];
  return runEventLogs[runId];
}

function emit(runId, type, data) {
  const ev = { type, data, ts: Date.now() };
  getLog(runId).push(ev);
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  (sseClients[runId] || new Set()).forEach(res => { try { res.write(payload); } catch (_) {} });
}

// ── OpenRouter helpers ──────────────────────────────────────────────────────
async function orFetch(path, body) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${OPENROUTER_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pathscore.dev',
      'X-OpenRouter-Title': 'PathScore',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

async function orStream(path, body, onChunk, signal) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${OPENROUTER_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pathscore.dev',
      'X-OpenRouter-Title': 'PathScore',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    const json = await res.json();
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  let buffer = '';
  let full = '';
  let usage = null;
  for await (const chunk of res.body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const p = JSON.parse(data);
        if (p.error) throw new Error(p.error.message);
        const delta = p.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onChunk(delta, full); }
        if (p.usage) usage = p.usage;
      } catch (e) { if (e.message && !e.message.includes('JSON')) throw e; }
    }
  }
  return { content: full, usage };
}

// Models cache
let modelsCache = null;
let modelsCacheTime = 0;
async function getModels() {
  if (modelsCache && Date.now() - modelsCacheTime < 3600000) return modelsCache;
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
  });
  const json = await res.json();
  modelsCache = (json.data || []).sort((a, b) => b.created - a.created);
  modelsCacheTime = Date.now();
  return modelsCache;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function extractSVG(text) {
  const cb = text.match(/```(?:svg|xml)?\s*(<svg[\s\S]*?<\/svg>)/i);
  if (cb) return cb[1].trim();
  const raw = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (raw) return raw[0].trim();
  return null;
}

function svgToDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function calcELO(comparisons, models) {
  const K = 32;
  const ratings = Object.fromEntries(models.map(m => [m, 1000]));
  const sorted = [...comparisons]
    .filter(c => c.status === 'complete' && c.winner)
    .sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));
  for (const c of sorted) {
    const ra = ratings[c.model_a_id] ?? 1000;
    const rb = ratings[c.model_b_id] ?? 1000;
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const sa = c.winner === 'A' ? 1 : c.winner === 'B' ? 0 : 0.5;
    ratings[c.model_a_id] = ra + K * (sa - ea);
    ratings[c.model_b_id] = rb + K * ((1 - sa) - (1 - ea));
  }
  return ratings;
}

function calcStats(comparisons, models) {
  const stats = Object.fromEntries(models.map(m => [m, { wins: 0, losses: 0, ties: 0, total: 0, score_sum: 0, score_count: 0 }]));
  for (const c of comparisons) {
    if (c.status !== 'complete' || !c.winner) continue;
    const a = stats[c.model_a_id], b = stats[c.model_b_id];
    if (!a || !b) continue;
    a.total++; b.total++;
    if (c.winner === 'A') { a.wins++; b.losses++; }
    else if (c.winner === 'B') { b.wins++; a.losses++; }
    else { a.ties++; b.ties++; }
    if (c.model_a_score != null) { a.score_sum += c.model_a_score; a.score_count++; }
    if (c.model_b_score != null) { b.score_sum += c.model_b_score; b.score_count++; }
  }
  return stats;
}

function calcHeatmap(comparisons, models) {
  const matrix = {};
  models.forEach(a => { matrix[a] = {}; models.forEach(b => { matrix[a][b] = null; }); });
  const pairs = {};
  for (const c of comparisons) {
    if (c.status !== 'complete' || !c.winner) continue;
    const key = [c.model_a_id, c.model_b_id].sort().join('|||');
    if (!pairs[key]) pairs[key] = { wins: {}, total: 0 };
    pairs[key].total++;
    const winner_model = c.winner === 'A' ? c.model_a_id : c.winner === 'B' ? c.model_b_id : null;
    if (winner_model) pairs[key].wins[winner_model] = (pairs[key].wins[winner_model] || 0) + 1;
  }
  for (const [key, data] of Object.entries(pairs)) {
    const [ma, mb] = key.split('|||');
    if (!models.includes(ma) || !models.includes(mb)) continue;
    const wa = data.wins[ma] || 0;
    const wb = data.wins[mb] || 0;
    matrix[ma][mb] = data.total > 0 ? wa / data.total : null;
    matrix[mb][ma] = data.total > 0 ? wb / data.total : null;
  }
  return matrix;
}

// ── Benchmark execution ─────────────────────────────────────────────────────
async function runBenchmark(runId) {
  const runRow = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!runRow) return;
  const config = JSON.parse(runRow.config);
  const { models, prompts, judge } = config;
  const modelIds = models.map(m => m.id || m);

  const abortCtrl = new AbortController();
  runAbortControllers[runId] = abortCtrl;
  db.prepare(`UPDATE runs SET status='running', started_at=? WHERE id=?`).run(Date.now(), runId);
  emit(runId, 'run_start', { runId, modelIds, promptCount: prompts.length });

  try {
    // Phase 1: Generate all SVGs in parallel
    const genPromises = [];
    for (const model of models) {
      const modelId = model.id || model;
      for (const prompt of prompts) {
        genPromises.push(generateOneSVG(runId, modelId, prompt, config, model.reasoning_effort || null, abortCtrl.signal));
      }
    }
    await Promise.allSettled(genPromises);

    if (abortCtrl.signal.aborted) {
      db.prepare(`UPDATE runs SET status='stopped', completed_at=? WHERE id=?`).run(Date.now(), runId);
      emit(runId, 'run_stopped', { runId });
      return;
    }

    // Phase 2: Pairwise judgments
    const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? AND status='complete'`).all(runId);
    const byPrompt = {};
    for (const g of gens) {
      if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = [];
      byPrompt[g.prompt_id].push(g);
    }

    const cmpPromises = [];
    for (const [, pg] of Object.entries(byPrompt)) {
      for (let i = 0; i < pg.length; i++) {
        for (let j = i + 1; j < pg.length; j++) {
          const [ga, gb] = Math.random() < 0.5 ? [pg[i], pg[j]] : [pg[j], pg[i]];
          const judgeRuns = judge?.runs || 1;
          for (let r = 1; r <= judgeRuns; r++) {
            cmpPromises.push(judgeOnePair(runId, ga, gb, judge?.model || 'google/gemini-3-flash-preview', r, abortCtrl.signal));
          }
        }
      }
    }
    await Promise.allSettled(cmpPromises);

    if (abortCtrl.signal.aborted) {
      db.prepare(`UPDATE runs SET status='stopped', completed_at=? WHERE id=?`).run(Date.now(), runId);
      emit(runId, 'run_stopped', { runId });
      return;
    }

    db.prepare(`UPDATE runs SET status='complete', completed_at=? WHERE id=?`).run(Date.now(), runId);
    emit(runId, 'run_complete', { runId });
  } catch (err) {
    console.error('[runBenchmark]', err.message);
    db.prepare(`UPDATE runs SET status='error', completed_at=?, error=? WHERE id=?`).run(Date.now(), err.message, runId);
    emit(runId, 'run_error', { runId, error: err.message });
  } finally {
    delete runAbortControllers[runId];
  }
}

async function generateOneSVG(runId, modelId, prompt, config, reasoningEffort, signal) {
  const genId = uuidv4();
  db.prepare(`INSERT INTO generations (id, run_id, model_id, prompt_id, prompt_text, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'generating', ?)`).run(genId, runId, modelId, prompt.id, prompt.text, Date.now());
  emit(runId, 'generation_start', { genId, modelId, promptId: prompt.id, promptText: prompt.text });

  const t0 = Date.now();
  try {
    const body = {
      model: modelId,
      messages: [
        { role: 'system', content: 'You are an expert SVG artist. Generate clean, well-structured SVG code. Respond with ONLY the SVG code — no explanation, no markdown fences, just the raw <svg>...</svg> element.' },
        { role: 'user', content: `Generate an SVG image depicting: ${prompt.text}\n\nRequirements:\n- Use viewBox="0 0 400 400"\n- Make it visually detailed and accurate\n- No scripts, no HTML, SVG only\n- Output ONLY the <svg> element` },
      ],
      max_tokens: config.generation?.max_tokens || 4096,
      temperature: config.generation?.temperature ?? 0.7,
    };
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

    const result = await orStream('/chat/completions', body, () => {}, signal);
    const svg = extractSVG(result.content) || result.content.trim();
    const elapsed = Date.now() - t0;

    db.prepare(`UPDATE generations SET svg_content=?, generation_time_ms=?, tokens_prompt=?, tokens_completion=?, status='complete', completed_at=? WHERE id=?`)
      .run(svg, elapsed, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0, Date.now(), genId);
    emit(runId, 'generation_complete', { genId, modelId, promptId: prompt.id, promptText: prompt.text, svgPreview: svg?.substring(0, 300), timeMs: elapsed });
  } catch (err) {
    if (signal.aborted) return;
    db.prepare(`UPDATE generations SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), genId);
    emit(runId, 'generation_error', { genId, modelId, promptId: prompt.id, error: err.message });
  }
}

async function judgeOnePair(runId, genA, genB, judgeModel, judgeRun, signal) {
  if (!genA.svg_content || !genB.svg_content) return;
  const cmpId = uuidv4();
  db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
    generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`).run(
    cmpId, runId, genA.prompt_id, genA.prompt_text,
    genA.model_id, genB.model_id, genA.id, genB.id, judgeModel, judgeRun, Date.now());
  emit(runId, 'comparison_start', { cmpId, promptId: genA.prompt_id, promptText: genA.prompt_text, modelA: genA.model_id, modelB: genB.model_id });

  try {
    const result = await orFetch('/chat/completions', {
      model: judgeModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `You are evaluating two SVG images for the prompt: "${genA.prompt_text}"\n\nModel A:` },
          { type: 'image_url', image_url: { url: svgToDataUrl(genA.svg_content) } },
          { type: 'text', text: 'Model B:' },
          { type: 'image_url', image_url: { url: svgToDataUrl(genB.svg_content) } },
          { type: 'text', text: `Which better follows the prompt and has better visual quality?\n\nRespond with ONLY this JSON (no markdown):\n{"thought_process":"brief analysis","winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"improvement suggestion"}` },
        ],
      }],
      max_tokens: 1024,
      temperature: 0.1,
    });

    const content = result.choices?.[0]?.message?.content || '';
    let parsed = {};
    try {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (_) {}

    const winner = ['A', 'B', 'tie'].includes(parsed.winner) ? parsed.winner : null;
    db.prepare(`UPDATE comparisons SET winner=?, model_a_score=?, model_b_score=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`)
      .run(winner, parsed.model_a_score ?? null, parsed.model_b_score ?? null, parsed.thought_process || null, parsed.feedback || null, Date.now(), cmpId);
    emit(runId, 'comparison_complete', { cmpId, promptId: genA.prompt_id, promptText: genA.prompt_text, modelA: genA.model_id, modelB: genB.model_id, winner, scoreA: parsed.model_a_score, scoreB: parsed.model_b_score, thoughtProcess: parsed.thought_process, feedback: parsed.feedback });
  } catch (err) {
    if (signal?.aborted) return;
    db.prepare(`UPDATE comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), cmpId);
    emit(runId, 'comparison_error', { cmpId, promptId: genA.prompt_id, modelA: genA.model_id, modelB: genB.model_id, error: err.message });
  }
}

// ── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/models', async (req, res) => {
  try {
    const all = await getModels();
    const q = (req.query.q || '').toLowerCase();
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 30;
    let filtered = all.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    const total = filtered.length;
    res.json({ models: filtered.slice(offset, offset + limit), total, offset, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/runs', (req, res) => {
  const runs = db.prepare(`SELECT id, name, status, created_at, started_at, completed_at FROM runs ORDER BY created_at DESC`).all();
  res.json(runs.map(r => ({
    ...r,
    genTotal: db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=?`).get(r.id).n,
    genDone: db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=? AND status='complete'`).get(r.id).n,
    cmpTotal: db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=?`).get(r.id).n,
    cmpDone: db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=? AND status='complete'`).get(r.id).n,
  })));
});

app.post('/api/runs', (req, res) => {
  const { name, config } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO runs (id, name, config, status, created_at) VALUES (?, ?, ?, 'draft', ?)`).run(id, name, JSON.stringify(config), Date.now());
  res.json({ id, name, status: 'draft' });
});

app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ ...run, config: JSON.parse(run.config) });
});

app.put('/api/runs/:id', (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status === 'running') return res.status(400).json({ error: 'Cannot edit running benchmark' });
  const { name, config } = req.body;
  if (name) db.prepare(`UPDATE runs SET name=? WHERE id=?`).run(name, req.params.id);
  if (config) db.prepare(`UPDATE runs SET config=? WHERE id=?`).run(JSON.stringify(config), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/runs/:id', (req, res) => {
  db.prepare(`DELETE FROM comparisons WHERE run_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM generations WHERE run_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM runs WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/runs/:id/start', async (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status === 'running') return res.status(400).json({ error: 'Already running' });
  if (['complete', 'error', 'stopped'].includes(run.status)) {
    db.prepare(`DELETE FROM comparisons WHERE run_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM generations WHERE run_id=?`).run(req.params.id);
    runEventLogs[req.params.id] = [];
  }
  res.json({ ok: true });
  runBenchmark(req.params.id).catch(console.error);
});

app.post('/api/runs/:id/stop', (req, res) => {
  const ctrl = runAbortControllers[req.params.id];
  if (ctrl) ctrl.abort();
  res.json({ ok: true });
});

app.get('/api/runs/:id/events', (req, res) => {
  const runId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  for (const ev of getLog(runId)) {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }

  if (!sseClients[runId]) sseClients[runId] = new Set();
  sseClients[runId].add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); } }, 15000);
  req.on('close', () => { clearInterval(ping); sseClients[runId]?.delete(res); });
});

app.get('/api/runs/:id/results', (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const config = JSON.parse(run.config);
  const modelIds = config.models.map(m => m.id || m);
  const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? ORDER BY created_at`).all(req.params.id);
  const cmps = db.prepare(`SELECT * FROM comparisons WHERE run_id=? ORDER BY created_at`).all(req.params.id);
  const elo = calcELO(cmps, modelIds);
  const stats = calcStats(cmps, modelIds);
  const heatmap = calcHeatmap(cmps, modelIds);
  const leaderboard = modelIds.map(m => ({
    model: m, elo: Math.round(elo[m] || 1000), ...stats[m],
    avgScore: stats[m]?.score_count > 0 ? +(stats[m].score_sum / stats[m].score_count).toFixed(2) : null,
  })).sort((a, b) => b.elo - a.elo);
  res.json({ run: { ...run, config }, leaderboard, heatmap, models: modelIds, generations: gens, comparisons: cmps });
});

app.get('/api/generations/:id/svg', (req, res) => {
  const gen = db.prepare(`SELECT * FROM generations WHERE id=?`).get(req.params.id);
  if (!gen) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(gen.svg_content || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f5f5f5"/><text x="200" y="200" text-anchor="middle" fill="#999" font-family="monospace">No SVG</text></svg>');
});

app.get('/api/runs/:id/export/json', (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const gens = db.prepare(`SELECT * FROM generations WHERE run_id=?`).all(req.params.id);
  const cmps = db.prepare(`SELECT * FROM comparisons WHERE run_id=?`).all(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="pathscore-${run.id.slice(0,8)}.json"`);
  res.json({ run: { ...run, config: JSON.parse(run.config) }, generations: gens, comparisons: cmps, exported_at: Date.now() });
});

app.post('/api/runs/import', (req, res) => {
  const { run, generations, comparisons } = req.body;
  if (!run || !generations) return res.status(400).json({ error: 'invalid import data' });
  const existing = db.prepare(`SELECT id FROM runs WHERE id=?`).get(run.id);
  const runId = existing ? uuidv4() : run.id;
  try {
    db.prepare(`INSERT INTO runs (id, name, config, status, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      runId, run.name + (existing ? ' (imported)' : ''),
      typeof run.config === 'string' ? run.config : JSON.stringify(run.config),
      run.status || 'complete', run.created_at || Date.now(), run.started_at || null, run.completed_at || null);
    const ig = db.prepare(`INSERT OR IGNORE INTO generations (id, run_id, model_id, prompt_id, prompt_text, svg_content,
      generation_time_ms, tokens_prompt, tokens_completion, status, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const g of generations) ig.run(g.id, runId, g.model_id, g.prompt_id, g.prompt_text, g.svg_content,
      g.generation_time_ms, g.tokens_prompt, g.tokens_completion, g.status, g.error, g.created_at, g.completed_at);
    if (comparisons) {
      const ic = db.prepare(`INSERT OR IGNORE INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
        generation_a_id, generation_b_id, judge_model, judge_run, winner, model_a_score, model_b_score,
        thought_process, feedback, status, error, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const c of comparisons) ic.run(c.id, runId, c.prompt_id, c.prompt_text, c.model_a_id, c.model_b_id,
        c.generation_a_id, c.generation_b_id, c.judge_model, c.judge_run,
        c.winner, c.model_a_score, c.model_b_score, c.thought_process, c.feedback,
        c.status, c.error, c.created_at, c.completed_at);
    }
    res.json({ ok: true, runId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/generate-prompts', async (req, res) => {
  const { description, count = 10, existing = [] } = req.body;
  try {
    const result = await orFetch('/chat/completions', {
      model: 'google/gemini-3-flash-preview',
      messages: [{ role: 'user', content: `Generate ${count} diverse SVG benchmark prompts for: "${description}"\n\nMake them specific, visual, and testable. Cover variety: illustrations, icons, logos, data viz, abstract shapes.\nAvoid duplicating: ${existing.map(p => p.text).join(', ')}\n\nRespond ONLY with a JSON array: [{"id":"uuid","text":"prompt text","category":"category"},...]\nCategories: illustration, logo, icon, data-visualization, abstract, typography, scene` }],
      max_tokens: 2048,
      temperature: 0.8,
    });
    const content = result.choices?.[0]?.message?.content || '[]';
    const m = content.match(/\[[\s\S]*\]/);
    let prompts = [];
    if (m) { prompts = JSON.parse(m[0]).map(p => ({ ...p, id: p.id || uuidv4() })); }
    res.json({ prompts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/default-prompts', (_, res) => res.json([
  { id: uuidv4(), text: 'a pelican riding a red bicycle', category: 'illustration' },
  { id: uuidv4(), text: 'a red apple with a green leaf on white background', category: 'illustration' },
  { id: uuidv4(), text: 'a bar chart with four blue bars labeled Q1 Q2 Q3 Q4', category: 'data-visualization' },
  { id: uuidv4(), text: 'a bold geometric letter P as a modern logo mark', category: 'logo' },
  { id: uuidv4(), text: 'a house icon with triangular roof rectangular door and two windows', category: 'icon' },
  { id: uuidv4(), text: 'concentric circles with gradient from dark blue to white', category: 'abstract' },
  { id: uuidv4(), text: 'a smiling sun with eight triangular rays', category: 'illustration' },
  { id: uuidv4(), text: 'a shield shape with a five-pointed star in the center', category: 'icon' },
  { id: uuidv4(), text: 'a simple analog clock face showing 3 oclock', category: 'illustration' },
  { id: uuidv4(), text: 'the Google logo colors arranged as a pie chart', category: 'data-visualization' },
]));

app.listen(PORT, () => console.log(`PathScore running on http://localhost:${PORT}`));
