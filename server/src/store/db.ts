import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, initial_prompt TEXT NOT NULL, refined_prompt TEXT,
    repo_path TEXT NOT NULL, repo_slug TEXT, base_remote TEXT, base_branch TEXT NOT NULL, branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL, pipeline_name TEXT NOT NULL, review_mode TEXT NOT NULL DEFAULT 'conceptual',
    post_review INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, total_cost_usd REAL NOT NULL DEFAULT 0,
    pr_url TEXT, pr_number INTEGER, pr_feedback_cursor TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE pipeline_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), pipeline_name TEXT NOT NULL,
    pipeline_snapshot TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, loop_counts TEXT NOT NULL DEFAULT '{}',
    pending_resume TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX pipeline_runs_task ON pipeline_runs(task_id, created_at);
  CREATE TABLE phase_runs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id), task_id TEXT NOT NULL,
    phase_name TEXT NOT NULL, phase_type TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
    session_id TEXT, resumed_from_session_id TEXT, cost_usd REAL NOT NULL DEFAULT 0, num_turns INTEGER NOT NULL DEFAULT 0,
    result_text TEXT, structured_output TEXT, result_subtype TEXT, error TEXT, transcript_path TEXT,
    artifacts TEXT NOT NULL DEFAULT '{}', started_at TEXT, ended_at TEXT);
  CREATE INDEX phase_runs_task ON phase_runs(task_id, started_at);
  CREATE INDEX phase_runs_run ON phase_runs(run_id, phase_name);
  CREATE TABLE hil_requests (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase_run_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL, payload TEXT NOT NULL, allowed_decisions TEXT NOT NULL, next TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL, response TEXT, answered_via TEXT, expires_at TEXT, created_at TEXT NOT NULL, answered_at TEXT);
  CREATE INDEX hil_open ON hil_requests(status, created_at);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, phase_run_id TEXT, ts TEXT NOT NULL,
    type TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE INDEX events_task ON events(task_id, id);
  CREATE TABLE notifications (
    hil_id TEXT NOT NULL, channel TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (hil_id, channel));
  `,
  `ALTER TABLE tasks ADD COLUMN model_overrides TEXT;`,
];

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let v = row?.version ?? 0;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]!);
    v++;
    if (row) db.prepare('UPDATE schema_version SET version = ?').run(v);
    else db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(v);
    db.exec('COMMIT');
  }
  return db;
}
