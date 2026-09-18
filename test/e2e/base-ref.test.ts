import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

const okRunner = () => new FakeRunner((spec) => ({
  act: () => {
    if (spec.prompt.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'nothing', commands: [], tests_added: [], failures: [], notes: '' } };
    if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'ok' };
  },
}));

describe('base ref resolution and explicit worktree cleanup', () => {
  it('a base whose first segment is not a remote is a local branch (sdlc/x is not remote "sdlc")', async () => {
    const dir = tmpDir('sdlc-base-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const g = (args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
    g(['checkout', '-q', '-b', 'sdlc/base1']); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'on base1']); g(['checkout', '-q', 'main']);
    const app = testApp(dir, okRunner());
    // what the CLI sends for `--base sdlc/base1`
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: 'sdlc', baseBranch: 'base1' });
    expect(task.baseRemote).toBeNull();
    expect(task.baseBranch).toBe('sdlc/base1');
    expect(fs.existsSync(path.join(task.worktreePath, 'b.txt'))).toBe(true);
    await expect(app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, baseBranch: 'nope' })).rejects.toThrow(/base ref nope does not exist/);
  });

  it('worktree survives task completion and is removed only on request', async () => {
    const dir = tmpDir('sdlc-wt-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, okRunner());
    const events: string[] = [];
    app.events.on((e) => { if (e.type === 'task.worktree') events.push((e.payload as { action: string }).action); });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(fs.existsSync(path.join(task.worktreePath, '.git'))).toBe(true);
    const r = await app.engine.removeTaskWorktree(task.id);
    expect(r.removed).toBe(true);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(events).toEqual(['removed']);
    // branch kept
    expect(execFileSync('git', ['branch', '--list', task.branch], { cwd: repo }).toString()).toContain(task.branch);
    expect((await app.engine.removeTaskWorktree(task.id)).removed).toBe(false);
  });
});
