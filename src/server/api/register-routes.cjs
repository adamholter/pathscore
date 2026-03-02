'use strict';

function registerRoutes(app, ctx) {
  const { uuidv4, repos, services, runEngine, extensions, config } = ctx;

  app.get('/api/models', async (req, res) => {
    try {
      const all = await services.openrouter.getModels();
      const q = (req.query.q || '').toLowerCase();
      const offset = parseInt(req.query.offset, 10) || 0;
      const limit = parseInt(req.query.limit, 10) || 30;
      const filtered = all.filter(m => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
      const total = filtered.length;
      res.json({ models: filtered.slice(offset, offset + limit), total, offset, limit });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/landing', (req, res) => {
    try {
      const totalRuns = repos.runs.countComplete();
      const totalGens = repos.generations.countCompleteAll();
      const totalCmps = repos.comparisons.countCompleteAll();
      const totalModels = repos.generations.countDistinctModelsComplete();

      const latestRun = repos.runs.latestComplete();
      let leaderboard = [];
      let sampleSVGs = [];
      if (latestRun) {
        const gens = repos.generations.listByRunStatus(latestRun.id, 'complete');
        const cmps = repos.comparisons.listByRunStatus(latestRun.id, 'complete');
        const elo = services.stats.calcELO(cmps, [...new Set(gens.map(g => g.model_id))]);
        leaderboard = Object.entries(elo).map(([model, rating]) => ({ model, rating: Math.round(rating) })).sort((a, b) => b.rating - a.rating);
        const byModel = {};
        for (const g of gens) if (!byModel[g.model_id]) byModel[g.model_id] = g;
        sampleSVGs = Object.values(byModel).slice(0, 8).map(g => ({ id: g.id, model_id: g.model_id, prompt_text: g.prompt_text }));
      }

      res.json({
        totalRuns,
        totalGens,
        totalCmps,
        totalModels,
        latestRun: latestRun ? { id: latestRun.id, name: latestRun.name } : null,
        leaderboard,
        sampleSVGs,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/runs', (req, res) => {
    const runs = repos.runs.listBasic();
    res.json(runs.map(r => ({
      ...r,
      genTotal: repos.generations.countByRun(r.id),
      genDone: repos.generations.countByRunStatus(r.id, 'complete'),
      cmpTotal: repos.comparisons.countByRun(r.id),
      cmpDone: repos.comparisons.countByRunStatus(r.id, 'complete'),
    })));
  });

  app.post('/api/runs', (req, res) => {
    const { name, config: runConfig, mode } = req.body;
    if (!name || !runConfig) return res.status(400).json({ error: 'name and config required' });
    const id = uuidv4();
    const runMode = mode || runConfig.mode || 'standard';
    repos.runs.insert(id, name, JSON.stringify(runConfig), runMode, Date.now());
    return res.json({ id, name, mode: runMode, status: 'draft' });
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    return res.json({ ...run, config: JSON.parse(run.config) });
  });

  app.put('/api/runs/:id', (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status === 'running') return res.status(400).json({ error: 'Cannot edit running benchmark' });
    const { name, config: runConfig, mode } = req.body;
    repos.runs.updateMeta(req.params.id, {
      name,
      config: runConfig ? JSON.stringify(runConfig) : null,
      mode,
    });
    return res.json({ ok: true });
  });

  app.delete('/api/runs/:id', (req, res) => {
    repos.iterationComparisons.deleteByRun(req.params.id);
    repos.iterations.deleteByRun(req.params.id);
    repos.comparisons.deleteByRun(req.params.id);
    repos.generations.deleteByRun(req.params.id);
    repos.runs.deleteById(req.params.id);
    return res.json({ ok: true });
  });

  app.post('/api/runs/:id/start', async (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.status === 'running') return res.status(400).json({ error: 'Already running' });
    if (['complete', 'error', 'stopped'].includes(run.status)) {
      repos.iterationComparisons.deleteByRun(req.params.id);
      repos.iterations.deleteByRun(req.params.id);
      repos.comparisons.deleteByRun(req.params.id);
      repos.generations.deleteByRun(req.params.id);
      services.sse.clearLog(req.params.id);
    }
    res.json({ ok: true });
    runEngine.run(req.params.id).catch(console.error);
  });

  app.post('/api/runs/:id/stop', (req, res) => {
    runEngine.stop(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/runs/:id/events', (req, res) => {
    services.sse.attach(req.params.id, req, res);
  });

  app.get('/api/runs/:id/results', (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    const runConfig = JSON.parse(run.config);
    const modelIds = runConfig.models.map(m => m.id || m);

    const gens = repos.generations.listByRun(req.params.id);
    const cmps = repos.comparisons.listByRun(req.params.id);
    const iters = repos.iterations.listByRun(req.params.id);
    const iterCmps = repos.iterationComparisons.listByRun(req.params.id);

    const elo = services.stats.calcELO(cmps, modelIds);
    const stats = services.stats.calcStats(cmps, modelIds);
    const heatmap = services.stats.calcHeatmap(cmps, modelIds);

    const leaderboard = modelIds.map(m => ({
      model: m,
      elo: Math.round(elo[m] || 1000),
      ...stats[m],
      avgScore: stats[m]?.score_count > 0 ? +(stats[m].score_sum / stats[m].score_count).toFixed(2) : null,
    })).sort((a, b) => b.elo - a.elo);

    let iterLeaderboard = null;
    const iterModelIds = runConfig.iteration_models ? runConfig.iteration_models.map(m => m.id || m) : modelIds;
    if (iters.length > 0) {
      const iterElo = services.stats.calcELO(
        iterCmps.map(c => ({
          ...c,
          model_a_id: iters.find(i => i.id === c.iter_a_id)?.model_id,
          model_b_id: iters.find(i => i.id === c.iter_b_id)?.model_id,
          status: c.status,
          winner: c.winner,
          completed_at: c.completed_at,
        })).filter(c => c.model_a_id && c.model_b_id),
        iterModelIds
      );
      iterLeaderboard = iterModelIds.map(m => ({
        model: m,
        elo: Math.round(iterElo[m] || 1000),
        bothBadCount: iterCmps.filter(c => {
          const iterA = iters.find(i => i.id === c.iter_a_id);
          const iterB = iters.find(i => i.id === c.iter_b_id);
          return (iterA?.model_id === m || iterB?.model_id === m) && c.both_bad;
        }).length,
      })).sort((a, b) => b.elo - a.elo);
    }

    const extensionScores = {};
    for (const { fn, name } of extensions.getRegistry().results) {
      try {
        extensionScores[name] = fn(cmps, modelIds, { elo, stats });
      } catch (_) {}
    }

    return res.json({
      run: { ...run, config: runConfig },
      leaderboard,
      heatmap,
      models: modelIds,
      generations: gens,
      comparisons: cmps,
      iterations: iters,
      iterationComparisons: iterCmps,
      iterLeaderboard,
      extensionScores,
    });
  });

  app.get('/api/runs/:id/pending-human', (req, res) => {
    res.json(repos.comparisons.pendingHumanWithSvgs(req.params.id));
  });

  app.post('/api/runs/:id/human-judge', (req, res) => {
    const { cmp_id, winner, score_a, score_b, feedback } = req.body;
    if (!cmp_id || !winner) return res.status(400).json({ error: 'cmp_id and winner required' });
    const validWinner = ['A', 'B', 'tie'].includes(winner) ? winner : null;
    repos.comparisons.markHumanJudged(req.params.id, cmp_id, validWinner, score_a, score_b, feedback, Date.now());
    services.sse.emit(req.params.id, 'human_judgment', { cmpId: cmp_id, winner: validWinner });
    return res.json({ ok: true });
  });

  app.get('/api/runs/:id/judge-agreement', (req, res) => {
    const cmps = repos.comparisons.judgeAgreement(req.params.id);
    const total = cmps.length;
    const agree = cmps.filter(c => c.human_winner === c.winner).length;
    res.json({ total, agree, disagree: total - agree, agreementRate: total > 0 ? (agree / total * 100).toFixed(1) : null });
  });

  app.post('/api/runs/:id/continue', async (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });

    const runConfig = JSON.parse(run.config);
    const pending = repos.db.prepare(`SELECT c.*, ga.svg_content as svg_content_a, gb.svg_content as svg_content_b
      FROM comparisons c
      LEFT JOIN generations ga ON ga.id = c.generation_a_id
      LEFT JOIN generations gb ON gb.id = c.generation_b_id
      WHERE c.run_id=? AND c.status='pending_human'`).all(req.params.id);
    const abortCtrl = new AbortController();

    const pipeline = ctx.createPipeline(ctx);
    for (const c of pending) {
      const genA = { id: c.generation_a_id, model_id: c.model_a_id, prompt_id: c.prompt_id, prompt_text: c.prompt_text, svg_content: c.svg_content_a };
      const genB = { id: c.generation_b_id, model_id: c.model_b_id, prompt_id: c.prompt_id, prompt_text: c.prompt_text, svg_content: c.svg_content_b };
      repos.comparisons.setStatus(c.id, 'judging');
      await pipeline.judgeOnePair(req.params.id, genA, genB, runConfig.judge?.model || 'google/gemini-3-flash-preview', 1, abortCtrl.signal).catch(console.error);
    }
  });

  app.get('/api/generations/:id/svg', (req, res) => {
    const gen = repos.generations.getById(req.params.id);
    if (!gen) return res.status(404).send('not found');
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(gen.svg_content || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#f5f5f5"/><text x="200" y="200" text-anchor="middle" fill="#999" font-family="monospace">No SVG</text></svg>');
  });

  app.get('/api/runs/:id/export/json', (req, res) => {
    const run = repos.runs.getById(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Disposition', `attachment; filename="pathscore-${run.id.slice(0, 8)}.json"`);
    res.json({
      run: { ...run, config: JSON.parse(run.config) },
      generations: repos.generations.listByRun(req.params.id),
      comparisons: repos.comparisons.listByRun(req.params.id),
      iterations: repos.iterations.listByRun(req.params.id),
      iterationComparisons: repos.iterationComparisons.listByRun(req.params.id),
      exported_at: Date.now(),
    });
  });

  app.post('/api/runs/import', (req, res) => {
    const { run, generations, comparisons, iterations, iterationComparisons } = req.body;
    if (!run || !generations) return res.status(400).json({ error: 'invalid import data' });
    const existing = repos.runs.getById(run.id);
    const runId = existing ? uuidv4() : run.id;

    try {
      repos.db.prepare(`INSERT INTO runs (id, name, config, mode, status, created_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId,
        run.name + (existing ? ' (imported)' : ''),
        typeof run.config === 'string' ? run.config : JSON.stringify(run.config),
        run.mode || 'standard',
        run.status || 'complete',
        run.created_at || Date.now(),
        run.started_at || null,
        run.completed_at || null
      );

      const ig = repos.db.prepare(`INSERT OR IGNORE INTO generations (id, run_id, model_id, prompt_id, prompt_text, svg_content,
        generation_time_ms, tokens_prompt, tokens_completion, status, error, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const g of generations) {
        ig.run(g.id, runId, g.model_id, g.prompt_id, g.prompt_text, g.svg_content, g.generation_time_ms, g.tokens_prompt, g.tokens_completion, g.status, g.error, g.created_at, g.completed_at);
      }

      if (comparisons) {
        const ic = repos.db.prepare(`INSERT OR IGNORE INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
          generation_a_id, generation_b_id, judge_model, judge_run, winner, model_a_score, model_b_score,
          thought_process, feedback, status, error, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const c of comparisons) {
          ic.run(c.id, runId, c.prompt_id, c.prompt_text, c.model_a_id, c.model_b_id, c.generation_a_id, c.generation_b_id, c.judge_model, c.judge_run, c.winner, c.model_a_score, c.model_b_score, c.thought_process, c.feedback, c.status, c.error, c.created_at, c.completed_at);
        }
      }

      if (iterations) {
        const ii = repos.db.prepare(`INSERT OR IGNORE INTO iterations (id, run_id, parent_generation_id, model_id, prompt_id, prompt_text, feedback_used, svg_content, status, error, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const it of iterations) ii.run(it.id, runId, it.parent_generation_id, it.model_id, it.prompt_id, it.prompt_text, it.feedback_used, it.svg_content, it.status, it.error, it.created_at, it.completed_at);
      }

      if (iterationComparisons) {
        const iic = repos.db.prepare(`INSERT OR IGNORE INTO iteration_comparisons (id, run_id, prompt_id, prompt_text, original_generation_id, iter_a_id, iter_b_id, judge_model, winner, model_a_score, model_b_score, both_bad, thought_process, feedback, status, error, created_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const c of iterationComparisons) iic.run(c.id, runId, c.prompt_id, c.prompt_text, c.original_generation_id, c.iter_a_id, c.iter_b_id, c.judge_model, c.winner, c.model_a_score, c.model_b_score, c.both_bad, c.thought_process, c.feedback, c.status, c.error, c.created_at, c.completed_at);
      }

      res.json({ ok: true, runId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/generate-prompts', async (req, res) => {
    const { description, count = 10, existing = [] } = req.body;
    try {
      const result = await services.openrouter.orFetch('/chat/completions', {
        model: 'google/gemini-3-flash-preview',
        messages: [{ role: 'user', content: `Generate ${count} diverse SVG benchmark prompts for: "${description}"\n\nMake them specific, visual, and testable. Cover variety: illustrations, icons, logos, data viz, abstract shapes.\nAvoid duplicating: ${existing.map(p => p.text).join(', ')}\n\nRespond ONLY with a JSON array: [{"id":"uuid","text":"prompt text","category":"category"},...]\nCategories: illustration, logo, icon, data-visualization, abstract, typography, scene` }],
        temperature: 0.8,
      });
      const content = result.choices?.[0]?.message?.content || '[]';
      const m = content.match(/\[[\s\S]*\]/);
      let prompts = [];
      if (m) prompts = JSON.parse(m[0]).map(p => ({ ...p, id: p.id || uuidv4() }));
      res.json({ prompts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  app.get('/api/extensions/modes', (req, res) => {
    res.json(repos.extensions.listModes());
  });

  app.get('/api/extensions', (req, res) => {
    res.json(repos.extensions.listMeta());
  });

  app.post('/api/extensions', (req, res) => {
    const { name, description, hook_type, mode_id, mode_label, mode_icon, mode_desc, fn_body } = req.body;
    if (!name || !hook_type || !fn_body) return res.status(400).json({ error: 'name, hook_type, fn_body required' });
    const id = uuidv4();
    repos.extensions.insert({ id, name, description, hookType: hook_type, modeId: mode_id, modeLabel: mode_label, modeIcon: mode_icon, modeDesc: mode_desc, fnBody: fn_body, createdAt: Date.now(), updatedAt: Date.now() });
    extensions.rebuild();
    return res.json({ id });
  });

  app.get('/api/extensions/:id', (req, res) => {
    const ext = repos.extensions.getById(req.params.id);
    if (!ext) return res.status(404).json({ error: 'not found' });
    return res.json(ext);
  });

  app.put('/api/extensions/:id', (req, res) => {
    const ext = repos.extensions.getById(req.params.id);
    if (!ext) return res.status(404).json({ error: 'not found' });
    const { name, description, hook_type, mode_id, mode_label, mode_icon, mode_desc, fn_body } = req.body;
    repos.extensions.update(req.params.id, { name, description, hookType: hook_type, modeId: mode_id, modeLabel: mode_label, modeIcon: mode_icon, modeDesc: mode_desc, fnBody: fn_body, updatedAt: Date.now() });
    extensions.rebuild();
    return res.json({ ok: true });
  });

  app.delete('/api/extensions/:id', (req, res) => {
    const ext = repos.extensions.getById(req.params.id);
    if (!ext) return res.status(404).json({ error: 'not found' });
    if (ext.is_builtin) return res.status(400).json({ error: 'Cannot delete built-in extensions' });
    repos.extensions.remove(req.params.id);
    extensions.rebuild();
    return res.json({ ok: true });
  });

  app.post('/api/extensions/:id/toggle', (req, res) => {
    const ext = repos.extensions.getById(req.params.id);
    if (!ext) return res.status(404).json({ error: 'not found' });
    const newEnabled = ext.enabled ? 0 : 1;
    repos.extensions.toggle(req.params.id, newEnabled, Date.now());
    extensions.rebuild();
    return res.json({ enabled: newEnabled });
  });

  app.post('/api/extensions/ai-assist', async (req, res) => {
    const { message, conversation } = req.body;
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
Must RETURN the hook function.`;

    const messages = [];
    if (conversation && Array.isArray(conversation)) {
      for (const msg of conversation) {
        if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: message });

    try {
      const result = await services.openrouter.orFetch('/chat/completions', {
        model: 'anthropic/claude-sonnet-4-6',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.3,
      });
      res.json({ reply: result.choices?.[0]?.message?.content || '' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
- load_preset: data: {"name": "quick_showdown"}`;

    const msgs = [
      { role: 'system', content: system },
      ...(conversation || []),
      { role: 'user', content: message + (currentFlow ? '\n\nCurrent flow state: ' + currentFlow : '') },
    ];

    try {
      const result = await services.openrouter.orFetch('/chat/completions', {
        model: 'anthropic/claude-sonnet-4-6',
        messages: msgs,
        max_tokens: 1024,
      });
      res.json({ reply: result.choices?.[0]?.message?.content || '' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerRoutes,
};
