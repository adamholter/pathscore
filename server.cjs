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
const { Resvg } = require('@resvg/resvg-js');
// node-fetch is ESM-only; cache the import promise so it resolves once
const fetchPromise = import('node-fetch').then(m => m.default);

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const PORT = process.env.PORT || 7642;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ── Database ────────────────────────────────────────────────────────────────
const db = new Database('./data/pathscore.db');
db.pragma('journal_mode = WAL');

db.exec(`CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, config TEXT NOT NULL,
  mode TEXT DEFAULT 'standard',
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

db.exec(`CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_generation_id TEXT NOT NULL,
  model_id TEXT NOT NULL, prompt_id TEXT NOT NULL, prompt_text TEXT NOT NULL,
  feedback_used TEXT, svg_content TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
)`);

db.exec(`CREATE TABLE IF NOT EXISTS iteration_comparisons (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, prompt_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL, original_generation_id TEXT NOT NULL,
  iter_a_id TEXT NOT NULL, iter_b_id TEXT NOT NULL,
  judge_model TEXT NOT NULL, winner TEXT,
  model_a_score REAL, model_b_score REAL,
  both_bad INTEGER DEFAULT 0,
  thought_process TEXT, feedback TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER
)`);

db.exec(`CREATE TABLE IF NOT EXISTS extensions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  hook_type TEXT NOT NULL,
  mode_id TEXT,
  mode_label TEXT,
  mode_icon TEXT,
  mode_desc TEXT,
  fn_body TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS judge_eval_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  gen_a_id TEXT NOT NULL,
  gen_b_id TEXT NOT NULL,
  prompt_id TEXT,
  prompt_text TEXT,
  verdicts TEXT NOT NULL,
  human_winner TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER,
  completed_at INTEGER
)`);

// Add human_winner/human_feedback columns to comparisons (migration)
try { db.exec('ALTER TABLE comparisons ADD COLUMN human_winner TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE comparisons ADD COLUMN human_feedback TEXT'); } catch(e) {}
try { db.exec("ALTER TABLE runs ADD COLUMN mode TEXT DEFAULT 'standard'"); } catch(e) {}

// Extension registry — populated after helpers are defined
let extensionRegistry = { provider: null, judge: null, mode: {}, results: [] };

// On startup: any rows still in 'generating' or 'judging' status are zombies from a crashed run.
// Mark them as errors so their run can be viewed and the counts resolve correctly.
db.prepare(`UPDATE generations SET status='error', error='Interrupted (server restart)', completed_at=? WHERE status='generating'`).run(Date.now());
db.prepare(`UPDATE comparisons SET status='error', error='Interrupted (server restart)', completed_at=? WHERE status='judging'`).run(Date.now());
// Any runs still 'running' at startup are also stuck — mark complete so results are viewable.
db.prepare(`UPDATE runs SET status='complete', completed_at=? WHERE status='running'`).run(Date.now());

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
  const fetch = await fetchPromise;
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
  const fetch = await fetchPromise;
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
  const fetch = await fetchPromise;
  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
  });
  const json = await res.json();
  modelsCache = (json.data || []).sort((a, b) => b.created - a.created);
  modelsCacheTime = Date.now();
  return modelsCache;
}

// ── SVG Helpers ─────────────────────────────────────────────────────────────
function extractSVG(text) {
  // 1. Strip <think>...</think> reasoning blocks
  text = text.replace(/<think[\s\S]*?<\/think>/gi, '');
  // 2. Try code fences: ```svg or ```xml
  const cb = text.match(/```(?:svg|xml)?\s*(<svg[\s\S]*?<\/svg>)/i);
  if (cb) return cb[1].trim();
  // 3. Raw SVG
  const raw = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (raw) return raw[0].trim();
  // 4. If text itself starts with <svg (might lack closing tag)
  if (text.trim().startsWith('<svg')) return text.trim();
  return null;
}

function svgToPngDataUrl(svgContent) {
  try {
    const resvg = new Resvg(svgContent, {
      fitTo: { mode: 'width', value: 400 },
      background: 'white',
    });
    const png = resvg.render().asPng();
    return 'data:image/png;base64,' + png.toString('base64');
  } catch(e) {
    // fallback: return SVG data url
    return 'data:image/svg+xml;base64,' + Buffer.from(svgContent).toString('base64');
  }
}

function svgToDataUrl(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

// ── ELO & Stats ─────────────────────────────────────────────────────────────
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

// ── Generation helper ────────────────────────────────────────────────────────
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per generation

async function generateOneSVG(runId, modelId, prompt, config, reasoningEffort, signal, extraMessages) {
  const genId = uuidv4();
  db.prepare(`INSERT INTO generations (id, run_id, model_id, prompt_id, prompt_text, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'generating', ?)`).run(genId, runId, modelId, prompt.id, prompt.text, Date.now());
  emit(runId, 'generation_start', { genId, modelId, promptId: prompt.id, promptText: prompt.text });

  // Combine run abort signal with a per-generation timeout
  const timeoutCtrl = new AbortController();
  const timeoutId = setTimeout(() => timeoutCtrl.abort(), GENERATION_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any
    ? AbortSignal.any([signal, timeoutCtrl.signal])
    : timeoutCtrl.signal; // fallback for older Node

  const t0 = Date.now();
  try {
    const messages = extraMessages || [
      { role: 'system', content: 'You are an expert SVG artist. Generate clean, well-structured SVG code. Respond with ONLY the SVG code — no explanation, no markdown fences, just the raw <svg>...</svg> element.' },
      { role: 'user', content: `Generate an SVG image depicting: ${prompt.text}\n\nRequirements:\n- Use viewBox="0 0 400 400"\n- Make it visually detailed and accurate\n- No scripts, no HTML, SVG only\n- Output ONLY the <svg> element` },
    ];

    const body = {
      model: modelId,
      messages,
      temperature: config.generation?.temperature ?? 0.7,
    };
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

    const result = extensionRegistry.provider
      ? await extensionRegistry.provider(modelId, messages, config)
      : await orStream('/chat/completions', body, () => {}, combinedSignal);
    clearTimeout(timeoutId);
    const svg = extractSVG(result.content) || result.content.trim();
    const elapsed = Date.now() - t0;

    db.prepare(`UPDATE generations SET svg_content=?, generation_time_ms=?, tokens_prompt=?, tokens_completion=?, status='complete', completed_at=? WHERE id=?`)
      .run(svg, elapsed, result.usage?.prompt_tokens || 0, result.usage?.completion_tokens || 0, Date.now(), genId);
    emit(runId, 'generation_complete', { genId, modelId, promptId: prompt.id, promptText: prompt.text, svgPreview: svg?.substring(0, 300), timeMs: elapsed });
    return genId;
  } catch (err) {
    clearTimeout(timeoutId);
    if (signal.aborted) return null;
    const errMsg = timeoutCtrl.signal.aborted ? `Timeout after ${GENERATION_TIMEOUT_MS/1000}s` : err.message;
    db.prepare(`UPDATE generations SET status='error', error=?, completed_at=? WHERE id=?`).run(errMsg, Date.now(), genId);
    emit(runId, 'generation_error', { genId, modelId, promptId: prompt.id, error: errMsg });
    return null;
  }
}

async function judgeOnePair(runId, genA, genB, judgeModel, judgeRun, signal, extraContext) {
  if (!genA.svg_content || !genB.svg_content) return null;
  const cmpId = uuidv4();
  db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
    generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`).run(
    cmpId, runId, genA.prompt_id, genA.prompt_text,
    genA.model_id, genB.model_id, genA.id, genB.id, judgeModel, judgeRun, Date.now());
  emit(runId, 'comparison_start', { cmpId, promptId: genA.prompt_id, promptText: genA.prompt_text, modelA: genA.model_id, modelB: genB.model_id });

  try {
    let parsed = {};
    if (extensionRegistry.judge) {
      parsed = await extensionRegistry.judge(genA, genB,
        { id: genA.prompt_id, text: genA.prompt_text }, { judge: { model: judgeModel } },
        { svgToPngDataUrl, orFetch, orStream });
    } else {
      const pngA = svgToPngDataUrl(genA.svg_content);
      const pngB = svgToPngDataUrl(genB.svg_content);

      const promptContext = extraContext || `You are evaluating two SVG images for the prompt: "${genA.prompt_text}"`;

      const result = await orFetch('/chat/completions', {
        model: judgeModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `${promptContext}\n\nModel A:` },
            { type: 'image_url', image_url: { url: pngA } },
            { type: 'text', text: 'Model B:' },
            { type: 'image_url', image_url: { url: pngB } },
            { type: 'text', text: `Which better follows the prompt and has better visual quality?\n\nRespond with ONLY this JSON (no markdown):\n{"thought_process":"brief analysis","winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"improvement suggestion"}` },
          ],
        }],
        temperature: 0.1,
      });

      const content = result.choices?.[0]?.message?.content || '';
      try {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
      } catch (_) {}
    }

    const winner = ['A', 'B', 'tie'].includes(parsed.winner) ? parsed.winner : null;
    db.prepare(`UPDATE comparisons SET winner=?, model_a_score=?, model_b_score=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`)
      .run(winner, parsed.model_a_score ?? null, parsed.model_b_score ?? null, parsed.thought_process || null, parsed.feedback || null, Date.now(), cmpId);
    emit(runId, 'comparison_complete', { cmpId, promptId: genA.prompt_id, promptText: genA.prompt_text, modelA: genA.model_id, modelB: genB.model_id, winner, scoreA: parsed.model_a_score, scoreB: parsed.model_b_score, thoughtProcess: parsed.thought_process, feedback: parsed.feedback });
    return { cmpId, winner, feedback: parsed.feedback, thoughtProcess: parsed.thought_process };
  } catch (err) {
    if (signal?.aborted) return null;
    db.prepare(`UPDATE comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), cmpId);
    emit(runId, 'comparison_error', { cmpId, promptId: genA.prompt_id, modelA: genA.model_id, modelB: genB.model_id, error: err.message });
    return null;
  }
}

// ── Shared: generate all + judge pairs as they become available ───────────────
// Judging starts as soon as any 2 models finish a prompt — no waiting for all N×M
async function runParallelGenAndJudge(runId, config, abortCtrl, genList) {
  const { judge } = config;
  const judgeModel = judge?.model || 'google/gemini-3-flash-preview';
  const judgeRuns = judge?.runs || 1;

  // completedByPrompt[promptId] = array of complete generation rows
  const completedByPrompt = {};
  // track which pairs have been launched: sorted(genAId,genBId) joined
  const launchedPairs = new Set();
  const cmpPromises = [];

  function launchNewPairs(promptId) {
    const done = completedByPrompt[promptId];
    if (!done || done.length < 2) return;
    for (let i = 0; i < done.length; i++) {
      for (let j = i + 1; j < done.length; j++) {
        const key = [done[i].id, done[j].id].sort().join('|||');
        if (launchedPairs.has(key)) continue;
        launchedPairs.add(key);
        const [ga, gb] = Math.random() < 0.5 ? [done[i], done[j]] : [done[j], done[i]];
        for (let r = 1; r <= judgeRuns; r++) {
          cmpPromises.push(judgeOnePair(runId, ga, gb, judgeModel, r, abortCtrl.signal));
        }
      }
    }
  }

  // Wrap each generation so we can trigger judging the moment it lands
  const genPromises = genList.map(({ modelId, prompt, reasoningEffort, extraMessages }) =>
    generateOneSVG(runId, modelId, prompt, config, reasoningEffort || null, abortCtrl.signal, extraMessages)
      .then(genId => {
        if (!genId || abortCtrl.signal.aborted) return;
        const gen = db.prepare(`SELECT * FROM generations WHERE id=?`).get(genId);
        if (!gen || gen.status !== 'complete') return;
        if (!completedByPrompt[prompt.id]) completedByPrompt[prompt.id] = [];
        completedByPrompt[prompt.id].push(gen);
        launchNewPairs(prompt.id);
      })
  );

  await Promise.allSettled(genPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  // Wait for any judge calls already launched (including late-starters from slow gens)
  await Promise.allSettled(cmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

// ── Standard mode ────────────────────────────────────────────────────────────
async function runStandard(runId, config, abortCtrl) {
  const { models, prompts } = config;
  const genList = [];
  for (const model of models) {
    for (const prompt of prompts) {
      genList.push({ modelId: model.id || model, prompt, reasoningEffort: model.reasoning_effort });
    }
  }
  return runParallelGenAndJudge(runId, config, abortCtrl, genList);
}

// ── Feedback Iteration mode ──────────────────────────────────────────────────
async function runFeedbackIteration(runId, config, abortCtrl) {
  const { models, prompts, judge } = config;
  const iterModels = config.iteration_models || models;

  // Phase 1 & 2: Standard run
  const phase12Result = await runStandard(runId, config, abortCtrl);
  if (phase12Result === 'stopped') return 'stopped';

  emit(runId, 'phase_start', { phase: 3, label: 'Generating iterations based on feedback' });

  // Phase 3: For each prompt, find winning generation and use feedback to iterate
  const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? AND status='complete'`).all(runId);
  const cmps = db.prepare(`SELECT * FROM comparisons WHERE run_id=? AND status='complete'`).all(runId);

  // Per prompt: find most wins
  const byPrompt = {};
  for (const g of gens) {
    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = { gens: [], wins: {} };
    byPrompt[g.prompt_id].gens.push(g);
  }
  for (const c of cmps) {
    if (!c.winner || !byPrompt[c.prompt_id]) continue;
    const winnerId = c.winner === 'A' ? c.generation_a_id : c.winner === 'B' ? c.generation_b_id : null;
    if (winnerId) {
      if (!byPrompt[c.prompt_id].wins[winnerId]) byPrompt[c.prompt_id].wins[winnerId] = 0;
      byPrompt[c.prompt_id].wins[winnerId]++;
    }
  }

  const iterPromises = [];
  for (const [promptId, data] of Object.entries(byPrompt)) {
    const { gens: promptGens, wins } = data;
    // Find best generation (most wins)
    let bestGen = promptGens[0];
    let bestWins = wins[bestGen?.id] || 0;
    for (const g of promptGens) {
      const w = wins[g.id] || 0;
      if (w > bestWins) { bestWins = w; bestGen = g; }
    }
    if (!bestGen) continue;

    // Find best feedback for this generation
    const bestCmp = cmps.find(c =>
      c.prompt_id === promptId &&
      (c.generation_a_id === bestGen.id || c.generation_b_id === bestGen.id) &&
      c.feedback
    );
    const feedback = bestCmp?.feedback || 'Improve visual quality, accuracy, and detail.';

    // Generate improved versions with each iteration model
    for (const iterModelObj of iterModels) {
      const iterModelId = iterModelObj.id || iterModelObj;
      iterPromises.push((async () => {
        const iterId = uuidv4();
        db.prepare(`INSERT INTO iterations (id, run_id, parent_generation_id, model_id, prompt_id, prompt_text, feedback_used, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?)`).run(iterId, runId, bestGen.id, iterModelId, promptId, bestGen.prompt_text, feedback, Date.now());
        emit(runId, 'iteration_start', { iterId, modelId: iterModelId, promptId, feedback });

        try {
          const messages = [
            { role: 'system', content: 'You are an expert SVG artist. Improve the given SVG based on the feedback provided. Respond with ONLY the improved SVG code.' },
            { role: 'user', content: [
              { type: 'text', text: `Original SVG prompt: ${bestGen.prompt_text}\n\nFeedback for improvement: ${feedback}\n\nOriginal SVG:\n${bestGen.svg_content}\n\nPlease create an improved version of this SVG based on the feedback. Output ONLY the <svg> element.` }
            ]},
          ];
          const body = { model: iterModelId, messages, temperature: 0.7 };
          const result = await orStream('/chat/completions', body, () => {}, abortCtrl.signal);
          const svg = extractSVG(result.content) || result.content.trim();
          db.prepare(`UPDATE iterations SET svg_content=?, status='complete', completed_at=? WHERE id=?`).run(svg, Date.now(), iterId);
          emit(runId, 'iteration_complete', { iterId, modelId: iterModelId, promptId });
        } catch(err) {
          db.prepare(`UPDATE iterations SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), iterId);
          emit(runId, 'iteration_error', { iterId, modelId: iterModelId, error: err.message });
        }
      })());
    }
  }
  await Promise.allSettled(iterPromises);
  if (abortCtrl.signal.aborted) return 'stopped';

  // Phase 4: Judge iteration pairs
  emit(runId, 'phase_start', { phase: 4, label: 'Judging iterations' });
  const iters = db.prepare(`SELECT * FROM iterations WHERE run_id=? AND status='complete'`).all(runId);
  const itersByPrompt = {};
  for (const it of iters) {
    if (!itersByPrompt[it.prompt_id]) itersByPrompt[it.prompt_id] = [];
    itersByPrompt[it.prompt_id].push(it);
  }

  const iterCmpPromises = [];
  for (const [promptId, promptIters] of Object.entries(itersByPrompt)) {
    // Find original gen for this prompt
    const origGen = db.prepare(`SELECT * FROM generations WHERE run_id=? AND prompt_id=? AND status='complete' LIMIT 1`).get(runId, promptId);
    if (!origGen || !origGen.svg_content) continue;

    for (let i = 0; i < promptIters.length; i++) {
      for (let j = i + 1; j < promptIters.length; j++) {
        const itA = promptIters[i], itB = promptIters[j];
        iterCmpPromises.push((async () => {
          if (!itA.svg_content || !itB.svg_content) return;
          const icmpId = uuidv4();
          db.prepare(`INSERT INTO iteration_comparisons (id, run_id, prompt_id, prompt_text, original_generation_id, iter_a_id, iter_b_id, judge_model, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`).run(
            icmpId, runId, promptId, origGen.prompt_text, origGen.id, itA.id, itB.id, judge?.model || 'google/gemini-3-flash-preview', Date.now());

          try {
            const origPng = svgToPngDataUrl(origGen.svg_content);
            const pngA = svgToPngDataUrl(itA.svg_content);
            const pngB = svgToPngDataUrl(itB.svg_content);

            const result = await orFetch('/chat/completions', {
              model: judge?.model || 'google/gemini-3-flash-preview',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: `You are evaluating improved SVG versions for prompt: "${origGen.prompt_text}"\n\nOriginal feedback: ${itA.feedback_used || 'N/A'}\n\nOriginal SVG:` },
                  { type: 'image_url', image_url: { url: origPng } },
                  { type: 'text', text: 'Improved version A:' },
                  { type: 'image_url', image_url: { url: pngA } },
                  { type: 'text', text: 'Improved version B:' },
                  { type: 'image_url', image_url: { url: pngB } },
                  { type: 'text', text: 'Which improved version is better? Note: if BOTH improved versions are WORSE than the original, set both_bad to 1.\n\nRespond with ONLY this JSON:\n{"thought_process":"analysis","winner":"A" or "B","model_a_score":0-10,"model_b_score":0-10,"both_bad":0 or 1,"feedback":"notes"}' },
                ],
              }],
              temperature: 0.1,
            });

            const content = result.choices?.[0]?.message?.content || '';
            let parsed = {};
            try { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch(_) {}
            const winner = ['A','B'].includes(parsed.winner) ? parsed.winner : 'A';
            const bothBad = parsed.both_bad ? 1 : 0;
            db.prepare(`UPDATE iteration_comparisons SET winner=?, model_a_score=?, model_b_score=?, both_bad=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`)
              .run(winner, parsed.model_a_score ?? null, parsed.model_b_score ?? null, bothBad, parsed.thought_process || null, parsed.feedback || null, Date.now(), icmpId);
            emit(runId, 'iter_comparison_complete', { icmpId, promptId, modelA: itA.model_id, modelB: itB.model_id, winner, bothBad });
          } catch(err) {
            db.prepare(`UPDATE iteration_comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), icmpId);
          }
        })());
      }
    }
  }
  await Promise.allSettled(iterCmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

// ── Image to SVG mode ────────────────────────────────────────────────────────
async function runImageToSVG(runId, config, abortCtrl) {
  const { models, prompts, judge } = config;

  // Phase 1: Generate SVGs from reference images (with rolling judging)
  const genList = [];
  for (const model of models) {
    for (const prompt of prompts) {
      genList.push({
        modelId: model.id || model,
        prompt,
        reasoningEffort: model.reasoning_effort,
        extraMessages: [
          { role: 'system', content: 'You are an expert SVG artist. Reproduce the given reference image as an SVG. Respond with ONLY the SVG code.' },
          { role: 'user', content: [
            { type: 'text', text: `Reproduce this image as SVG as accurately as possible. Use viewBox="0 0 400 400". Output ONLY the <svg> element.${prompt.text ? '\n\nAdditional context: ' + prompt.text : ''}` },
            ...(prompt.reference_image ? [{ type: 'image_url', image_url: { url: prompt.reference_image } }] : []),
          ]},
        ],
      });
    }
  }
  // Start standard judging rolling alongside generations
  const genResult = await runParallelGenAndJudge(runId, config, abortCtrl, genList);
  if (genResult !== 'complete') return genResult;
  // Also run image-specific judge pass with reference image context
  if (abortCtrl.signal.aborted) return 'stopped';

  // Phase 2: Judge pairs with reference image context
  const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? AND status='complete'`).all(runId);
  const byPrompt = {};
  for (const g of gens) {
    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = [];
    byPrompt[g.prompt_id].push(g);
  }

  const cmpPromises = [];
  for (const [promptId, pg] of Object.entries(byPrompt)) {
    const promptObj = prompts.find(p => p.id === promptId);
    const refImage = promptObj?.reference_image;
    for (let i = 0; i < pg.length; i++) {
      for (let j = i + 1; j < pg.length; j++) {
        const [ga, gb] = Math.random() < 0.5 ? [pg[i], pg[j]] : [pg[j], pg[i]];
        const judgeRuns = judge?.runs || 1;
        for (let r = 1; r <= judgeRuns; r++) {
          cmpPromises.push((async () => {
            if (!ga.svg_content || !gb.svg_content) return;
            const cmpId = uuidv4();
            db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
              generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`).run(
              cmpId, runId, ga.prompt_id, ga.prompt_text,
              ga.model_id, gb.model_id, ga.id, gb.id, judge?.model || 'google/gemini-3-flash-preview', r, Date.now());

            try {
              const pngA = svgToPngDataUrl(ga.svg_content);
              const pngB = svgToPngDataUrl(gb.svg_content);
              const contentParts = [];
              if (refImage) {
                contentParts.push({ type: 'text', text: `You are judging which SVG reproduction is more accurate to the target image. Target image:` });
                contentParts.push({ type: 'image_url', image_url: { url: refImage } });
              } else {
                contentParts.push({ type: 'text', text: `You are evaluating SVG reproductions for prompt: "${ga.prompt_text}"` });
              }
              contentParts.push({ type: 'text', text: '\nReproduction A:' });
              contentParts.push({ type: 'image_url', image_url: { url: pngA } });
              contentParts.push({ type: 'text', text: 'Reproduction B:' });
              contentParts.push({ type: 'image_url', image_url: { url: pngB } });
              contentParts.push({ type: 'text', text: 'Which reproduction is more accurate to the target?\n\nRespond with ONLY this JSON:\n{"thought_process":"analysis","winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"notes"}' });

              const result = await orFetch('/chat/completions', {
                model: judge?.model || 'google/gemini-3-flash-preview',
                messages: [{ role: 'user', content: contentParts }],
                temperature: 0.1,
              });
              const content = result.choices?.[0]?.message?.content || '';
              let parsed = {};
              try { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch(_) {}
              const winner = ['A','B','tie'].includes(parsed.winner) ? parsed.winner : null;
              db.prepare(`UPDATE comparisons SET winner=?, model_a_score=?, model_b_score=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`)
                .run(winner, parsed.model_a_score ?? null, parsed.model_b_score ?? null, parsed.thought_process || null, parsed.feedback || null, Date.now(), cmpId);
              emit(runId, 'comparison_complete', { cmpId, promptId: ga.prompt_id, modelA: ga.model_id, modelB: gb.model_id, winner });
            } catch(err) {
              db.prepare(`UPDATE comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(err.message, Date.now(), cmpId);
            }
          })());
        }
      }
    }
  }
  await Promise.allSettled(cmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

// ── SVG Editing mode ─────────────────────────────────────────────────────────
async function runSVGEditing(runId, config, abortCtrl) {
  const { models, prompts, judge } = config;

  const genList = [];
  for (const model of models) {
    for (const prompt of prompts) {
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
  return runParallelGenAndJudge(runId, config, abortCtrl, genList);
}

async function runStandardJudging(runId, config, abortCtrl) {
  // For modes where generations already exist — just judge them (already-complete gens)
  const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? AND status='complete'`).all(runId);
  const { judge } = config;
  const judgeModel = judge?.model || 'google/gemini-3-flash-preview';
  const judgeRuns = judge?.runs || 1;
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
        for (let r = 1; r <= judgeRuns; r++) {
          cmpPromises.push(judgeOnePair(runId, ga, gb, judgeModel, r, abortCtrl.signal));
        }
      }
    }
  }
  await Promise.allSettled(cmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

// ── Human Evaluation mode ────────────────────────────────────────────────────
async function runHumanEval(runId, config, abortCtrl) {
  const { models, prompts, judge } = config;
  const runLLMJudge = config.human_eval_llm_judge !== false;

  // Phase 1: Generate SVGs (with rolling LLM judge if enabled)
  const genList = models.flatMap(model =>
    prompts.map(prompt => ({ modelId: model.id || model, prompt, reasoningEffort: model.reasoning_effort }))
  );
  if (runLLMJudge) {
    await runParallelGenAndJudge(runId, config, abortCtrl, genList);
  } else {
    await Promise.allSettled(genList.map(({ modelId, prompt, reasoningEffort }) =>
      generateOneSVG(runId, modelId, prompt, config, reasoningEffort || null, abortCtrl.signal)
    ));
  }
  if (abortCtrl.signal.aborted) return 'stopped';

  // Phase 2: Create comparison records (pending human review)
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
        // Insert pending comparison for human
        const cmpId = uuidv4();
        db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
          generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_human', ?)`).run(
          cmpId, runId, ga.prompt_id, ga.prompt_text,
          ga.model_id, gb.model_id, ga.id, gb.id, 'human', 1, Date.now());
        emit(runId, 'comparison_pending_human', { cmpId, promptId: ga.prompt_id, modelA: ga.model_id, modelB: gb.model_id });

        if (runLLMJudge) {
          cmpPromises.push(judgeOnePair(runId, ga, gb, judge?.model || 'google/gemini-3-flash-preview', 2, abortCtrl.signal));
        }
      }
    }
  }
  await Promise.allSettled(cmpPromises);
  if (abortCtrl.signal.aborted) return 'stopped';
  return 'complete';
}

// ── Main benchmark runner ────────────────────────────────────────────────────
async function runBenchmark(runId) {
  const runRow = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  if (!runRow) return;
  const config = JSON.parse(runRow.config);
  const mode = runRow.mode || config.mode || 'standard';

  const abortCtrl = new AbortController();
  runAbortControllers[runId] = abortCtrl;
  db.prepare(`UPDATE runs SET status='running', started_at=? WHERE id=?`).run(Date.now(), runId);
  emit(runId, 'run_start', { runId, mode, modelIds: config.models.map(m => m.id || m), promptCount: config.prompts.length });

  try {
    let result;
    if (extensionRegistry.mode[mode]) {
      result = await extensionRegistry.mode[mode](runId, config, { ...extensionHelpers, abortCtrl });
    } else {
      switch (mode) {
        case 'feedback_iteration': result = await runFeedbackIteration(runId, config, abortCtrl); break;
        case 'image_to_svg': result = await runImageToSVG(runId, config, abortCtrl); break;
        case 'svg_editing': result = await runSVGEditing(runId, config, abortCtrl); break;
        case 'human_eval': result = await runHumanEval(runId, config, abortCtrl); break;
        default: result = await runStandard(runId, config, abortCtrl); break;
      }
    }

    if (result === 'stopped') {
      db.prepare(`UPDATE runs SET status='stopped', completed_at=? WHERE id=?`).run(Date.now(), runId);
      emit(runId, 'run_stopped', { runId });
    } else {
      db.prepare(`UPDATE runs SET status='complete', completed_at=? WHERE id=?`).run(Date.now(), runId);
      emit(runId, 'run_complete', { runId });
    }
  } catch (err) {
    console.error('[runBenchmark]', err.message);
    db.prepare(`UPDATE runs SET status='error', completed_at=?, error=? WHERE id=?`).run(Date.now(), err.message, runId);
    emit(runId, 'run_error', { runId, error: err.message });
  } finally {
    delete runAbortControllers[runId];
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

// Landing page data: global stats + latest complete run leaderboard + sample SVGs
app.get('/api/landing', (req, res) => {
  try {
    const totalRuns = db.prepare(`SELECT count(*) as n FROM runs WHERE status='complete'`).get().n;
    const totalGens = db.prepare(`SELECT count(*) as n FROM generations WHERE status='complete'`).get().n;
    const totalCmps = db.prepare(`SELECT count(*) as n FROM comparisons WHERE status='complete'`).get().n;
    const totalModels = db.prepare(`SELECT count(DISTINCT model_id) as n FROM generations WHERE status='complete'`).get().n;

    // Latest complete run
    const latestRun = db.prepare(`SELECT * FROM runs WHERE status='complete' ORDER BY completed_at DESC LIMIT 1`).get();
    let leaderboard = [], sampleSVGs = [];
    if (latestRun) {
      const gens = db.prepare(`SELECT * FROM generations WHERE run_id=? AND status='complete'`).all(latestRun.id);
      const cmps = db.prepare(`SELECT * FROM comparisons WHERE run_id=? AND status='complete'`).all(latestRun.id);
      const elo = calcELO(cmps, [...new Set(gens.map(g => g.model_id))]);
      leaderboard = Object.entries(elo).map(([model, rating]) => ({ model, rating: Math.round(rating) }))
        .sort((a, b) => b.rating - a.rating);

      // Sample SVGs: one per model (highest-scoring generation)
      const byModel = {};
      for (const g of gens) {
        if (!byModel[g.model_id]) byModel[g.model_id] = g;
      }
      sampleSVGs = Object.values(byModel).slice(0, 8).map(g => ({
        id: g.id, model_id: g.model_id, prompt_text: g.prompt_text
      }));
    }

    res.json({ totalRuns, totalGens, totalCmps, totalModels, latestRun: latestRun ? { id: latestRun.id, name: latestRun.name } : null, leaderboard, sampleSVGs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/runs', (req, res) => {
  const runs = db.prepare(`SELECT id, name, status, mode, created_at, started_at, completed_at FROM runs ORDER BY created_at DESC`).all();
  res.json(runs.map(r => ({
    ...r,
    genTotal: db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=?`).get(r.id).n,
    genDone: db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=? AND status='complete'`).get(r.id).n,
    cmpTotal: db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=?`).get(r.id).n,
    cmpDone: db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=? AND status='complete'`).get(r.id).n,
  })));
});

app.post('/api/runs', (req, res) => {
  const { name, config, mode } = req.body;
  if (!name || !config) return res.status(400).json({ error: 'name and config required' });
  const id = uuidv4();
  const runMode = mode || config.mode || 'standard';
  db.prepare(`INSERT INTO runs (id, name, config, mode, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`).run(id, name, JSON.stringify(config), runMode, Date.now());
  res.json({ id, name, mode: runMode, status: 'draft' });
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
  const { name, config, mode } = req.body;
  if (name) db.prepare(`UPDATE runs SET name=? WHERE id=?`).run(name, req.params.id);
  if (config) db.prepare(`UPDATE runs SET config=? WHERE id=?`).run(JSON.stringify(config), req.params.id);
  if (mode) db.prepare(`UPDATE runs SET mode=? WHERE id=?`).run(mode, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/runs/:id', (req, res) => {
  db.prepare(`DELETE FROM judge_eval_tasks WHERE run_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM iteration_comparisons WHERE run_id=?`).run(req.params.id);
  db.prepare(`DELETE FROM iterations WHERE run_id=?`).run(req.params.id);
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
    db.prepare(`DELETE FROM judge_eval_tasks WHERE run_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM iteration_comparisons WHERE run_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM iterations WHERE run_id=?`).run(req.params.id);
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
  const iters = db.prepare(`SELECT * FROM iterations WHERE run_id=? ORDER BY created_at`).all(req.params.id);
  const iterCmps = db.prepare(`SELECT * FROM iteration_comparisons WHERE run_id=? ORDER BY created_at`).all(req.params.id);
  const elo = calcELO(cmps, modelIds);
  const stats = calcStats(cmps, modelIds);
  const heatmap = calcHeatmap(cmps, modelIds);
  const leaderboard = modelIds.map(m => ({
    model: m, elo: Math.round(elo[m] || 1000), ...stats[m],
    avgScore: stats[m]?.score_count > 0 ? +(stats[m].score_sum / stats[m].score_count).toFixed(2) : null,
  })).sort((a, b) => b.elo - a.elo);

  // Iteration ELO (for feedback mode)
  let iterLeaderboard = null;
  const iterModelIds = config.iteration_models ? config.iteration_models.map(m => m.id || m) : modelIds;
  if (iters.length > 0) {
    const iterElo = calcELO(
      iterCmps.map(c => ({ ...c, model_a_id: iters.find(i=>i.id===c.iter_a_id)?.model_id, model_b_id: iters.find(i=>i.id===c.iter_b_id)?.model_id, status: c.status, winner: c.winner, completed_at: c.completed_at })).filter(c => c.model_a_id && c.model_b_id),
      iterModelIds
    );
    iterLeaderboard = iterModelIds.map(m => ({
      model: m, elo: Math.round(iterElo[m] || 1000),
      bothBadCount: iterCmps.filter(c => {
        const iterA = iters.find(i=>i.id===c.iter_a_id);
        const iterB = iters.find(i=>i.id===c.iter_b_id);
        return (iterA?.model_id===m || iterB?.model_id===m) && c.both_bad;
      }).length,
    })).sort((a,b) => b.elo - a.elo);
  }

  const extensionScores = {};
  for (const { fn, name } of extensionRegistry.results) {
    try { extensionScores[name] = fn(cmps, modelIds, { elo, stats }); } catch(e) {}
  }

  res.json({ run: { ...run, config }, leaderboard, heatmap, models: modelIds, generations: gens, comparisons: cmps, iterations: iters, iterationComparisons: iterCmps, iterLeaderboard, extensionScores });
});

// Human eval routes
app.get('/api/runs/:id/pending-human', (req, res) => {
  const cmps = db.prepare(`SELECT c.*, ga.svg_content as svg_a, gb.svg_content as svg_b
    FROM comparisons c
    LEFT JOIN generations ga ON ga.id = c.generation_a_id
    LEFT JOIN generations gb ON gb.id = c.generation_b_id
    WHERE c.run_id=? AND c.status='pending_human'
    ORDER BY c.created_at`).all(req.params.id);
  res.json(cmps);
});

app.post('/api/runs/:id/human-judge', (req, res) => {
  const { cmp_id, winner, score_a, score_b, feedback } = req.body;
  if (!cmp_id || !winner) return res.status(400).json({ error: 'cmp_id and winner required' });
  const validWinner = ['A','B','tie'].includes(winner) ? winner : null;
  db.prepare(`UPDATE comparisons SET human_winner=?, model_a_score=?, model_b_score=?, human_feedback=?, status='complete', winner=COALESCE(winner, ?), completed_at=? WHERE id=? AND run_id=?`)
    .run(validWinner, score_a ?? null, score_b ?? null, feedback || null, validWinner, Date.now(), cmp_id, req.params.id);
  emit(req.params.id, 'human_judgment', { cmpId: cmp_id, winner: validWinner });
  res.json({ ok: true });
});

app.get('/api/runs/:id/judge-agreement', (req, res) => {
  const cmps = db.prepare(`SELECT * FROM comparisons WHERE run_id=? AND human_winner IS NOT NULL AND winner IS NOT NULL AND status='complete'`).all(req.params.id);
  const total = cmps.length;
  const agree = cmps.filter(c => c.human_winner === c.winner).length;
  res.json({ total, agree, disagree: total - agree, agreementRate: total > 0 ? (agree/total*100).toFixed(1) : null });
});

app.post('/api/runs/:id/continue', async (req, res) => {
  const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
  // For human eval: judge remaining pending_human comparisons with LLM
  const config = JSON.parse(run.config);
  const pending = db.prepare(`SELECT c.*, ga.*, ga.svg_content as svg_content_a, gb.svg_content as svg_content_b
    FROM comparisons c
    LEFT JOIN generations ga ON ga.id = c.generation_a_id
    LEFT JOIN generations gb ON gb.id = c.generation_b_id
    WHERE c.run_id=? AND c.status='pending_human'`).all(req.params.id);
  const abortCtrl = new AbortController();
  for (const c of pending) {
    const genA = { id: c.generation_a_id, model_id: c.model_a_id, prompt_id: c.prompt_id, prompt_text: c.prompt_text, svg_content: c.svg_content_a };
    const genB = { id: c.generation_b_id, model_id: c.model_b_id, prompt_id: c.prompt_id, prompt_text: c.prompt_text, svg_content: c.svg_content_b };
    // Mark as judging first
    db.prepare(`UPDATE comparisons SET status='judging' WHERE id=?`).run(c.id);
    await judgeOnePair(req.params.id, genA, genB, config.judge?.model || 'google/gemini-3-flash-preview', 1, abortCtrl.signal).catch(console.error);
  }
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
  const iters = db.prepare(`SELECT * FROM iterations WHERE run_id=?`).all(req.params.id);
  const iterCmps = db.prepare(`SELECT * FROM iteration_comparisons WHERE run_id=?`).all(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="pathscore-${run.id.slice(0,8)}.json"`);
  res.json({ run: { ...run, config: JSON.parse(run.config) }, generations: gens, comparisons: cmps, iterations: iters, iterationComparisons: iterCmps, exported_at: Date.now() });
});

app.post('/api/runs/import', (req, res) => {
  const { run, generations, comparisons, iterations, iterationComparisons } = req.body;
  if (!run || !generations) return res.status(400).json({ error: 'invalid import data' });
  const existing = db.prepare(`SELECT id FROM runs WHERE id=?`).get(run.id);
  const runId = existing ? uuidv4() : run.id;
  try {
    db.prepare(`INSERT INTO runs (id, name, config, mode, status, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, run.name + (existing ? ' (imported)' : ''),
      typeof run.config === 'string' ? run.config : JSON.stringify(run.config),
      run.mode || 'standard',
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


// ── Extension System ─────────────────────────────────────────────────────────

const extensionHelpers = {
  generateOneSVG, judgeOnePair, runParallelGenAndJudge,
  emit, db, uuidv4, svgToPngDataUrl, orFetch, orStream, extractSVG,
};

function rebuildExtensionRegistry() {
  const exts = db.prepare('SELECT * FROM extensions WHERE enabled=1').all();
  extensionRegistry = { provider: null, judge: null, mode: {}, results: [] };
  for (const ext of exts) {
    try {
      const hookFn = (new Function('helpers', ext.fn_body))(extensionHelpers);
      if (ext.hook_type === 'provider') extensionRegistry.provider = hookFn;
      else if (ext.hook_type === 'judge') extensionRegistry.judge = hookFn;
      else if (ext.hook_type === 'mode' && ext.mode_id) extensionRegistry.mode[ext.mode_id] = hookFn;
      else if (ext.hook_type === 'results') extensionRegistry.results.push({ fn: hookFn, name: ext.name });
    } catch(e) { console.warn('[ext] ' + ext.name + ': ' + e.message); }
  }
}

const JUDGE_EVAL_FN_BODY = `return async function(runId, config, helpers) {
  var db=helpers.db, uuidv4=helpers.uuidv4, emit=helpers.emit;
  var orFetch=helpers.orFetch, svgToPng=helpers.svgToPngDataUrl;
  var generateOneSVG=helpers.generateOneSVG;
  var judges=config.judges||['google/gemini-2.5-flash','openai/gpt-4o-mini'];
  emit(runId,'phase_start',{phase:1,label:'Generating SVGs from base models'});
  var genList=(config.models||[]).reduce(function(acc,m){
    (config.prompts||[]).forEach(function(p){ acc.push({modelId:m.id||m,prompt:p,reasoningEffort:m.reasoning_effort||null}); });
    return acc;
  },[]);
  await Promise.allSettled(genList.map(function(g){
    return generateOneSVG(runId,g.modelId,g.prompt,config,g.reasoningEffort,helpers.abortCtrl.signal);
  }));
  if(helpers.abortCtrl.signal.aborted) return 'stopped';
  emit(runId,'phase_start',{phase:2,label:'Collecting judge verdicts (all judges on every pair)'});
  var gens=db.prepare("SELECT * FROM generations WHERE run_id=? AND status='complete'").all(runId);
  var byPrompt={};
  for(var g of gens){ if(!byPrompt[g.prompt_id]) byPrompt[g.prompt_id]=[]; byPrompt[g.prompt_id].push(g); }
  var taskPromises=[];
  for(var pg of Object.values(byPrompt)){
    for(var i=0;i<pg.length;i++){
      for(var j=i+1;j<pg.length;j++){
        (function(ga0,gb0){
          var pair=Math.random()<0.5?[ga0,gb0]:[gb0,ga0];
          var ga=pair[0],gb=pair[1];
          if(!ga.svg_content||!gb.svg_content) return;
          taskPromises.push((async function(ga,gb){
            var pngA=svgToPng(ga.svg_content),pngB=svgToPng(gb.svg_content);
            var verdicts=[];
            await Promise.all(judges.map(async function(jm){
              try{
                var r=await orFetch('/chat/completions',{model:jm,messages:[{role:'user',content:[
                  {type:'text',text:'Evaluate two SVGs for prompt: "'+ga.prompt_text+'". SVG A:'},
                  {type:'image_url',image_url:{url:pngA}},
                  {type:'text',text:'SVG B:'},
                  {type:'image_url',image_url:{url:pngB}},
                  {type:'text',text:'Which better follows the prompt and has better visual quality? Respond ONLY with JSON (no markdown): {"winner":"A" or "B" or "tie","model_a_score":0-10,"model_b_score":0-10,"feedback":"one sentence"}'}
                ]}],temperature:0.1});
                var c=(r.choices&&r.choices[0]&&r.choices[0].message&&r.choices[0].message.content)||'';
                var m=c.match(/\\{[\\s\\S]*\\}/); var p={};
                try{if(m)p=JSON.parse(m[0]);}catch(_){}
                var w=['A','B','tie'].indexOf(p.winner)>=0?p.winner:null;
                verdicts.push({judge_model:jm,winner:w,score_a:p.model_a_score!=null?p.model_a_score:null,score_b:p.model_b_score!=null?p.model_b_score:null,feedback:p.feedback||''});
              }catch(e){verdicts.push({judge_model:jm,winner:null,error:e.message});}
            }));
            var valid=verdicts.filter(function(v){return v.winner;});
            if(!valid.length) return;
            db.prepare("INSERT INTO judge_eval_tasks (id,run_id,gen_a_id,gen_b_id,prompt_id,prompt_text,verdicts,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
              uuidv4(),runId,ga.id,gb.id,ga.prompt_id,ga.prompt_text,JSON.stringify(verdicts),'pending',Date.now());
            emit(runId,'judge_eval_task_ready',{promptId:ga.prompt_id,judgeCount:valid.length});
          })(ga,gb));
        })(pg[i],pg[j]);
      }
    }
  }
  await Promise.allSettled(taskPromises);
  return helpers.abortCtrl.signal.aborted?'stopped':'complete';
};`;

const BUILTIN_EXTENSIONS = [
  {
    id: 'builtin-multi-judge-consensus',
    name: 'Multi-judge Consensus',
    description: 'Runs 3 vision models and takes majority vote. More reliable but slower.',
    hook_type: 'judge',
    mode_id: null, mode_label: null, mode_icon: null, mode_desc: null,
    fn_body: "return async function(genA, genB, prompt, config, helpers) {\n  const judges = config.extension_consensus_judges || ['google/gemini-flash-1.5-8b','openai/gpt-4o-mini','anthropic/claude-haiku-3'];\n  const votes = { A: 0, B: 0, tie: 0 };\n  const results = [];\n  for (const judgeModel of judges) {\n    try {\n      const pngA = helpers.svgToPngDataUrl(genA.svg_content);\n      const pngB = helpers.svgToPngDataUrl(genB.svg_content);\n      const result = await helpers.orFetch('/chat/completions', {\n        model: judgeModel,\n        messages: [{ role: 'user', content: [\n          { type: 'text', text: 'Evaluate two SVGs for prompt: \"' + prompt.text + '\"\\nModel A:' },\n          { type: 'image_url', image_url: { url: pngA } },\n          { type: 'text', text: 'Model B:' },\n          { type: 'image_url', image_url: { url: pngB } },\n          { type: 'text', text: 'Which is better? Respond ONLY with JSON: {\"winner\":\"A\" or \"B\" or \"tie\",\"model_a_score\":0-10,\"model_b_score\":0-10}' }\n        ]}],\n        temperature: 0.1,\n      });\n      const content = result.choices?.[0]?.message?.content || '';\n      const m = content.match(/\\{[\\s\\S]*\\}/);\n      if (m) {\n        const p = JSON.parse(m[0]);\n        if (['A','B','tie'].includes(p.winner)) {\n          votes[p.winner]++;\n          results.push({ judge: judgeModel, winner: p.winner, scoreA: p.model_a_score, scoreB: p.model_b_score });\n        }\n      }\n    } catch(e) {}\n  }\n  const winner = votes.A > votes.B && votes.A >= votes.tie ? 'A' : votes.B > votes.A && votes.B >= votes.tie ? 'B' : 'tie';\n  const avgA = results.reduce((s,r) => s + (r.scoreA||5), 0) / Math.max(results.length, 1);\n  const avgB = results.reduce((s,r) => s + (r.scoreB||5), 0) / Math.max(results.length, 1);\n  return {\n    winner,\n    model_a_score: +avgA.toFixed(1),\n    model_b_score: +avgB.toFixed(1),\n    thought_process: 'Votes: A=' + votes.A + ' B=' + votes.B + ' tie=' + votes.tie + ' | ' + results.map(r => r.judge.split('/').pop() + '->' + r.winner).join(', '),\n    feedback: 'Multi-judge consensus (' + results.length + ' judges)'\n  };\n};",
  },
  {
    id: 'builtin-scoring-rubric',
    name: 'Scoring Rubric Judge',
    description: 'Weighted criteria: Prompt Accuracy 40%, Visual Quality 30%, Technical Correctness 20%, Aesthetics 10%.',
    hook_type: 'judge',
    mode_id: null, mode_label: null, mode_icon: null, mode_desc: null,
    fn_body: "return async function(genA, genB, prompt, config, helpers) {\n  const criteria = config.extension_rubric_criteria || [\n    { name: 'Prompt Accuracy', weight: 0.4 },\n    { name: 'Visual Quality', weight: 0.3 },\n    { name: 'Technical Correctness', weight: 0.2 },\n    { name: 'Aesthetics', weight: 0.1 }\n  ];\n  const judgeModel = config.judge && config.judge.model ? config.judge.model : 'google/gemini-flash-1.5';\n  const pngA = helpers.svgToPngDataUrl(genA.svg_content);\n  const pngB = helpers.svgToPngDataUrl(genB.svg_content);\n  const criteriaList = criteria.map(c => c.name + ' (' + Math.round(c.weight*100) + '%)').join(', ');\n  const criteriaKeys = criteria.map(c => '\"' + c.name + '\":{\"scoreA\":0-10,\"scoreB\":0-10}').join(',');\n  const result = await helpers.orFetch('/chat/completions', {\n    model: judgeModel,\n    messages: [{ role: 'user', content: [\n      { type: 'text', text: 'Rate SVGs for prompt: \"' + prompt.text + '\"\\nCriteria: ' + criteriaList + '\\nModel A:' },\n      { type: 'image_url', image_url: { url: pngA } },\n      { type: 'text', text: 'Model B:' },\n      { type: 'image_url', image_url: { url: pngB } },\n      { type: 'text', text: 'Score each criterion 0-10 for both. Respond ONLY with JSON: {\"criteria\":{' + criteriaKeys + '},\"feedback\":\"...\"}' }\n    ]}],\n    temperature: 0.1,\n  });\n  const content = result.choices?.[0]?.message?.content || '';\n  const m = content.match(/\\{[\\s\\S]*\\}/);\n  let parsed = {};\n  try { if (m) parsed = JSON.parse(m[0]); } catch(e) {}\n  let totalA = 0, totalB = 0;\n  const breakdown = [];\n  for (const c of criteria) {\n    const scores = parsed.criteria && parsed.criteria[c.name] ? parsed.criteria[c.name] : {};\n    const sA = scores.scoreA != null ? scores.scoreA : 5;\n    const sB = scores.scoreB != null ? scores.scoreB : 5;\n    totalA += sA * c.weight;\n    totalB += sB * c.weight;\n    breakdown.push(c.name + ': A=' + sA + ' B=' + sB);\n  }\n  const winner = totalA > totalB + 0.3 ? 'A' : totalB > totalA + 0.3 ? 'B' : 'tie';\n  return {\n    winner,\n    model_a_score: +totalA.toFixed(1),\n    model_b_score: +totalB.toFixed(1),\n    thought_process: 'Rubric: ' + breakdown.join(' | '),\n    feedback: parsed.feedback || 'Rubric evaluation complete'\n  };\n};",
  },
  {
    id: 'builtin-custom-http-provider',
    name: 'Custom HTTP Provider',
    description: 'Calls any OpenAI-compatible API (Ollama, LM Studio, local). Set extension_provider_url in config.',
    hook_type: 'provider',
    mode_id: null, mode_label: null, mode_icon: null, mode_desc: null,
    fn_body: "return async function(modelId, messages, config) {\n  const baseUrl = (config.extension_provider_url || 'http://localhost:11434/v1').replace(/\\/$/, '');\n  const apiKey = config.extension_provider_key || 'ollama';\n  const fetch = await import('node-fetch').then(m => m.default);\n  const res = await fetch(baseUrl + '/chat/completions', {\n    method: 'POST',\n    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },\n    body: JSON.stringify({ model: modelId, messages, stream: false }),\n  });\n  const json = await res.json();\n  if (!res.ok) throw new Error((json && json.error && json.error.message) || 'HTTP ' + res.status);\n  const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';\n  return {\n    content,\n    usage: { prompt_tokens: (json.usage && json.usage.prompt_tokens) || 0, completion_tokens: (json.usage && json.usage.completion_tokens) || 0 }\n  };\n};",
  },
  {
    id: 'builtin-ranking-judge',
    name: 'Ranking Judge',
    description: 'Judge ranks all N outputs per prompt at once. Synthesizes pairwise comparisons from ranking order.',
    hook_type: 'mode',
    mode_id: 'ranking_judge', mode_label: 'Ranking Judge', mode_icon: '\u{1f3c6}', mode_desc: 'Rank all outputs at once per prompt',
    fn_body: "return async function(runId, config, helpers) {\n  const models = config.models;\n  const prompts = config.prompts;\n  const judge = config.judge;\n  const judgeModel = (judge && judge.model) ? judge.model : 'google/gemini-flash-1.5';\n  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';\n\n  const genPromises = [];\n  for (const model of models) {\n    for (const prompt of prompts) {\n      genPromises.push(helpers.generateOneSVG(runId, model.id || model, prompt, config, model.reasoning_effort || null, helpers.abortCtrl.signal));\n    }\n  }\n  await Promise.allSettled(genPromises);\n  if (helpers.abortCtrl.signal.aborted) return 'stopped';\n\n  const gens = helpers.db.prepare(\"SELECT * FROM generations WHERE run_id=? AND status='complete'\").all(runId);\n  const byPrompt = {};\n  for (const g of gens) {\n    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = [];\n    byPrompt[g.prompt_id].push(g);\n  }\n\n  for (const promptId of Object.keys(byPrompt)) {\n    const pg = byPrompt[promptId];\n    if (pg.length < 2) continue;\n    try {\n      const contentParts = [{ type: 'text', text: 'Rank these ' + pg.length + ' SVGs for prompt: \"' + pg[0].prompt_text + '\" best to worst.\\n' }];\n      for (let i = 0; i < pg.length; i++) {\n        contentParts.push({ type: 'text', text: 'Image ' + letters[i] + ':' });\n        contentParts.push({ type: 'image_url', image_url: { url: helpers.svgToPngDataUrl(pg[i].svg_content) } });\n      }\n      const letterList = '\"' + letters.slice(0,pg.length).split('').join('\",\"') + '\"';\n      contentParts.push({ type: 'text', text: 'Respond ONLY with JSON: {\"ranking\":[' + letterList + '],\"feedback\":\"brief notes\"}\\nList from best to worst.' });\n\n      const result = await helpers.orFetch('/chat/completions', {\n        model: judgeModel,\n        messages: [{ role: 'user', content: contentParts }],\n        temperature: 0.1,\n      });\n      const content = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '';\n      const m = content.match(/\\{[\\s\\S]*\\}/);\n      let parsed = {};\n      try { if (m) parsed = JSON.parse(m[0]); } catch(e) {}\n\n      const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : letters.slice(0,pg.length).split('');\n      for (let i = 0; i < pg.length; i++) {\n        for (let j = i + 1; j < pg.length; j++) {\n          const posA = ranking.indexOf(letters[i]);\n          const posB = ranking.indexOf(letters[j]);\n          const ga = pg[i], gb = pg[j];\n          const winner = posA < posB ? 'A' : posA > posB ? 'B' : 'tie';\n          const cmpId = helpers.uuidv4();\n          helpers.db.prepare(\"INSERT INTO comparisons (id,run_id,prompt_id,prompt_text,model_a_id,model_b_id,generation_a_id,generation_b_id,judge_model,judge_run,winner,model_a_score,model_b_score,thought_process,feedback,status,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'complete',?,?)\").run(\n            cmpId, runId, promptId, pg[0].prompt_text,\n            ga.model_id, gb.model_id, ga.id, gb.id,\n            judgeModel + ' (ranking)', 1, winner,\n            pg.length - (posA >= 0 ? posA : pg.length), pg.length - (posB >= 0 ? posB : pg.length),\n            'Ranking: ' + ranking.join('>'), parsed.feedback || '',\n            Date.now(), Date.now()\n          );\n        }\n      }\n    } catch(e) { console.warn('[ranking_judge]', e.message); }\n  }\n  return 'complete';\n};",
  },
  {
    id: 'builtin-judge-eval',
    name: 'Judge Evaluator',
    description: 'Evaluates judge models by running multiple judges on SVG pairs, then collecting human votes. Judge ELO tracks which judge best matches human preference.',
    hook_type: 'mode',
    mode_id: 'judge_eval', mode_label: 'Judge Evaluator', mode_icon: '⚖️', mode_desc: 'Evaluate judge models — human votes determine which judge is most accurate',
    fn_body: JUDGE_EVAL_FN_BODY,
  },
  {
    id: 'builtin-code-generation',
    name: 'Code Generation',
    description: 'Generates code instead of SVG. Uses text-only judge. Set extension_code_lang in config (default: JavaScript).',
    hook_type: 'mode',
    mode_id: 'code_generation', mode_label: 'Code Generation', mode_icon: '\u{1f4bb}', mode_desc: 'Generate & judge code instead of SVG',
    fn_body: "return async function(runId, config, helpers) {\n  const models = config.models;\n  const prompts = config.prompts;\n  const judge = config.judge;\n  const lang = config.extension_code_lang || 'JavaScript';\n  const judgeModel = (judge && judge.model) ? judge.model : 'google/gemini-flash-1.5';\n\n  const genPromises = [];\n  for (const model of models) {\n    for (const prompt of prompts) {\n      const extraMessages = [\n        { role: 'system', content: 'You are an expert ' + lang + ' developer. Generate clean, working code. Respond with ONLY the code, no explanation.' },\n        { role: 'user', content: 'Write ' + lang + ' code for: ' + prompt.text + '\\n\\nOutput ONLY the code.' }\n      ];\n      genPromises.push(helpers.generateOneSVG(runId, model.id || model, prompt, config, model.reasoning_effort || null, helpers.abortCtrl.signal, extraMessages));\n    }\n  }\n  await Promise.allSettled(genPromises);\n  if (helpers.abortCtrl.signal.aborted) return 'stopped';\n\n  const gens = helpers.db.prepare(\"SELECT * FROM generations WHERE run_id=? AND status='complete'\").all(runId);\n  const byPrompt = {};\n  for (const g of gens) {\n    if (!byPrompt[g.prompt_id]) byPrompt[g.prompt_id] = [];\n    byPrompt[g.prompt_id].push(g);\n  }\n\n  const cmpPromises = [];\n  for (const key of Object.keys(byPrompt)) {\n    const pg = byPrompt[key];\n    for (let i = 0; i < pg.length; i++) {\n      for (let j = i + 1; j < pg.length; j++) {\n        const tmp = Math.random() < 0.5 ? [pg[i], pg[j]] : [pg[j], pg[i]];\n        const ga = tmp[0], gb = tmp[1];\n        cmpPromises.push((async () => {\n          const cmpId = helpers.uuidv4();\n          helpers.db.prepare(\"INSERT INTO comparisons (id,run_id,prompt_id,prompt_text,model_a_id,model_b_id,generation_a_id,generation_b_id,judge_model,judge_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'judging',?)\").run(\n            cmpId, runId, ga.prompt_id, ga.prompt_text, ga.model_id, gb.model_id, ga.id, gb.id, judgeModel, 1, Date.now());\n          try {\n            const codeA = (ga.svg_content || '').slice(0, 3000);\n            const codeB = (gb.svg_content || '').slice(0, 3000);\n            const promptText = 'Compare these ' + lang + ' solutions for: \"' + ga.prompt_text + '\"\\n\\nCode A:\\n' + codeA + '\\n\\nCode B:\\n' + codeB + '\\n\\nWhich is better? Respond ONLY with JSON: {\"thought_process\":\"analysis\",\"winner\":\"A\" or \"B\" or \"tie\",\"model_a_score\":0-10,\"model_b_score\":0-10,\"feedback\":\"notes\"}';\n            const result = await helpers.orFetch('/chat/completions', {\n              model: judgeModel,\n              messages: [{ role: 'user', content: promptText }],\n              temperature: 0.1,\n            });\n            const content = (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || '';\n            const m = content.match(/\\{[\\s\\S]*\\}/);\n            let parsed = {};\n            try { if (m) parsed = JSON.parse(m[0]); } catch(e) {}\n            const winner = ['A','B','tie'].includes(parsed.winner) ? parsed.winner : null;\n            helpers.db.prepare(\"UPDATE comparisons SET winner=?,model_a_score=?,model_b_score=?,thought_process=?,feedback=?,status='complete',completed_at=? WHERE id=?\").run(\n              winner, parsed.model_a_score != null ? parsed.model_a_score : null, parsed.model_b_score != null ? parsed.model_b_score : null, parsed.thought_process || null, parsed.feedback || null, Date.now(), cmpId);\n          } catch(e) {\n            helpers.db.prepare(\"UPDATE comparisons SET status='error',error=?,completed_at=? WHERE id=?\").run(e.message, Date.now(), cmpId);\n          }\n        })());\n      }\n    }\n  }\n  await Promise.allSettled(cmpPromises);\n  return helpers.abortCtrl.signal.aborted ? 'stopped' : 'complete';\n};",
  },
];

for (const ext of BUILTIN_EXTENSIONS) {
  db.prepare(`INSERT OR IGNORE INTO extensions (id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,fn_body,enabled,is_builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?)`).run(
    ext.id, ext.name, ext.description, ext.hook_type, ext.mode_id, ext.mode_label, ext.mode_icon, ext.mode_desc, ext.fn_body, Date.now(), Date.now()
  );
}

rebuildExtensionRegistry();

// ── Extension API Routes ─────────────────────────────────────────────────────

app.get('/api/extensions/modes', (req, res) => {
  const exts = db.prepare(`SELECT * FROM extensions WHERE hook_type='mode' ORDER BY is_builtin DESC, created_at ASC`).all();
  res.json(exts);
});

app.get('/api/extensions', (req, res) => {
  const exts = db.prepare(`SELECT id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,enabled,is_builtin,created_at,updated_at FROM extensions ORDER BY is_builtin DESC, created_at ASC`).all();
  res.json(exts);
});

app.post('/api/extensions', (req, res) => {
  const { name, description, hook_type, mode_id, mode_label, mode_icon, mode_desc, fn_body } = req.body;
  if (!name || !hook_type || !fn_body) return res.status(400).json({ error: 'name, hook_type, fn_body required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO extensions (id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,fn_body,enabled,is_builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`).run(
    id, name, description || '', hook_type, mode_id || null, mode_label || null, mode_icon || null, mode_desc || null, fn_body, Date.now(), Date.now()
  );
  rebuildExtensionRegistry();
  res.json({ id });
});

app.get('/api/extensions/:id', (req, res) => {
  const ext = db.prepare(`SELECT * FROM extensions WHERE id=?`).get(req.params.id);
  if (!ext) return res.status(404).json({ error: 'not found' });
  res.json(ext);
});

app.put('/api/extensions/:id', (req, res) => {
  const ext = db.prepare(`SELECT * FROM extensions WHERE id=?`).get(req.params.id);
  if (!ext) return res.status(404).json({ error: 'not found' });
  const { name, description, hook_type, mode_id, mode_label, mode_icon, mode_desc, fn_body } = req.body;
  db.prepare(`UPDATE extensions SET name=COALESCE(?,name), description=COALESCE(?,description), hook_type=COALESCE(?,hook_type), mode_id=?, mode_label=?, mode_icon=?, mode_desc=?, fn_body=COALESCE(?,fn_body), updated_at=? WHERE id=?`).run(
    name||null, description||null, hook_type||null, mode_id||null, mode_label||null, mode_icon||null, mode_desc||null, fn_body||null, Date.now(), req.params.id
  );
  rebuildExtensionRegistry();
  res.json({ ok: true });
});

app.delete('/api/extensions/:id', (req, res) => {
  const ext = db.prepare(`SELECT * FROM extensions WHERE id=?`).get(req.params.id);
  if (!ext) return res.status(404).json({ error: 'not found' });
  if (ext.is_builtin) return res.status(400).json({ error: 'Cannot delete built-in extensions' });
  db.prepare(`DELETE FROM extensions WHERE id=?`).run(req.params.id);
  rebuildExtensionRegistry();
  res.json({ ok: true });
});

app.post('/api/extensions/:id/toggle', (req, res) => {
  const ext = db.prepare(`SELECT * FROM extensions WHERE id=?`).get(req.params.id);
  if (!ext) return res.status(404).json({ error: 'not found' });
  const newEnabled = ext.enabled ? 0 : 1;
  db.prepare(`UPDATE extensions SET enabled=?, updated_at=? WHERE id=?`).run(newEnabled, Date.now(), req.params.id);
  rebuildExtensionRegistry();
  res.json({ enabled: newEnabled });
});

app.post('/api/extensions/ai-assist', async (req, res) => {
  const { message, hook_type, conversation } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const systemPrompt = `You are an expert PathScore extension builder. Help users write JavaScript extensions for the PathScore SVG benchmark tool.

## Hook Interfaces

### provider hook
fn_body returns: async function(modelId, messages, config)
Returns: { content: string, usage: { prompt_tokens, completion_tokens } }

### judge hook
fn_body returns: async function(genA, genB, prompt, config, helpers)
helpers: { svgToPngDataUrl, orFetch, orStream }
Returns: { winner: 'A'|'B'|'tie', model_a_score: 0-10, model_b_score: 0-10, thought_process: string, feedback: string }

### mode hook
fn_body returns: async function(runId, config, helpers)
helpers: { generateOneSVG, judgeOnePair, runParallelGenAndJudge, abortCtrl, emit, db, uuidv4, svgToPngDataUrl, orFetch, orStream, extractSVG }
Returns: 'complete' | 'stopped'

### results hook
fn_body returns: function(comparisons, models, existing)
Returns: { scores: {modelId: number}, label: string }

## fn_body Pattern
Evaluated as: new Function('helpers', fn_body)(helpers)
Must RETURN the hook function. Example:
\`\`\`javascript
return async function(genA, genB, prompt, config, helpers) {
  return { winner: 'A', model_a_score: 8, model_b_score: 6, thought_process: '...', feedback: '...' };
};
\`\`\``;

  const messages = [];
  if (conversation && Array.isArray(conversation)) {
    for (const msg of conversation) {
      if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const result = await orFetch('/chat/completions', {
      model: 'anthropic/claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.3,
    });
    const reply = result.choices?.[0]?.message?.content || '';
    res.json({ reply });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Flow Builder AI assistant
app.post('/api/flow/ai-assist', async (req, res) => {
  const { message, currentFlow, conversation = [] } = req.body;
  const system = `You are an AI assistant helping users build PathScore benchmark flows in a visual node editor.
The flow has these node types:
- model: fields: model-id (OpenRouter model string like "anthropic/claude-sonnet-4-5"), reasoning (""|"low"|"high")
- prompt: fields: prompts (array of prompt text strings)
- judge: fields: judge-model (model string), judge-runs (number 1-5)
- runner: fields: mode ("standard"|"feedback_iteration"|"human_eval"|"image_to_svg"), bench-name (string), temp (0-1)
- results: terminal output node (no fields to configure)

When the user requests a flow change, respond conversationally AND include a JSON action block in a code fence.
Available actions:
- add_model: data: {"model-id": "...", "reasoning": "high"}
- add_prompt: data: {"text": "prompt text here"}
- set_judge: data: {"judge-model": "...", "judge-runs": 2}
- set_mode: data: {"mode": "standard"}
- set_name: data: {"name": "My Benchmark"}
- clear: clears all nodes
- load_preset: data: {"name": "quick_showdown"} (names: quick_showdown, full_standard, feedback_loop, human_eval, multi_judge)

Example action block:
\`\`\`json
{"action":"add_model","data":{"model-id":"anthropic/claude-sonnet-4-5","reasoning":"high"}}
\`\`\`

Only include the JSON block when a change is requested. Be concise and helpful. For popular models, suggest their OpenRouter IDs.`;

  const msgs = [
    { role: 'system', content: system },
    ...(conversation || []),
    { role: 'user', content: message + (currentFlow ? '\n\nCurrent flow state: ' + currentFlow : '') }
  ];
  try {
    const result = await orFetch('/chat/completions', {
      model: 'anthropic/claude-sonnet-4-6',
      messages: msgs,
      max_tokens: 1024
    });
    res.json({ reply: result.choices[0].message.content });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Judge Eval Routes ────────────────────────────────────────────────────────

// GET pending tasks (with SVG content for rendering)
app.get('/api/runs/:id/judge-eval/pending', (req, res) => {
  try {
    const tasks = db.prepare(`
      SELECT t.*, ga.svg_content as svg_a, gb.svg_content as svg_b,
             ga.model_id as model_a, gb.model_id as model_b
      FROM judge_eval_tasks t
      LEFT JOIN generations ga ON ga.id = t.gen_a_id
      LEFT JOIN generations gb ON gb.id = t.gen_b_id
      WHERE t.run_id=? AND t.status='pending'
      ORDER BY t.created_at`).all(req.params.id);
    const total = db.prepare(`SELECT COUNT(*) as n FROM judge_eval_tasks WHERE run_id=?`).get(req.params.id)?.n || 0;
    const done = db.prepare(`SELECT COUNT(*) as n FROM judge_eval_tasks WHERE run_id=? AND status='complete'`).get(req.params.id)?.n || 0;
    res.json({ tasks, total, done, pending: tasks.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST human vote on a task
app.post('/api/runs/:id/judge-eval/vote', (req, res) => {
  const { task_id, winner } = req.body;
  if (!task_id || !winner) return res.status(400).json({ error: 'task_id and winner required' });
  if (!['A','B','both_bad'].includes(winner)) return res.status(400).json({ error: 'winner must be A, B, or both_bad' });
  db.prepare(`UPDATE judge_eval_tasks SET human_winner=?, status='complete', completed_at=? WHERE id=? AND run_id=?`)
    .run(winner, Date.now(), task_id, req.params.id);
  emit(req.params.id, 'judge_eval_vote', { taskId: task_id, winner });
  res.json({ ok: true });
});

// GET judge ELO leaderboard
app.get('/api/runs/:id/judge-eval/results', (req, res) => {
  try {
    const run = db.prepare(`SELECT * FROM runs WHERE id=?`).get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    const config = JSON.parse(run.config);
    const judges = config.judges || [];
    const tasks = db.prepare(`SELECT id,prompt_text,verdicts,human_winner,status,created_at,completed_at FROM judge_eval_tasks WHERE run_id=?`).all(req.params.id);
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'complete').length;

    const K = 32;
    const ratings = {};
    const stats = {};
    for (const j of judges) { ratings[j] = 1000; stats[j] = { agree: 0, disagree: 0, total: 0 }; }

    for (const task of tasks) {
      if (task.status !== 'complete' || !task.human_winner) continue;
      const verdicts = JSON.parse(task.verdicts || '[]');
      const hw = task.human_winner;
      const correct = [], wrong = [];
      for (const v of verdicts) {
        if (!v.winner) continue;
        if (!ratings.hasOwnProperty(v.judge_model)) { ratings[v.judge_model] = 1000; stats[v.judge_model] = { agree: 0, disagree: 0, total: 0 }; }
        if (hw === 'both_bad') { wrong.push(v); stats[v.judge_model].disagree++; stats[v.judge_model].total++; }
        else if (v.winner === hw) { correct.push(v); stats[v.judge_model].agree++; stats[v.judge_model].total++; }
        else { wrong.push(v); stats[v.judge_model].disagree++; stats[v.judge_model].total++; }
      }
      for (const c of correct) {
        for (const w of wrong) {
          const rc = ratings[c.judge_model], rw = ratings[w.judge_model];
          const ec = 1 / (1 + Math.pow(10, (rw - rc) / 400));
          ratings[c.judge_model] = rc + K * (1 - ec);
          ratings[w.judge_model] = rw + K * (0 - (1 - ec));
        }
      }
    }

    const allJudges = [...new Set([...judges, ...Object.keys(stats)])];
    const leaderboard = allJudges.map(j => ({
      judge: j,
      elo: Math.round(ratings[j] ?? 1000),
      agree: stats[j]?.agree ?? 0,
      disagree: stats[j]?.disagree ?? 0,
      total: stats[j]?.total ?? 0,
      agree_rate: (stats[j]?.total ?? 0) > 0 ? +((stats[j].agree / stats[j].total) * 100).toFixed(1) : null,
    })).sort((a, b) => b.elo - a.elo);

    res.json({ run: { ...run, config }, leaderboard, total, done, pending: total - done, tasks });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`PathScore running on http://localhost:${PORT}`));
