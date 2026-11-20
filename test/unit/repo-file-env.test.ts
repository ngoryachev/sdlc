import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PhaseRun } from '@sdlc/shared';
import { ConfigSchema } from '../../server/src/config/config.js';
import { ShellPhaseExecutor } from '../../server/src/phases/shell.js';
import { ShellPhaseSchema } from '../../server/src/pipeline/schema.js';
import type { PhaseContext } from '../../server/src/phases/executor.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { repoFilesPrompt } from '../../server/src/config/repo-files.js';
import { setShellEnv } from '../../server/src/claude/shell-env.js';

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
  afterEach(() => setShellEnv(null));

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

  it('tells a Claude phase which files it has, by env name and file name only', async () => {
    const dir = tmpDir('sdlc-file-env-prompt-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const stored = path.join(dir, 'my-release-key.keystore');
    fs.writeFileSync(stored, 'keystore bytes\n');
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = testApp(dir, runner, { repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: stored }] }] });
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);
    const sys = runner.specs[0]!.systemAppend!;
    expect(sys).toContain('Files available as env vars (absolute paths): `$KEYSTORE` (my-release-key.keystore).');
    expect(sys).toContain('never commit them');
    expect(sys).not.toContain(stored);            // the path is in the variable, not in the prompt
    expect(sys).toContain('SDLC orchestrator rules');   // next to prompts/system/common.md
  });

  it('says nothing about files to a repository that has none', async () => {
    const dir = tmpDir('sdlc-file-env-none-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = testApp(dir, runner, { repos: [{ name: 'shop', path: repo }] });
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);
    expect(runner.specs[0]!.systemAppend).not.toContain('Files available as env vars');
  });

  it('says nothing about a file that is gone from disk', async () => {
    const dir = tmpDir('sdlc-file-env-prompt-missing-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = testApp(dir, runner, { repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: path.join(dir, 'gone.jks') }] }] });
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);
    expect(runner.specs[0]!.systemAppend).not.toContain('Files available as env vars');
  });
  it('gives a shell phase a variable only the login shell knows about', async () => {
    setShellEnv({ ANDROID_HOME: '/home/u/Android/Sdk' });
    const t = shellPhase('sdlc-file-env-shell-layer-', { store: true });
    expect(await t.run('printf %s "$ANDROID_HOME"')).toEqual({ kind: 'ok' });
    expect(t.pr.resultText).toBe('/home/u/Android/Sdk');
  });

  it('names every file that is on disk, in configuration order, and skips the one that is gone', () => {
    const dir = tmpDir('sdlc-file-env-prompt-list-');
    const keystore = path.join(dir, 'my-release-key.keystore');
    const props = path.join(dir, 'key.properties');
    fs.writeFileSync(keystore, 'x'); fs.writeFileSync(props, 'y');
    const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), repos: [{ name: 'shop', path: dir, files: [
      { env: 'ANDROID_KEYSTORE', path: keystore }, { env: 'GONE', path: path.join(dir, 'nope') }, { env: 'ANDROID_KEY_PROPERTIES', path: props },
    ] }] });
    expect(repoFilesPrompt(config, dir)).toBe('Files available as env vars (absolute paths): `$ANDROID_KEYSTORE` (my-release-key.keystore), `$ANDROID_KEY_PROPERTIES` (key.properties). Use them when a build, signing or test needs them; copy them where the project expects them, never commit them.');
  });

  it('says nothing for a repository that is not in the configuration, or for a variable bound to a directory', () => {
    const dir = tmpDir('sdlc-file-env-prompt-edge-');
    const sub = path.join(dir, 'secrets'); fs.mkdirSync(sub);
    expect(repoFilesPrompt(ConfigSchema.parse({ data_dir: path.join(dir, 'data') }), dir)).toBe('');
    const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), repos: [{ name: 'shop', path: dir, files: [{ env: 'SECRETS', path: sub }] }] });
    expect(repoFilesPrompt(config, dir)).toBe('');
  });
});
