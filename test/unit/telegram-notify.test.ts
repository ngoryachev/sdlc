import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, sh, testApp, tmpDir } from '../helpers.js';
import { TelegramNotifier } from '../../server/src/notifiers/telegram.js';
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
    await app.engine.advance(t.id);
    expect(app.engine.roleOfTask(t.id)).toBe('reviewer');
    const hil = app.store.openHilForTask(t.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(t.id);
    const task = app.store.getTask(t.id)!;
    expect(task.status).toBe('pr_open');

    const msg = await notifyPrOpen(app, task);
    expect(msg.text).toBe(`✅ <b>${task.title}</b> → review done, tracking PR #${n}\n${task.prUrl}`);
    expect(msg.button).toBe(true);
  });

  it('an author task on a pre-existing PR reports fixes, not an opening', async () => {
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
    expect(msg.text).toBe(`🔧 <b>${task.title}</b> → fixes pushed to PR #${n}\n${task.prUrl}`);
    expect(msg.button).toBe(true);
  });
});
