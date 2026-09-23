import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

const okRunner = () => new FakeRunner((spec) => ({
  act: () => {
    if (spec.prompt.includes('Phase: self_check')) return { text: 'checked' };
    if (spec.prompt.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'nothing', commands: [], tests_added: [], failures: [], notes: '' } };
    if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    if (spec.prompt.includes('Phase: QA')) return { structured: { verdict: 'pass', summary: 'ok', checks: [], issues: [] } };
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

  it('startAt skips earlier phases and runs from the named one', async () => {
    const dir = tmpDir('sdlc-startat-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, okRunner());
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, startAt: 'review' });
    await app.engine.advance(task.id);
    const byName = Object.fromEntries(app.store.phaseRunsForTask(task.id).map((p) => [p.phaseName, p.status]));
    expect(byName).toEqual({ implement: 'skipped', self_check: 'skipped', commit_impl: 'skipped', test: 'skipped', commit_tests: 'skipped', review: 'succeeded', qa: 'succeeded' });
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('land without a PR merges the task branch into a local base, removes worktree and branch', async () => {
    const dir = tmpDir('sdlc-land-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, okRunner());
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    const events: string[] = [];
    app.events.on((e) => { if (e.type === 'git.merged') events.push((e.payload as { via: string }).via); });
    const r = await app.engine.landTask(task.id, 'merge');
    expect(r).toEqual({ method: 'merge', via: 'local' });
    expect(app.store.getTask(task.id)!.status).toBe('merged');
    expect(events).toEqual(['local']);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(execFileSync('git', ['branch', '--list', task.branch], { cwd: repo }).toString().trim()).toBe('');
    // main now contains the change (merge commit on top)
    expect(execFileSync('git', ['show', 'main:a.txt'], { cwd: repo }).toString()).toBe('y\n');
    expect(execFileSync('git', ['log', '--oneline', '-1', 'main'], { cwd: repo }).toString()).toContain('x');
    await expect(app.engine.landTask(task.id)).rejects.toThrow(/only pr_open or succeeded/);
  });

  it('model overrides and limits are resolved at phase start', async () => {
    const dir = tmpDir('sdlc-models-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = okRunner();
    const app = testApp(dir, runner, { models: { default: 'sonnet', effort: 'low', phases: { review: { model: 'opus' } } }, limits: { phases: 'off' }, task_budget_usd: 'off' });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, modelOverrides: { implement: { model: 'haiku', effort: 'max' } } });
    // change the global config while the task runs: the next phases see it
    await app.engine.advance(task.id);
    const byPhase = (name: string) => runner.specs.find((s) => s.prompt.includes(`Phase: ${name}`))!;
    expect(byPhase('implement').model).toBe('haiku'); expect(byPhase('implement').effort).toBe('max');
    expect(byPhase('review').model).toBe('opus'); expect(byPhase('review').effort).toBe('low');
    expect(byPhase('test').model).toBe('sonnet');
    expect(byPhase('test').maxTurns).toBeUndefined(); expect(byPhase('test').maxBudgetUsd).toBeUndefined();
  });
});
