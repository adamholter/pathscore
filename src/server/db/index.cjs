'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDirs(cwd) {
  fs.mkdirSync(path.join(cwd, 'data'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'logs'), { recursive: true });
}

function initSchema(db) {
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
}

function runMigrations(db) {
  try { db.exec('ALTER TABLE comparisons ADD COLUMN human_winner TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE comparisons ADD COLUMN human_feedback TEXT'); } catch (_) {}
  try { db.exec("ALTER TABLE runs ADD COLUMN mode TEXT DEFAULT 'standard'"); } catch (_) {}
}

function recoverInterruptedRuns(db, now = Date.now()) {
  db.prepare(`UPDATE generations SET status='error', error='Interrupted (server restart)', completed_at=? WHERE status='generating'`).run(now);
  db.prepare(`UPDATE comparisons SET status='error', error='Interrupted (server restart)', completed_at=? WHERE status='judging'`).run(now);
  db.prepare(`UPDATE runs SET status='complete', completed_at=? WHERE status='running'`).run(now);
}

function createDatabase(config) {
  ensureDirs(config.cwd);
  const db = new Database(path.join(config.cwd, 'data', 'pathscore.db'));
  db.pragma('journal_mode = WAL');
  initSchema(db);
  runMigrations(db);
  recoverInterruptedRuns(db);
  return db;
}

module.exports = {
  createDatabase,
};
