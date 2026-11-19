import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import { TelegramNotifier } from '../../server/src/notifiers/telegram.js';
import { startNotifierHub } from '../../server/src/notifiers/hub.js';
import type { App } from '../../server/src/app.js';
import type { Task } from '@sdlc/shared';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const APPROVE = { verdict: 'approve', summary: 'ok', findings: [] };

/** Answers every phase of the pipelines used here; implement writes a file so there is something to commit. */
const phaseRunner = () => new FakeRunner((spec) => ({
  act: () => {
    const p = spec.prompt;
    if (p.includes('Phase: test')) return { structured: PASS };
    if (p.includes('Phase: review')) return { structured: APPROVE };
    if (p.includes('Phase: QA')) return { structured: QA_OK };
    if (p.includes('Phase: self_check')) return { text: 'checked' };
    fs.appendFileSync(path.join(spec.cwd, 'work.txt'), 'work\n');
    return { text: 'done' };
  },
}));

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, gh: FakeGitHub, branch = 'feature'): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.');
}

let sent: Record<string, unknown>[] = [];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
    if (String(url).endsWith('/sendMessage')) sent.push(JSON.parse(init?.body ?? '{}'));
    return { json: async () => ({ ok: true, result: { message_id: sent.length } }), status: 200 } as Response;
  }) as unknown as typeof globalThis.fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

/** Drive the notifier the way the hub does, and return the text of the message it sent. */
async function notifyPrOpen(app: App, task: Task): Promise<{ text: string; button: boolean }> {
  sent = [];
  const tg = new TelegramNotifier(app, { botToken: 'x', chatId: '1', token: null });
  await tg.onTaskStatus(task, 'running', 'pr_open', `http://localhost/tasks/${task.id}`);
  const body = sent.at(-1)!;
  const kb = (body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
  return { text: body.text as string, button: kb.some((row) => row.some((b) => b.text === '🔗 Open')) };
}

describe('telegram pr_open message follows who owns the PR', () => {
  it('celebrates the task\'s own fresh PR, and reports fixes on the next round', async () => {
    const dir = tmpDir('sdlc-tg-own-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, phaseRunner(), { max_loops: 0 }, gh);

    const t = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
    await app.engine.advance(t.id);
    const withPr = await app.engine.createPrForTask(t.id, { title: 'Own PR' });
    expect(withPr.status).toBe('pr_open');

    const first = await notifyPrOpen(app, app.store.getTask(t.id)!);
    expect(first.text).toBe(`🎉 <b>Own PR</b> → pr_open\n${withPr.prUrl}`);
    expect(first.button).toBe(true);

    // a round of requested changes brings the same task back to pr_open: no longer news that the PR exists
    await app.engine.requestChanges(t.id, 'one more line');
    await app.engine.advance(t.id);
    const again = app.store.getTask(t.id)!;
    expect(again.status).toBe('pr_open');

    const second = await notifyPrOpen(app, again);
    expect(second.text).toBe(`🔧 <b>Own PR</b> → fixes pushed to PR #${again.prNumber}\n${again.prUrl}`);
    expect(second.button).toBe(true);
  });

  it('a reviewer task only starts tracking somebody else\'s PR', async () => {
    const dir = tmpDir('sdlc-tg-reviewer-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, phaseRunner(), {}, gh);

    const t = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(t.id);   // the clean review passes its own checkpoint and approves the PR
    expect(app.engine.roleOfTask(t.id)).toBe('reviewer');
    const task = app.store.getTask(t.id)!;
    expect(task.status).toBe('pr_open');

    const msg = await notifyPrOpen(app, task);
    expect(msg.text).toBe(`✅ <b>${task.title}</b> → review done, tracking PR #${n}\n${task.prUrl}`);
    expect(msg.button).toBe(true);
  });

  it('an author task on a pre-existing PR reports no opening (and no push it never made)', async () => {
    const dir = tmpDir('sdlc-tg-existing-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, phaseRunner(), { max_loops: 0 }, gh);

    const t = await app.engine.createTask({ prompt: 'fix the feature', repoPath: repo, pipeline: 'auto', prNumber: n });
    await app.engine.advance(t.id);
    const task = app.store.getTask(t.id)!;
    expect(task.status).toBe('pr_open');
    expect(app.engine.roleOfTask(t.id)).toBe('author');

    const msg = await notifyPrOpen(app, task);
    expect(msg.text).toBe(`🔧 <b>${task.title}</b> → attached to PR #${n}\n${task.prUrl}`);   // auto has no push phase
    expect(msg.button).toBe(true);
  });
});

/** The pipelines with a `pr` phase (quick, standard) also run clarify and the checkpoints: answer those too. */
const quickRunner = () => new FakeRunner((spec) => ({
  act: () => {
    const p = spec.prompt;
    if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'change a.txt', assumptions: [] } };
    if (p.includes('Phase: test')) return { structured: PASS };
    if (p.includes('Phase: review')) return { structured: APPROVE };
    if (p.includes('Phase: QA')) return { structured: QA_OK };
    if (p.includes('Phase: self_check')) return { text: 'checked' };
    fs.appendFileSync(path.join(spec.cwd, 'work.txt'), 'work\n');
    return { text: 'done' };
  },
}));

/** Answer every open checkpoint and keep advancing until the task is idle. */
async function runToIdle(app: App, id: string): Promise<void> {
  await app.engine.advance(id);
  for (let i = 0; i < 6; i++) {
    const hil = app.store.openHilForTask(id)[0];
    if (!hil) return;
    await app.engine.respondHil(hil.id, { decision: 'approve' }, 'web');
    await app.engine.advance(id);
  }
}

describe('telegram pr_open wording: the pipeline pr phase and the untouched statuses', () => {
  it('celebrates a PR opened by the pipeline pr phase, then reports fixes on the next push into it', async () => {
    const dir = tmpDir('sdlc-tg-quick-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, quickRunner(), { max_loops: 0 }, gh);

    const t = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await runToIdle(app, t.id);
    const opened = app.store.getTask(t.id)!;
    expect(opened.status).toBe('pr_open');
    expect(app.engine.roleOfTask(t.id)).toBe('author');

    const first = await notifyPrOpen(app, opened);
    expect(first.text).toBe(`🎉 <b>${opened.title}</b> → pr_open\n${opened.prUrl}`);

    // the same task pushes into its own PR again: the PR is no longer news
    await app.engine.requestChanges(t.id, 'one more line');
    await runToIdle(app, t.id);
    const again = app.store.getTask(t.id)!;
    expect(again.status).toBe('pr_open');
    expect(again.prNumber).toBe(opened.prNumber);
    const second = await notifyPrOpen(app, again);
    expect(second.text).toBe(`🔧 <b>${again.title}</b> → fixes pushed to PR #${again.prNumber}\n${again.prUrl}`);
  });

  it('an author task whose pr phase pushes into a pre-existing PR reports fixes, not an opening', async () => {
    const dir = tmpDir('sdlc-tg-quick-existing-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, quickRunner(), { max_loops: 0 }, gh);

    const t = await app.engine.createTask({ prompt: 'fix the feature', repoPath: repo, pipeline: 'quick', prNumber: n });
    await runToIdle(app, t.id);
    const task = app.store.getTask(t.id)!;
    expect(task.status).toBe('pr_open');
    expect(app.engine.roleOfTask(t.id)).toBe('author');
    expect(gh.prs.size).toBe(1);                       // the pr phase pushed into the PR that was already there

    const msg = await notifyPrOpen(app, task);
    expect(msg.text).toBe(`🔧 <b>${task.title}</b> → fixes pushed to PR #${n}\n${task.prUrl}`);
    expect(msg.button).toBe(true);
  });

  it('a fix-pr task that has not pushed yet is only attached to the PR', async () => {
    const dir = tmpDir('sdlc-tg-fixpr-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, quickRunner(), { max_loops: 0 }, gh);

    // wait_for_feedback: the task is set to pr_open at creation, before any phase has run
    const t = await app.engine.createTask({ repoPath: repo, pipeline: 'fix-pr', prNumber: n });
    const task = app.store.getTask(t.id)!;
    expect(task.prNumber).toBe(n);
    expect(app.engine.roleOfTask(t.id)).toBe('author');

    const msg = await notifyPrOpen(app, task);
    expect(msg.text).toBe(`🔧 <b>${task.title}</b> → attached to PR #${n}\n${task.prUrl}`);
    expect(msg.button).toBe(true);
  });

  it('leaves every other status as it was', async () => {
    const dir = tmpDir('sdlc-tg-other-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, phaseRunner(), { max_loops: 0 }, gh);
    const t = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
    await app.engine.advance(t.id);
    const withPr = await app.engine.createPrForTask(t.id, { title: 'Own PR' });

    const tg = new TelegramNotifier(app, { botToken: 'x', chatId: '1', token: null });
    for (const [to, icon] of [['merged', '🎉'], ['succeeded', '🎉'], ['failed', '💥'], ['aborted', '🛑'], ['closed', '🛑'], ['paused', '⏸']] as const) {
      sent = [];
      await tg.onTaskStatus(withPr, 'running', to, 'http://localhost/tasks/x');
      expect(sent.at(-1)!.text).toBe(`${icon} <b>Own PR</b> → ${to}\n${withPr.prUrl}`);
    }
  });

  it('says nothing at all without a chat id', async () => {
    const dir = tmpDir('sdlc-tg-nochat-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, phaseRunner(), { max_loops: 0 });
    const t = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    const tg = new TelegramNotifier(app, { botToken: 'x', token: null });
    await tg.onTaskStatus(app.store.getTask(t.id)!, 'running', 'pr_open', 'http://localhost/tasks/x');
    expect(sent).toEqual([]);
  });
});

describe('EventBus.ofType', () => {
  it('returns one task\'s events of the asked types, oldest first, and respects the limit', () => {
    const dir = tmpDir('sdlc-events-oftype-');
    const app = testApp(dir, phaseRunner());
    const { events } = app;
    events.emit('git.pushed', { taskId: 't_a', branch: 'a' }, { taskId: 't_a' });
    events.emit('git.pr_created', { taskId: 't_a', url: 'u/1', number: 1 }, { taskId: 't_a' });
    events.emit('git.pr_created', { taskId: 't_b', url: 'u/2', number: 2 }, { taskId: 't_b' });
    events.emit('engine.warning', { taskId: 't_a', message: 'w' }, { taskId: 't_a' });
    events.emit('git.pushed', { taskId: 't_a', branch: 'a' }, { taskId: 't_a' });

    const got = events.ofType('t_a', ['git.pr_created', 'git.pushed']);
    expect(got.map((e) => e.type)).toEqual(['git.pushed', 'git.pr_created', 'git.pushed']);
    expect(got.every((e) => e.taskId === 't_a')).toBe(true);
    expect((got[1]!.payload as { number: number }).number).toBe(1);
    expect(got.map((e) => e.id)).toEqual([...got.map((e) => e.id)].sort((a, b) => a - b));

    expect(events.ofType('t_a', [])).toEqual([]);
    expect(events.ofType('t_none', ['git.pr_created'])).toEqual([]);
    expect(events.ofType('t_a', ['git.pushed'], 1).map((e) => e.id)).toEqual([got[0]!.id]);
  });
});

describe('through the notifier hub, as the server wires it', () => {
  it('the fan-out of a real transition already sees it persisted: the own fresh PR is still celebrated', async () => {
    const dir = tmpDir('sdlc-tg-hub-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, phaseRunner(), { max_loops: 0 }, gh);
    const stop = startNotifierHub(app, [new TelegramNotifier(app, { botToken: 'x', chatId: '1', token: null })], 'http://localhost:7400');
    try {
      const t = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
      await app.engine.advance(t.id);
      sent = [];
      const withPr = await app.engine.createPrForTask(t.id, { title: 'Hub PR' });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]!.text).toBe(`🎉 <b>Hub PR</b> → pr_open\n${withPr.prUrl}`);
      expect((sent[0]!.reply_markup as { inline_keyboard: { url?: string }[][] }).inline_keyboard[0]![0]!.url).toBe(`http://localhost:7400/tasks/${t.id}`);

      // a second trip to pr_open, announced by the hub as well
      await app.engine.requestChanges(t.id, 'one more line');
      sent = [];
      await app.engine.advance(t.id);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]!.text).toBe(`🔧 <b>Hub PR</b> → fixes pushed to PR #${withPr.prNumber}\n${withPr.prUrl}`);
    } finally { stop(); }
  });
});

/** Both cards carry the Jira issue and the branch as url-buttons; a link that cannot be composed is simply not offered. */
describe('telegram link buttons', () => {
  const setup = async (o: { jiraUrl?: string } = {}) => {
    const dir = tmpDir('sdlc-tg-links-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    sh(repo, ['remote', 'add', 'origin', 'https://github.com/me/shop.git']);   // nothing is pushed there; it is only where repoSlug comes from
    const app = testApp(dir, quickRunner(), { max_loops: 0, repos: [{ name: 'shop', path: repo, gh_user: 'tester', ...(o.jiraUrl ? { jira_url: o.jiraUrl } : {}) }] }, new FakeGitHub(repo));
    const created = await app.engine.createTask({ prompt: 'ABC-123 change a', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(created.id);
    const hil = app.store.openHilForTask(created.id)[0]!;
    const task = app.store.getTask(created.id)!;
    return { app, task, hil, tg: new TelegramNotifier(app, { botToken: 'x', chatId: '1', token: null }) };
  };
  /** The row that holds "🔗 Open", as `text → url` pairs. */
  const openRow = () => {
    const kb = (sent.at(-1)!.reply_markup as { inline_keyboard: { text: string; url?: string }[][] }).inline_keyboard;
    return kb.find((row) => row.some((b) => b.text === '🔗 Open'))!.map((b) => `${b.text} → ${b.url}`);
  };

  it('offers the issue and the branch once the repository has a jira_url and the branch is pushed', async () => {
    const { app, task, hil, tg } = await setup({ jiraUrl: 'https://x.atlassian.net/' });
    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    const buttons = [
      '🔗 Open → http://localhost/x',
      '🧩 ABC-123 → https://x.atlassian.net/browse/ABC-123',
      '🌿 branch → https://github.com/me/shop/tree/' + task.branch,
    ];
    sent = [];
    await tg.onHilCreated(hil, task, 'http://localhost/x');
    expect(openRow()).toEqual(buttons);
    sent = [];
    await tg.onTaskStatus(task, 'running', 'pr_open', 'http://localhost/x');
    expect(openRow()).toEqual(buttons);
  });

  /** The card for the merge is sent after the sweep that deleted the branch: its button would have been a 404. */
  it('drops the branch button from the merged card once the branch has been swept, and keeps the issue', async () => {
    const { app, task, tg } = await setup({ jiraUrl: 'https://x.atlassian.net' });
    app.events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id });
    const merged = { ...task, prNumber: 7, status: 'merged' as const };
    sent = [];
    await tg.onTaskStatus(merged, 'pr_open', 'merged', 'http://localhost/x');
    expect(openRow()).toContain('\u{1F33F} branch \u2192 https://github.com/me/shop/tree/' + task.branch);

    app.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: true }, { taskId: task.id });
    sent = [];
    await tg.onTaskStatus(merged, 'pr_open', 'merged', 'http://localhost/x');
    expect(openRow()).toEqual(['\u{1F517} Open \u2192 http://localhost/x', '\u{1F9E9} ABC-123 \u2192 https://x.atlassian.net/browse/ABC-123']);
  });

  it('offers only Open when the repository has no jira_url and the branch was never pushed', async () => {
    const { task, hil, tg } = await setup();
    sent = [];
    await tg.onHilCreated(hil, task, 'http://localhost/x');
    expect(openRow()).toEqual(['🔗 Open → http://localhost/x']);
    sent = [];
    await tg.onTaskStatus(task, 'running', 'pr_open', 'http://localhost/x');
    expect(openRow()).toEqual(['🔗 Open → http://localhost/x']);
  });
});
