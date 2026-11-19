import { describe, it, expect } from 'vitest';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import { branchPushed, branchTreeUrl, jiraIssueUrl, taskLinks } from '../../server/src/engine/links.js';

const runner = () => new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));

describe('jiraIssueUrl', () => {
  it('needs both a base and a key', () => {
    expect(jiraIssueUrl(undefined, 'ABC-123')).toBeNull();
    expect(jiraIssueUrl('', 'ABC-123')).toBeNull();
    expect(jiraIssueUrl('https://x.atlassian.net', null)).toBeNull();
    expect(jiraIssueUrl('  ', 'ABC-123')).toBeNull();
  });

  it('normalises the stored base: trailing slashes and a base already ending in /browse', () => {
    const want = 'https://x.atlassian.net/browse/ABC-123';
    expect(jiraIssueUrl('https://x.atlassian.net', 'ABC-123')).toBe(want);
    expect(jiraIssueUrl('https://x.atlassian.net/', 'ABC-123')).toBe(want);
    expect(jiraIssueUrl('https://x.atlassian.net///', 'ABC-123')).toBe(want);
    expect(jiraIssueUrl(' https://x.atlassian.net ', 'ABC-123')).toBe(want);
    expect(jiraIssueUrl('https://x.atlassian.net/browse', 'ABC-123')).toBe(want);
    expect(jiraIssueUrl('https://x.atlassian.net/browse/', 'ABC-123')).toBe(want);
  });

  it('keeps a base on a sub-path, where /browse is not the root', () => {
    expect(jiraIssueUrl('https://host/jira', 'ABC-123')).toBe('https://host/jira/browse/ABC-123');
  });

  /** A whole issue URL is what copying one out of the browser gives: it must not compose `/browse/X/browse/Y`. */
  it('strips a pasted issue URL back to its base', () => {
    expect(jiraIssueUrl('https://x.atlassian.net/browse/ABC-1', 'ABC-123')).toBe('https://x.atlassian.net/browse/ABC-123');
    expect(jiraIssueUrl('https://x.atlassian.net/browse/ABC-1/', 'ABC-123')).toBe('https://x.atlassian.net/browse/ABC-123');
    expect(jiraIssueUrl('https://host/jira/browse/PROJ-42', 'ABC-123')).toBe('https://host/jira/browse/ABC-123');
  });

  /**
   * config.yaml is hand-edited and only the Settings route checks the value. A scheme-less base would be a relative
   * href in the UI and a url Telegram rejects the whole message for, so it buys no link at all.
   */
  it('gives nothing for a base that is not an absolute http(s) URL', () => {
    for (const bad of ['company.atlassian.net', 'x.atlassian.net/browse', '/browse', 'ftp://x.atlassian.net', 'javascript:alert(1)']) {
      expect(jiraIssueUrl(bad, 'ABC-123')).toBeNull();
    }
    expect(jiraIssueUrl('HTTPS://X.ATLASSIAN.NET', 'ABC-123')).toBe('HTTPS://X.ATLASSIAN.NET/browse/ABC-123');
  });
});

describe('branchTreeUrl', () => {
  it('needs a slug and a branch', () => {
    expect(branchTreeUrl(null, 'sdlc/x')).toBeNull();
    expect(branchTreeUrl('me/shop', null)).toBeNull();
  });

  it('keeps the slashes of a branch name and escapes the rest', () => {
    expect(branchTreeUrl('me/shop', 'sdlc/ABC-123-add-a-flag')).toBe('https://github.com/me/shop/tree/sdlc/ABC-123-add-a-flag');
    expect(branchTreeUrl('me/shop', 'feature/a b')).toBe('https://github.com/me/shop/tree/feature/a%20b');
  });
});

describe('taskLinks', () => {
  const setup = async (o: { jiraUrl?: string; prompt?: string } = {}) => {
    const dir = tmpDir('sdlc-links-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    sh(repo, ['remote', 'add', 'origin', 'https://github.com/me/shop.git']);   // nothing is pushed; this is only where repoSlug comes from
    const app = testApp(dir, runner(), { repos: [{ name: 'shop', path: repo, ...(o.jiraUrl ? { jira_url: o.jiraUrl } : {}) }] }, new FakeGitHub(repo));
    const created = await app.engine.createTask({ prompt: o.prompt ?? 'ABC-123 add a flag', repoPath: repo, pipeline: 'auto', baseRemote: null });
    const task = app.store.getTask(created.id)!;
    expect(task.repoSlug).toBe('me/shop');
    return { app, task };
  };

  it('gives neither link for a repository without jira_url and a branch that was never pushed', async () => {
    const { app, task } = await setup();
    expect(taskLinks(app, task)).toEqual({ jiraUrl: null, branchUrl: null });
  });

  it('gives no Jira link for a task without a key, however the repository is configured', async () => {
    const { app, task } = await setup({ jiraUrl: 'https://x.atlassian.net', prompt: 'add a flag' });
    expect(task.jiraKey).toBeNull();
    expect(taskLinks(app, task).jiraUrl).toBeNull();
  });

  it('gives the Jira link once the repository has a jira_url, trailing slash and all', async () => {
    const { app, task } = await setup({ jiraUrl: 'https://x.atlassian.net/' });
    expect(taskLinks(app, task).jiraUrl).toBe('https://x.atlassian.net/browse/ABC-123');
  });

  it('gives the branch link only once the task branch itself has been pushed', async () => {
    const { app, task } = await setup();
    expect(branchPushed(app.events, task)).toBe(false);
    app.events.emit('git.pushed', { taskId: task.id, branch: task.baseBranch }, { taskId: task.id });
    expect(branchPushed(app.events, task)).toBe(false);   // the base branch, not this task's work
    expect(taskLinks(app, task).branchUrl).toBeNull();

    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    expect(branchPushed(app.events, task)).toBe(true);
    expect(taskLinks(app, task).branchUrl).toBe(`https://github.com/me/shop/tree/${task.branch}`);
  });

  it('gives the branch link to a task that hangs on a pull request, with no push event of its own', async () => {
    const { app, task } = await setup();
    app.store.updateTask({ ...task, prNumber: 7 });
    expect(taskLinks(app, app.store.getTask(task.id)!).branchUrl).toBe(`https://github.com/me/shop/tree/${task.branch}`);
  });

  it('retracts the branch link once sdlc has swept the branch, and restores it on a new push', async () => {
    const { app, task } = await setup();
    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    expect(taskLinks(app, task).branchUrl).not.toBeNull();

    // delivery (land, close --delete-branch, cleanup of an aborted task) deletes the branch: the link would be a 404
    app.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: true }, { taskId: task.id });
    expect(branchPushed(app.events, task)).toBe(false);
    expect(taskLinks(app, task).branchUrl).toBeNull();

    // a worktree removal that kept the branch says nothing either way
    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    app.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: false }, { taskId: task.id });
    expect(taskLinks(app, task).branchUrl).toBe(`https://github.com/me/shop/tree/${task.branch}`);
  });

  it('retracts the branch link of a landed task, whose pull request is no reason to keep it', async () => {
    const { app, task } = await setup();
    app.store.updateTask({ ...task, prNumber: 7, status: 'merged' });
    const landed = app.store.getTask(task.id)!;
    expect(taskLinks(app, landed).branchUrl).not.toBeNull();
    app.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: true }, { taskId: task.id });
    expect(taskLinks(app, landed).branchUrl).toBeNull();
  });

  it('gives no Jira link when the configured repository is a different one', async () => {
    const { app, task } = await setup({ jiraUrl: 'https://x.atlassian.net' });
    app.config.repos = [{ name: 'other', path: '/somewhere/else', jira_url: 'https://y.atlassian.net', files: [] }];
    expect(taskLinks(app, task).jiraUrl).toBeNull();
  });
});
