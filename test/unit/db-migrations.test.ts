import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS, CURRENT_SCHEMA_VERSION } from '../../server/src/store/db.js';
import { tmpDir } from '../helpers.js';

const dbFile = (prefix: string) => path.join(tmpDir(prefix), 'sdlc.db');

const read = <T>(file: string, fn: (db: DatabaseSync) => T): T => {
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
};

const versions = (file: string): number[] =>
  read(file, (db) => (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version));

const columns = (file: string, table: string): string[] =>
  read(file, (db) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));

/** A DB as some older sdlc left it: `applied` migrations run, `rows` written to schema_version. */
const handBuiltDb = (file: string, applied: number, rows: number[]): void => {
  const db = new DatabaseSync(file);
  for (let i = 0; i < applied; i++) db.exec(MIGRATIONS[i]!);
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  for (const r of rows) db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(r);
  db.close();
};

describe('openDb schema_version bookkeeping', () => {
  it('opens a fresh DB twice and keeps exactly one version row', () => {
    const file = dbFile('sdlc-db-fresh-');
    openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);

    expect(() => openDb(file).close()).not.toThrow();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
  });

  it('repairs a DB left with one row per applied migration', () => {
    const file = dbFile('sdlc-db-broken-');
    // What the old bug produced: every migration applied, but rows 1..N instead of a single row.
    const all = MIGRATIONS.map((_, i) => i + 1);
    handBuiltDb(file, MIGRATIONS.length, all);
    expect(versions(file)).toEqual(all);

    // No migration is re-run (that threw `duplicate column name: model_overrides`).
    expect(() => openDb(file).close()).not.toThrow();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(columns(file, 'tasks')).toContain('model_overrides');
    expect(columns(file, 'tasks')).toContain('pr_head_sha');
  });

  it('migrates a single-row DB that is behind forward to the latest version', () => {
    const file = dbFile('sdlc-db-old-');
    handBuiltDb(file, 1, [1]);
    expect(columns(file, 'tasks')).not.toContain('model_overrides');

    openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(columns(file, 'tasks')).toContain('model_overrides');
    expect(columns(file, 'pipeline_runs')).toContain('return_to');
    expect(columns(file, 'phase_runs')).toContain('head_sha');
  });

  it('migrates a broken multi-row DB that still has migrations pending', () => {
    const file = dbFile('sdlc-db-broken-old-');
    handBuiltDb(file, 2, [1, 2]);

    openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(columns(file, 'phase_runs')).toContain('head_sha');
  });

  it('keeps existing rows when it repairs the version table', () => {
    const file = dbFile('sdlc-db-data-');
    const db = openDb(file);
    const now = new Date().toISOString();
    db.exec('DELETE FROM schema_version');
    for (const v of MIGRATIONS.map((_, i) => i + 1)) db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(v);
    db.prepare(
      `INSERT INTO tasks (id, title, initial_prompt, repo_path, base_branch, branch, worktree_path, pipeline_name, status, created_at, updated_at)
       VALUES ('t_1', 'x', 'p', '/r', 'main', 'b', '/w', 'auto', 'created', ?, ?)`,
    ).run(now, now);
    db.close();

    openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(read(file, (d) => d.prepare('SELECT id FROM tasks').all())).toEqual([{ id: 't_1' }]);
  });
});
