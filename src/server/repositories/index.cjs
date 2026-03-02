'use strict';

function createRepositories(db) {
  const runs = {
    listBasic: () => db.prepare(`SELECT id, name, status, mode, created_at, started_at, completed_at FROM runs ORDER BY created_at DESC`).all(),
    getById: id => db.prepare(`SELECT * FROM runs WHERE id=?`).get(id),
    insert: (id, name, config, mode, createdAt) => db.prepare(`INSERT INTO runs (id, name, config, mode, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`).run(id, name, config, mode, createdAt),
    updateMeta: (id, { name, config, mode }) => {
      if (name) db.prepare(`UPDATE runs SET name=? WHERE id=?`).run(name, id);
      if (config) db.prepare(`UPDATE runs SET config=? WHERE id=?`).run(config, id);
      if (mode) db.prepare(`UPDATE runs SET mode=? WHERE id=?`).run(mode, id);
    },
    setRunning: (id, startedAt) => db.prepare(`UPDATE runs SET status='running', started_at=? WHERE id=?`).run(startedAt, id),
    setComplete: (id, completedAt) => db.prepare(`UPDATE runs SET status='complete', completed_at=? WHERE id=?`).run(completedAt, id),
    setStopped: (id, completedAt) => db.prepare(`UPDATE runs SET status='stopped', completed_at=? WHERE id=?`).run(completedAt, id),
    setError: (id, completedAt, error) => db.prepare(`UPDATE runs SET status='error', completed_at=?, error=? WHERE id=?`).run(completedAt, error, id),
    deleteById: id => db.prepare(`DELETE FROM runs WHERE id=?`).run(id),
    latestComplete: () => db.prepare(`SELECT * FROM runs WHERE status='complete' ORDER BY completed_at DESC LIMIT 1`).get(),
    countComplete: () => db.prepare(`SELECT count(*) as n FROM runs WHERE status='complete'`).get().n,
  };

  const generations = {
    insertGenerating: (id, runId, modelId, promptId, promptText, createdAt) => db.prepare(`INSERT INTO generations (id, run_id, model_id, prompt_id, prompt_text, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'generating', ?)`).run(id, runId, modelId, promptId, promptText, createdAt),
    setComplete: (id, svg, elapsed, pTokens, cTokens, completedAt) => db.prepare(`UPDATE generations SET svg_content=?, generation_time_ms=?, tokens_prompt=?, tokens_completion=?, status='complete', completed_at=? WHERE id=?`).run(svg, elapsed, pTokens, cTokens, completedAt, id),
    setError: (id, error, completedAt) => db.prepare(`UPDATE generations SET status='error', error=?, completed_at=? WHERE id=?`).run(error, completedAt, id),
    getById: id => db.prepare(`SELECT * FROM generations WHERE id=?`).get(id),
    listByRun: runId => db.prepare(`SELECT * FROM generations WHERE run_id=? ORDER BY created_at`).all(runId),
    listByRunStatus: (runId, status) => db.prepare(`SELECT * FROM generations WHERE run_id=? AND status=?`).all(runId, status),
    countByRun: runId => db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=?`).get(runId).n,
    countByRunStatus: (runId, status) => db.prepare(`SELECT COUNT(*) as n FROM generations WHERE run_id=? AND status=?`).get(runId, status).n,
    countCompleteAll: () => db.prepare(`SELECT count(*) as n FROM generations WHERE status='complete'`).get().n,
    countDistinctModelsComplete: () => db.prepare(`SELECT count(DISTINCT model_id) as n FROM generations WHERE status='complete'`).get().n,
    deleteByRun: runId => db.prepare(`DELETE FROM generations WHERE run_id=?`).run(runId),
  };

  const comparisons = {
    insertJudging: (args) => db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
      generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`)
      .run(args.id, args.runId, args.promptId, args.promptText, args.modelA, args.modelB, args.genAId, args.genBId, args.judgeModel, args.judgeRun, args.createdAt),
    insertPendingHuman: (args) => db.prepare(`INSERT INTO comparisons (id, run_id, prompt_id, prompt_text, model_a_id, model_b_id,
      generation_a_id, generation_b_id, judge_model, judge_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_human', ?)`)
      .run(args.id, args.runId, args.promptId, args.promptText, args.modelA, args.modelB, args.genAId, args.genBId, args.judgeModel, args.judgeRun, args.createdAt),
    setComplete: (id, payload, completedAt) => db.prepare(`UPDATE comparisons SET winner=?, model_a_score=?, model_b_score=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`).run(payload.winner, payload.model_a_score ?? null, payload.model_b_score ?? null, payload.thought_process || null, payload.feedback || null, completedAt, id),
    setError: (id, error, completedAt) => db.prepare(`UPDATE comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(error, completedAt, id),
    listByRun: runId => db.prepare(`SELECT * FROM comparisons WHERE run_id=? ORDER BY created_at`).all(runId),
    listByRunStatus: (runId, status) => db.prepare(`SELECT * FROM comparisons WHERE run_id=? AND status=?`).all(runId, status),
    setStatus: (id, status) => db.prepare(`UPDATE comparisons SET status=? WHERE id=?`).run(status, id),
    countByRun: runId => db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=?`).get(runId).n,
    countByRunStatus: (runId, status) => db.prepare(`SELECT COUNT(*) as n FROM comparisons WHERE run_id=? AND status=?`).get(runId, status).n,
    countCompleteAll: () => db.prepare(`SELECT count(*) as n FROM comparisons WHERE status='complete'`).get().n,
    deleteByRun: runId => db.prepare(`DELETE FROM comparisons WHERE run_id=?`).run(runId),
    pendingHumanWithSvgs: runId => db.prepare(`SELECT c.*, ga.svg_content as svg_a, gb.svg_content as svg_b
      FROM comparisons c
      LEFT JOIN generations ga ON ga.id = c.generation_a_id
      LEFT JOIN generations gb ON gb.id = c.generation_b_id
      WHERE c.run_id=? AND c.status='pending_human'
      ORDER BY c.created_at`).all(runId),
    judgeAgreement: runId => db.prepare(`SELECT * FROM comparisons WHERE run_id=? AND human_winner IS NOT NULL AND winner IS NOT NULL AND status='complete'`).all(runId),
    markHumanJudged: (runId, cmpId, winner, scoreA, scoreB, feedback, completedAt) => db.prepare(`UPDATE comparisons SET human_winner=?, model_a_score=?, model_b_score=?, human_feedback=?, status='complete', winner=COALESCE(winner, ?), completed_at=? WHERE id=? AND run_id=?`).run(winner, scoreA ?? null, scoreB ?? null, feedback || null, winner, completedAt, cmpId, runId),
  };

  const iterations = {
    insertGenerating: (args) => db.prepare(`INSERT INTO iterations (id, run_id, parent_generation_id, model_id, prompt_id, prompt_text, feedback_used, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?)`).run(args.id, args.runId, args.parentGenerationId, args.modelId, args.promptId, args.promptText, args.feedback, args.createdAt),
    setComplete: (id, svg, completedAt) => db.prepare(`UPDATE iterations SET svg_content=?, status='complete', completed_at=? WHERE id=?`).run(svg, completedAt, id),
    setError: (id, error, completedAt) => db.prepare(`UPDATE iterations SET status='error', error=?, completed_at=? WHERE id=?`).run(error, completedAt, id),
    listByRun: runId => db.prepare(`SELECT * FROM iterations WHERE run_id=? ORDER BY created_at`).all(runId),
    listByRunStatus: (runId, status) => db.prepare(`SELECT * FROM iterations WHERE run_id=? AND status=?`).all(runId, status),
    deleteByRun: runId => db.prepare(`DELETE FROM iterations WHERE run_id=?`).run(runId),
  };

  const iterationComparisons = {
    insertJudging: (args) => db.prepare(`INSERT INTO iteration_comparisons (id, run_id, prompt_id, prompt_text, original_generation_id, iter_a_id, iter_b_id, judge_model, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'judging', ?)`).run(args.id, args.runId, args.promptId, args.promptText, args.originalGenerationId, args.iterAId, args.iterBId, args.judgeModel, args.createdAt),
    setComplete: (id, payload, completedAt) => db.prepare(`UPDATE iteration_comparisons SET winner=?, model_a_score=?, model_b_score=?, both_bad=?, thought_process=?, feedback=?, status='complete', completed_at=? WHERE id=?`).run(payload.winner, payload.model_a_score ?? null, payload.model_b_score ?? null, payload.both_bad ?? 0, payload.thought_process || null, payload.feedback || null, completedAt, id),
    setError: (id, error, completedAt) => db.prepare(`UPDATE iteration_comparisons SET status='error', error=?, completed_at=? WHERE id=?`).run(error, completedAt, id),
    listByRun: runId => db.prepare(`SELECT * FROM iteration_comparisons WHERE run_id=? ORDER BY created_at`).all(runId),
    deleteByRun: runId => db.prepare(`DELETE FROM iteration_comparisons WHERE run_id=?`).run(runId),
  };

  const extensions = {
    listEnabled: () => db.prepare('SELECT * FROM extensions WHERE enabled=1').all(),
    listModes: () => db.prepare(`SELECT * FROM extensions WHERE hook_type='mode' ORDER BY is_builtin DESC, created_at ASC`).all(),
    listMeta: () => db.prepare(`SELECT id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,enabled,is_builtin,created_at,updated_at FROM extensions ORDER BY is_builtin DESC, created_at ASC`).all(),
    getById: id => db.prepare(`SELECT * FROM extensions WHERE id=?`).get(id),
    insert: (args) => db.prepare(`INSERT INTO extensions (id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,fn_body,enabled,is_builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,0,?,?)`).run(args.id, args.name, args.description || '', args.hookType, args.modeId || null, args.modeLabel || null, args.modeIcon || null, args.modeDesc || null, args.fnBody, args.createdAt, args.updatedAt),
    upsertBuiltin: (args) => db.prepare(`INSERT OR IGNORE INTO extensions (id,name,description,hook_type,mode_id,mode_label,mode_icon,mode_desc,fn_body,enabled,is_builtin,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,1,?,?)`).run(args.id, args.name, args.description, args.hookType, args.modeId, args.modeLabel, args.modeIcon, args.modeDesc, args.fnBody, args.createdAt, args.updatedAt),
    update: (id, args) => db.prepare(`UPDATE extensions SET name=COALESCE(?,name), description=COALESCE(?,description), hook_type=COALESCE(?,hook_type), mode_id=?, mode_label=?, mode_icon=?, mode_desc=?, fn_body=COALESCE(?,fn_body), updated_at=? WHERE id=?`).run(args.name || null, args.description || null, args.hookType || null, args.modeId || null, args.modeLabel || null, args.modeIcon || null, args.modeDesc || null, args.fnBody || null, args.updatedAt, id),
    remove: id => db.prepare(`DELETE FROM extensions WHERE id=?`).run(id),
    toggle: (id, enabled, updatedAt) => db.prepare(`UPDATE extensions SET enabled=?, updated_at=? WHERE id=?`).run(enabled, updatedAt, id),
  };

  return {
    db,
    runs,
    generations,
    comparisons,
    iterations,
    iterationComparisons,
    extensions,
  };
}

module.exports = {
  createRepositories,
};
