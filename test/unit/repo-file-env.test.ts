import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PhaseRun } from '@sdlc/shared';
import { ConfigSchema } from '../../server/src/config/config.js';
import { ShellPhaseExecutor } from '../../server/src/phases/shell.js';
import { ShellPhaseSchema } from '../../server/src/pipeline/schema.js';
import type { PhaseContext } from '../../server/src/phases/executor.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

/** A shell phase in a worktree of a repository that was given one file, bound to $KEYSTORE. */
function shellPhase(prefix: string, opts: { store: boolean }) {
  const dir = tmpDir(prefix);
  const worktree = path.join(dir, 'wt'); fs.mkdirSync(worktree);
  const stored = path.join(dir, 'files', 'shop', 'key.jks');
  fs.mkdirSync(path.dirname(stored), { recursive: true });
  if (opts.store) fs.writeFileSync(stored, 'keystore bytes\n');
  const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), repos: [{ name: 'shop', path: dir, files: [{ env: 'KEYSTORE', path: stored }] }] });
  const warnings: string[] = [];
  const ctx = {
    task: { id: 't_x', repoPath: dir, worktreePath: worktree },
    config,
    abortRequested: false,
    tpl: {},
    events: { emit: (_t: string, p: { message?: string }) => { if (p.message) warnings.push(p.message); } },
    registerHandle: () => {},
  } as unknown as PhaseContext;
  const pr = { id: 'pr_1' } as PhaseRun;
  const run = (command: string) => new ShellPhaseExecutor().run(ShellPhaseSchema.parse({ name: 'sh', type: 'shell', command }), pr, ctx);
  return { stored, warnings, pr, run };
}

describe('files of a repository as phase env variables', () => {
  it('gives a shell phase the absolute path of the stored file', async () => {
    const t = shellPhase('sdlc-file-env-', { store: true });
    expect(await t.run('printf %s "$KEYSTORE"; cat "$KEYSTORE"')).toEqual({ kind: 'ok' });
    expect(t.pr.resultText).toBe(`${t.stored}keystore bytes\n`);
    expect(t.warnings).toEqual([]);
  });

  it('warns about a file that is gone from disk instead of failing the phase', async () => {
    const t = shellPhase('sdlc-file-env-missing-', { store: false });
    expect(await t.run('test -z "$KEYSTORE"')).toEqual({ kind: 'ok' });
    expect(t.warnings).toEqual([`file for $KEYSTORE is missing at ${t.stored}; the variable is not set`]);
  });

  it('gives a Claude phase the same variable', async () => {
    const dir = tmpDir('sdlc-file-env-claude-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const stored = path.join(dir, 'key.jks');
    fs.writeFileSync(stored, 'keystore bytes\n');
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = testApp(dir, runner, { repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: stored }] }] });
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);
    expect(runner.specs[0]!.env).toEqual({ KEYSTORE: stored });
  });
});
