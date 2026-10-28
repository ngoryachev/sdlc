import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS, CURRENT_SCHEMA_VERSION } from '../../server/src/store/db.js';
import { tmpDir } from '../helpers.js';
import { Store } from '../../server/src/store/repo.js';

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

describe('openDb schema_version bookkeeping, further cases', () => {
  it('leaves an in-memory DB at exactly one row too', () => {
    const db = openDb(':memory:');
    try {
      expect(db.prepare('SELECT version FROM schema_version').all()).toEqual([
        { version: CURRENT_SCHEMA_VERSION },
      ]);
    } finally { db.close(); }
  });

  it('stays at one row over repeated opens of an already repaired DB', () => {
    const file = dbFile('sdlc-db-repeat-');
    handBuiltDb(file, MIGRATIONS.length, MIGRATIONS.map((_, i) => i + 1));
    for (let i = 0; i < 3; i++) openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
  });

  it('reads the highest version however the broken rows were ordered', () => {
    const file = dbFile('sdlc-db-scrambled-');
    // rowid order != version order: the old code read the first row, which is the point of MAX().
    handBuiltDb(file, MIGRATIONS.length, [MIGRATIONS.length, 1, 2]);
    openDb(file).close();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(columns(file, 'tasks')).toContain('model_overrides');
  });

  it('is a working store after the repair: rows can be written through every migrated table', () => {
    const file = dbFile('sdlc-db-store-');
    handBuiltDb(file, MIGRATIONS.length, MIGRATIONS.map((_, i) => i + 1));

    const db = openDb(file);
    try {
      const store = new Store(db);
      const now = new Date().toISOString();
      store.insertTask({
        id: 't_1', title: 'x', initialPrompt: 'p', refinedPrompt: null, repoPath: '/r', repoSlug: null,
        baseRemote: 'origin', baseBranch: 'main', branch: 'sdlc/t_1', worktreePath: '/w', pipelineName: 'auto',
        reviewMode: 'conceptual', postReview: false, status: 'created', totalCostUsd: 0, prUrl: null,
        prNumber: null, prFeedbackCursor: null, prHeadSha: null, modelOverrides: null,
        createdAt: now, updatedAt: now,
      });
      // Columns added by the later migrations must be writable, not just present.
      const t = store.getTask('t_1')!;
      t.modelOverrides = { implement: { model: 'opus' } };
      t.prHeadSha = 'deadbeef';
      store.updateTask(t);
      expect(store.getTask('t_1')!.prHeadSha).toBe('deadbeef');
      expect(store.getTask('t_1')!.modelOverrides).toEqual({ implement: { model: 'opus' } });
    } finally { db.close(); }
  });

  it('repairs while another connection has the DB open', () => {
    const file = dbFile('sdlc-db-concurrent-');
    handBuiltDb(file, MIGRATIONS.length, MIGRATIONS.map((_, i) => i + 1));

    const reader = new DatabaseSync(file);
    try {
      reader.prepare('SELECT COUNT(*) AS n FROM schema_version').get();
      expect(() => openDb(file).close()).not.toThrow();
      expect(reader.prepare('SELECT version FROM schema_version').all()).toEqual([
        { version: CURRENT_SCHEMA_VERSION },
      ]);
    } finally { reader.close(); }
  });

  it('does not re-run or rewrite anything for a DB newer than this build', () => {
    const file = dbFile('sdlc-db-ahead-');
    handBuiltDb(file, MIGRATIONS.length, [CURRENT_SCHEMA_VERSION + 5]);
    expect(() => openDb(file).close()).not.toThrow();
    expect(versions(file)).toEqual([CURRENT_SCHEMA_VERSION + 5]);
  });
});
