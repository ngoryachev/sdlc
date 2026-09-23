import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, localHas, makeRemoteRepo, makeRepo, remoteFile, remoteHas, sh, testApp, tmpDir } from '../helpers.js';
import { ConfigSchema } from '../../server/src/config/config.js';
import { RepoAccounts } from '../../server/src/git/accounts.js';
import { netEnv } from '../../server/src/git/git.js';
import { parseNaming } from '../../server/src/engine/engine.js';

/** Every task writes its own file (named after the task id), so stacked tasks never conflict. */
const fileRunner = () => new FakeRunner((spec) => ({
  act: () => {
    if (spec.prompt.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' } };
    if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    if (spec.prompt.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
    if (spec.prompt.includes('Phase: self_check') || spec.prompt.includes('Phase: clarify')) return { text: 'ok' };
    fs.writeFileSync(path.join(spec.cwd, `${path.basename(spec.cwd)}.txt`), 'work\n');
    return { text: 'done' };
  },
}));

function setup(prefix: string) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const gh = new FakeGitHub(bare);
  const app = testApp(dir, fileRunner(), {}, gh);
  const status = (id: string) => app.store.getTask(id)!.status;
  const task = async (prompt: string, base = 'main', pipeline = 'auto') => {
    const t = await app.engine.createTask({ prompt, repoPath: repo, pipeline, baseRemote: 'origin', baseBranch: base });
    await app.engine.advance(t.id);
    return app.store.getTask(t.id)!;
  };
  return { dir, repo, bare, gh, app, status, task };
}

describe('delivery: create PR, land, restack, close, sync', () => {
  it('land via PR retargets the stacked PR before deleting the branch; squash is refused while a stack exists', async () => {
    const { repo, bare, gh, app, status, task } = setup('sdlc-land-pr-');
    const a = await task('task a');
    expect(status(a.id)).toBe('succeeded');
    const aPr = await app.engine.createPrForTask(a.id, { title: 'Task A' });
    expect(aPr).toMatchObject({ status: 'pr_open', prNumber: 1, title: 'Task A' });
    expect(gh.prs.get(1)).toMatchObject({ headRefName: a.branch, baseRefName: 'main', state: 'OPEN' });

    const b = await task('task b', a.branch);
    await app.engine.createPrForTask(b.id);
    expect(gh.prs.get(2)!.baseRefName).toBe(a.branch);
    expect(app.engine.childTasks(app.store.getTask(a.id)!).map((t) => t.id)).toEqual([b.id]);

    await expect(app.engine.landTask(a.id, 'squash')).rejects.toThrow(/stacked on .*"squash" would rewrite/);
    expect(status(a.id)).toBe('pr_open');

    const r = await app.engine.landTask(a.id, 'merge');
    expect(r).toMatchObject({ method: 'merge', via: 'pr', restacked: [b.id] });
    expect(gh.calls.slice(-2)).toEqual(['merge #1 merge', `retarget #2 -> main`]);
    gh.closeOrphans();                                   // a wrong order (delete before retarget) would close PR #2 here
    expect(gh.prs.get(2)).toMatchObject({ state: 'OPEN', baseRefName: 'main' });
    expect(app.store.getTask(b.id)).toMatchObject({ baseBranch: 'main', baseRemote: 'origin' });
    expect(status(a.id)).toBe('merged');
    expect(remoteHas(bare, a.branch)).toBe(false);
    expect(localHas(repo, a.branch)).toBe(false);
    expect(fs.existsSync(a.worktreePath)).toBe(false);
    expect(remoteFile(bare, 'main', `${a.id}.txt`)).toBe(true);
    // local main followed the merge (it is checked out in the main checkout and clean)
    expect(sh(repo, ['rev-parse', 'main'])).toBe(sh(bare, ['rev-parse', 'main']));

    // the child lands on main through its retargeted PR
    await app.engine.landTask(b.id);
    expect(status(b.id)).toBe('merged');
    expect(remoteFile(bare, 'main', `${b.id}.txt`)).toBe(true);
  });

  it('a running stacked task blocks land', async () => {
    const { app, task } = setup('sdlc-land-busy-');
    const a = await task('task a');
    await app.engine.createPrForTask(a.id);
    const b = await task('task b', a.branch, 'standard');   // stops at the refine checkpoint
    expect(app.store.getTask(b.id)!.status).toBe('waiting_hil');
    await expect(app.engine.landTask(a.id)).rejects.toThrow(/still running/);
    expect(app.store.getTask(a.id)!.status).toBe('pr_open');
  });

  it('land without a PR first catches up with commits pushed to the branch; refuses a diverged branch', async () => {
    const { repo, bare, app, status, task } = setup('sdlc-land-stale-');
    const a = await task('task a');
    sh(repo, ['push', '-q', 'origin', a.branch]);
    commitOnRemote(bare, a.branch, 'from-github.txt');     // e.g. a stacked PR merged into it on GitHub
    const r = await app.engine.landTask(a.id);
    expect(r.via).toBe('local');
    expect(r.notes.join(' ')).toMatch(/fast-forwarded/);
    expect(remoteFile(bare, 'main', 'from-github.txt')).toBe(true);
    expect(remoteFile(bare, 'main', `${a.id}.txt`)).toBe(true);
    expect(status(a.id)).toBe('merged');

    const c = await task('task c');
    sh(repo, ['push', '-q', 'origin', c.branch]);
    commitOnRemote(bare, c.branch, 'theirs.txt');
    fs.writeFileSync(path.join(c.worktreePath, 'mine.txt'), 'mine\n');
    sh(c.worktreePath, ['add', '-A']); sh(c.worktreePath, ['commit', '-q', '-m', 'local only']);
    await expect(app.engine.landTask(c.id)).rejects.toThrow(/diverged/);
    expect(status(c.id)).toBe('succeeded');
    expect(fs.existsSync(c.worktreePath)).toBe(true);
    expect(remoteFile(bare, 'main', 'mine.txt')).toBe(false);
  });

  it('create PR catches up with the remote copy of the branch and lists stacked tasks already merged into it', async () => {
    const { bare, gh, app, task } = setup('sdlc-create-pr-');
    const a = await task('task a');
    // b builds on a's branch before a was ever pushed: its base is the local branch
    const b0 = await app.engine.createTask({ prompt: 'task b', repoPath: path.dirname(bare) + '/repo', pipeline: 'auto', baseRemote: null, baseBranch: a.branch });
    await app.engine.advance(b0.id);
    const b = app.store.getTask(b0.id)!;
    expect(b).toMatchObject({ status: 'succeeded', baseRemote: null, baseBranch: a.branch });
    const bPr = await app.engine.createPrForTask(b.id);          // the local base is published first, then the PR targets it
    expect(remoteHas(bare, a.branch)).toBe(true);
    expect(gh.prs.get(bPr.prNumber!)!.baseRefName).toBe(a.branch);
    await app.engine.landTask(b.id);
    expect(remoteFile(bare, a.branch, `${b.id}.txt`)).toBe(true);
    // a's local branch is behind now; create PR must fast-forward, not push the stale tip
    const aPr = await app.engine.createPrForTask(a.id, { title: 'Stack of A' });
    expect(aPr.status).toBe('pr_open');
    const pr = gh.prs.get(aPr.prNumber!)!;
    expect(pr.baseRefName).toBe('main');
    expect(pr.body).toContain('Stacked tasks already merged into this branch');
    expect(pr.body).toContain('task b');
    expect(remoteFile(bare, a.branch, `${b.id}.txt`)).toBe(true);   // not rewound
  });

  it('close: closes the PR and removes the worktree; the branch only on request and never under a stack', async () => {
    const { repo, bare, gh, app, status, task } = setup('sdlc-close-');
    const a = await task('task a');
    await app.engine.createPrForTask(a.id);
    const b = await task('task b', a.branch);
    await expect(app.engine.closeTask(a.id, { deleteBranch: true })).rejects.toThrow(/stacked/);
    const closed = await app.engine.closeTask(a.id, { deleteBranch: false });
    expect(closed.status).toBe('closed');
    expect(gh.prs.get(1)!.state).toBe('CLOSED');
    expect(fs.existsSync(a.worktreePath)).toBe(false);
    expect(localHas(repo, a.branch)).toBe(true);

    await app.engine.createPrForTask(b.id);
    await app.engine.closeTask(b.id, { deleteBranch: true });
    expect(status(b.id)).toBe('closed');
    expect(localHas(repo, b.branch)).toBe(false);
    expect(remoteHas(bare, b.branch)).toBe(false);
  });

  it('sync: merged PR → merged + cleanup, closed PR → closed, base changed on GitHub → followed, branch merged by hand → merged', async () => {
    const { repo, bare, gh, app, status, task } = setup('sdlc-sync-');
    const a = await task('task a'); await app.engine.createPrForTask(a.id);
    const b = await task('task b'); await app.engine.createPrForTask(b.id);
    const c = await task('task c'); await app.engine.createPrForTask(c.id);
    const d = await task('task d');
    const e = await task('task e');                         // nothing happens to it

    gh.mergeInRemote(a.branch, 'main'); gh.prs.get(1)!.state = 'MERGED';
    gh.prs.get(2)!.state = 'CLOSED';
    sh(repo, ['push', '-q', 'origin', 'main:refs/heads/develop']); gh.prs.get(3)!.baseRefName = 'develop';
    sh(repo, ['push', '-q', 'origin', d.branch]); gh.mergeInRemote(d.branch, 'main');   // merged outside sdlc, no PR

    const r = await app.engine.syncTasks();
    expect(r.errors).toEqual([]);
    expect(Object.fromEntries(r.changes.map((x) => [x.taskId, x.change]))).toEqual({
      [a.id]: 'merged (on GitHub)', [b.id]: 'closed (on GitHub)', [c.id]: 'base → develop', [d.id]: 'merged (branch found in its base)',
    });
    expect(status(a.id)).toBe('merged'); expect(localHas(repo, a.branch)).toBe(false); expect(remoteHas(bare, a.branch)).toBe(false);
    expect(status(b.id)).toBe('closed'); expect(localHas(repo, b.branch)).toBe(true);
    expect(app.store.getTask(c.id)).toMatchObject({ status: 'pr_open', baseBranch: 'develop' });
    expect(status(d.id)).toBe('merged');
    expect(status(e.id)).toBe('succeeded');
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('sync sweeps the branch of a task that was marked merged without cleanup', async () => {
    const { repo, bare, gh, app, status, task } = setup('sdlc-sweep-');
    const a = await task('task a'); await app.engine.createPrForTask(a.id);
    gh.mergeInRemote(a.branch, 'main'); gh.prs.get(1)!.state = 'MERGED';
    // what an older version did: status merged, branches left behind
    const t = app.store.getTask(a.id)!; t.status = 'merged'; app.store.updateTask(t);
    const r = await app.engine.syncTasks();
    expect(r.changes).toEqual([{ taskId: a.id, title: 'task a', change: 'leftover worktree/branch removed' }]);
    expect(status(a.id)).toBe('merged');
    expect(localHas(repo, a.branch)).toBe(false);
    expect(remoteHas(bare, a.branch)).toBe(false);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });
});

describe('naming and accounts', () => {
  it('names the task and its branch in the background; refine can still rename an unpushed branch', async () => {
    const dir = tmpDir('sdlc-naming-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = fileRunner();
    runner.brief = async () => '{"title": "Поменять a.txt", "branch": "Flip A File"}';
    const app = testApp(dir, runner);
    const t = await app.engine.createTask({ prompt: 'поменяй a.txt пожалуйста очень длинный текст', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.settled(t.id);
    await app.engine.advance(t.id);
    const after = app.store.getTask(t.id)!;
    expect(after.title).toBe('Поменять a.txt');
    expect(after.branch).toBe(`sdlc/flip-a-file-${t.id}`);
    expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: t.worktreePath }).toString().trim()).toBe(after.branch);
    expect(execFileSync('git', ['log', '--format=%B', after.branch], { cwd: repo }).toString()).toContain(`Task: ${t.id}`);
    expect(after.status).toBe('succeeded');
  });

  it('parseNaming tolerates chatter and clips long titles', () => {
    expect(parseNaming('Sure!\n{"title":"Fix the thing.","branch":"fix-thing"}')).toEqual({ title: 'Fix the thing', branch: 'fix-thing' });
    expect(parseNaming('fix-thing')).toEqual({ branch: 'fix-thing' });
    expect(parseNaming(`{"title":"${'x '.repeat(50)}"}`).title!.length).toBeLessThanOrEqual(60);
    expect(parseNaming('no idea')).toEqual({});
  });

  it('repo account: first logged-in account that can push, persisted; an explicit choice wins; git env carries the token', async () => {
    const dir = tmpDir('sdlc-acct-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    sh(repo, ['remote', 'add', 'origin', 'https://github.com/test/repo.git']);
    const gh = new FakeGitHub('', { accounts: [{ login: 'work', active: true }, { login: 'me', active: false }], pushers: ['me'] });
    const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), repos: [{ name: 'test/repo', path: repo }] });
    let saved = 0;
    const acc = new RepoAccounts(config, gh, () => { saved++; });
    expect(await acc.userFor(repo)).toBe('me');
    expect(config.repos[0]!.gh_user).toBe('me');
    expect(saved).toBe(1);
    expect(await acc.forRepo(repo)).toEqual({ user: 'me', token: 'tok-me' });
    acc.set(repo, 'work');
    expect(await acc.userFor(repo)).toBe('work');
    expect(netEnv({ token: 'tok-me' })).toMatchObject({ GH_TOKEN: 'tok-me', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_VALUE_1: '!gh auth git-credential' });
    expect(netEnv({ token: null })).toEqual({ GIT_TERMINAL_PROMPT: '0' });
    // no GitHub remote → no account, no gh calls
    const local = makeRepo(tmpDir('sdlc-acct2-'), { 'a.txt': 'x\n' });
    expect(await acc.userFor(local)).toBeNull();
  });
});
