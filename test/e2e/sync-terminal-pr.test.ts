import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { HilRequest, SdlcEvent } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { localHas, makeRemoteRepo, remoteHas, someonesPr, testApp, tmpDir } from '../helpers.js';

/** Writes one file per task, so every author task has a commit of its own to deliver. */
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

const statusesOf = (events: SdlcEvent[]) => events.filter((e) => e.type === 'task.status').map((e) => (e.payload as { to: string }).to);
const hilsOf = (events: SdlcEvent[]) => events.filter((e) => e.type === 'hil.answered').map((e) => (e.payload as { hil: HilRequest }).hil);

/** An author task of its own: pipeline run through, pull request open. */
async function authorTask(prefix: string) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const gh = new FakeGitHub(bare);
  const app = testApp(dir, fileRunner(), {}, gh);
  const t = await app.engine.createTask({ prompt: 'do the work', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
  await app.engine.advance(t.id);
  await app.engine.settled(t.id);
  const task = await app.engine.createPrForTask(t.id, { title: 'The work' });
  expect([task.status, task.prNumber]).toEqual(['pr_open', 1]);
  return { repo, bare, gh, app, task: app.store.getTask(t.id)! };
}

/** The author side parked on PR review comments: `waiting_hil` on a `pr_feedback` request, worktree and branch in place. */
async function authorWaitingOnFeedback(prefix: string) {
  const ctx = await authorTask(prefix);
  ctx.gh.comment(ctx.task.prNumber!, { body: 'please rename this' });
  const fb = await ctx.app.engine.pollPrFeedback(ctx.task.id);
  expect(fb.new).toBe(1);
  expect(ctx.app.store.getTask(ctx.task.id)!.status).toBe('waiting_hil');
  return { ...ctx, hil: ctx.app.store.getHil(fb.hilId!)! };
}

describe('sync: a terminal pull request finishes the task it belongs to', () => {
  it('an author waiting on PR feedback whose PR is merged: the request is cancelled and the task is delivered', async () => {
    const { repo, bare, gh, app, task, hil } = await authorWaitingOnFeedback('sdlc-sync-fb-merged-');

    const events: SdlcEvent[] = [];
    const off = app.events.on((e) => { if (e.type === 'hil.answered' || e.type === 'task.status') events.push(e); });
    await gh.prMerge(repo, task.prNumber!, 'merge');
    const r = await app.engine.syncTasks();
    off();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['merged (on GitHub)']]);
    const dropped = app.store.getHil(hil.id)!;
    expect([dropped.status, dropped.answeredVia]).toEqual(['cancelled', null]);
    expect(dropped.summary).toContain('PR merged on GitHub');
    expect(hilsOf(events).map((h) => h.id)).toEqual([hil.id]);
    expect(statusesOf(events)).toEqual(['merged']);
    expect(app.store.getTask(task.id)!.status).toBe('merged');
    expect(app.store.latestRunForTask(task.id)!.status).toBe('succeeded');
    expect(app.store.openHilForTask(task.id)).toEqual([]);
    // delivered work: the worktree and both copies of the branch are cleaned up
    expect([fs.existsSync(task.worktreePath), localHas(repo, task.branch), remoteHas(bare, task.branch)]).toEqual([false, false, false]);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('an author waiting on PR feedback whose PR is closed: the request is cancelled and the branch is kept', async () => {
    const { repo, bare, gh, app, task, hil } = await authorWaitingOnFeedback('sdlc-sync-fb-closed-');

    const events: SdlcEvent[] = [];
    const off = app.events.on((e) => { if (e.type === 'hil.answered' || e.type === 'task.status') events.push(e); });
    await gh.prClose(repo, task.prNumber!);
    const r = await app.engine.syncTasks();
    off();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['closed (on GitHub)']]);
    expect(app.store.getHil(hil.id)!.status).toBe('cancelled');
    expect(app.store.getHil(hil.id)!.summary).toContain('PR closed on GitHub');
    expect(hilsOf(events).map((h) => h.id)).toEqual([hil.id]);
    expect(statusesOf(events)).toEqual(['closed']);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(app.store.latestRunForTask(task.id)!.status).toBe('aborted');
    // dropped work: the worktree goes, the branch stays everywhere so nothing is lost
    expect([fs.existsSync(task.worktreePath), localHas(repo, task.branch), remoteHas(bare, task.branch)]).toEqual([false, true, true]);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('a failed task keeps its PR: merged by hand finishes it as merged', async () => {
    const { repo, gh, app, task } = await authorTask('sdlc-sync-failed-merged-');
    const t = app.store.getTask(task.id)!; t.status = 'failed'; app.store.updateTask(t);

    await gh.prMerge(repo, task.prNumber!, 'merge');
    const r = await app.engine.syncTasks();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['merged (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('merged');
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('a paused task whose PR is closed ends as closed', async () => {
    const { repo, gh, app, task } = await authorTask('sdlc-sync-paused-closed-');
    const t = app.store.getTask(task.id)!; t.status = 'paused'; app.store.updateTask(t);

    await gh.prClose(repo, task.prNumber!);
    const r = await app.engine.syncTasks();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['closed (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(localHas(repo, task.branch)).toBe(true);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('merged on GitHub restacks the task that was stacked on it, as landing it would have', async () => {
    const { repo, bare, gh, app, task } = await authorTask('sdlc-sync-stack-merged-');
    const child = await app.engine.createTask({ prompt: 'child', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: task.branch });
    await app.engine.advance(child.id);
    await app.engine.settled(child.id);
    await app.engine.createPrForTask(child.id);
    expect(gh.prs.get(2)!.baseRefName).toBe(task.branch);
    gh.comment(task.prNumber!, { body: 'one more thing' });
    expect((await app.engine.pollPrFeedback(task.id)).new).toBe(1);

    await gh.prMerge(repo, task.prNumber!, 'merge');
    const r = await app.engine.syncTasks();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['merged (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('merged');
    // the child is moved off the branch that is about to disappear, on GitHub and in sdlc
    expect(gh.prs.get(2)!.baseRefName).toBe('main');
    expect(app.store.getTask(child.id)!.baseBranch).toBe('main');
    expect([localHas(repo, task.branch), remoteHas(bare, task.branch)]).toEqual([false, false]);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('closed on GitHub leaves the task that was stacked on it where it is', async () => {
    const { repo, bare, gh, app, task } = await authorTask('sdlc-sync-stack-closed-');
    const child = await app.engine.createTask({ prompt: 'child', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: task.branch });
    await app.engine.advance(child.id);
    await app.engine.settled(child.id);
    await app.engine.createPrForTask(child.id);
    gh.comment(task.prNumber!, { body: 'one more thing' });
    expect((await app.engine.pollPrFeedback(task.id)).new).toBe(1);

    await gh.prClose(repo, task.prNumber!);
    const r = await app.engine.syncTasks();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['closed (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    // the work was dropped, not delivered: the child keeps building on the branch, which is still there
    expect(gh.prs.get(2)!.baseRefName).toBe(task.branch);
    expect(app.store.getTask(child.id)!.baseBranch).toBe(task.branch);
    expect([localHas(repo, task.branch), remoteHas(bare, task.branch)]).toEqual([true, true]);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('leaves a task in flight alone while its PR is still open', async () => {
    const { app, task, hil } = await authorWaitingOnFeedback('sdlc-sync-open-noop-');

    const events: SdlcEvent[] = [];
    const off = app.events.on((e) => events.push(e));
    const r = await app.engine.syncTasks();
    off();

    expect([r.errors, r.changes]).toEqual([[], []]);
    expect(statusesOf(events)).toEqual([]);
    expect(app.store.getHil(hil.id)!.status).toBe('open');
    expect([app.store.getTask(task.id)!.status, fs.existsSync(task.worktreePath)]).toEqual(['waiting_hil', true]);
  });
});

/**
 * The sync must not wait for a phase it cannot interrupt (one still queued for a parallel slot): it flags it and
 * finishes the task, and the phase has to stop quietly when its turn comes, without undoing what the sync did.
 */
describe('sync: a terminal pull request while the task is only queued for a slot', () => {
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

  /** A runner that parks the first turn started after `arm()` and keeps the only slot until it is released. */
  function holdingRunner(ran: string[]) {
    let armed = false;
    let release: (() => void) | null = null;
    const runner = new FakeRunner((spec) => ({
      act: async () => {
        ran.push(spec.cwd);
        if (armed && !release) await new Promise<void>((r) => { release = r; });
        if (spec.prompt.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' } };
        if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
        if (spec.prompt.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
        if (spec.prompt.includes('Phase: self_check') || spec.prompt.includes('Phase: clarify')) return { text: 'ok' };
        fs.writeFileSync(path.join(spec.cwd, `${path.basename(spec.cwd)}.txt`), 'work\n');
        return { text: 'done' };
      },
    }));
    return {
      runner,
      arm: () => { armed = true; },
      held: async () => { for (let i = 0; i < 200 && !release; i++) await tick(5); expect(release).toBeTruthy(); },
      release: () => { release!(); },
    };
  }

  it('closed while a reviewer phase waits for a slot: the task is closed at once and that phase never runs', async () => {
    const ran: string[] = [];
    const h = holdingRunner(ran);
    const dir = tmpDir('sdlc-sync-closed-queued-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, h.runner, { max_parallel_tasks: 1 }, gh);

    h.arm();
    const holder = await app.engine.createTask({ prompt: 'hold the only slot', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await h.held();

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    const reviewing = app.engine.advance(task.id);
    await tick();
    expect([app.store.getTask(task.id)!.status, ran.includes(task.worktreePath)]).toEqual(['running', false]);

    const events: SdlcEvent[] = [];
    const off = app.events.on((e) => { if (e.type === 'task.status') events.push(e); });
    await gh.prClose(repo, n);
    const r = await app.engine.syncTasks();   // must not wait for the phase ahead of the queued one

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['closed (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(app.store.latestRunForTask(task.id)!.status).toBe('aborted');
    expect(fs.existsSync(task.worktreePath)).toBe(false);

    h.release();
    await reviewing;
    off();
    const review = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'review')!;
    expect([review.status, review.resultText]).toEqual(['aborted', 'PR closed on GitHub']);
    expect(ran.includes(task.worktreePath)).toBe(false);                   // no paid phase was burned on it
    // the queued phase stopping does not move the task again, and the dropped work keeps its branch
    expect(statusesOf(events)).toEqual(['closed']);
    expect([app.store.getTask(task.id)!.status, app.store.latestRunForTask(task.id)!.status]).toEqual(['closed', 'aborted']);
    expect([localHas(repo, 'feature'), remoteHas(bare, 'feature')]).toEqual([true, true]);
    await app.engine.advance(holder.id);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('merged while the implement phase of an author task waits for a slot: the run keeps the end the sync gave it', async () => {
    const ran: string[] = [];
    const h = holdingRunner(ran);
    const dir = tmpDir('sdlc-sync-merged-queued-author-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, h.runner, { max_parallel_tasks: 1 }, gh);

    const t = await app.engine.createTask({ prompt: 'do the work', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
    await app.engine.advance(t.id);
    await app.engine.settled(t.id);
    const task = await app.engine.createPrForTask(t.id, { title: 'The work' });
    expect([task.status, task.prNumber]).toEqual(['pr_open', 1]);

    h.arm();
    const holder = await app.engine.createTask({ prompt: 'hold the only slot', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await h.held();

    // the developer sends the task back to its implementer, but that phase is queued behind the other task
    await app.engine.requestChanges(task.id, 'rename the thing');
    await tick();
    const ranBefore = ran.filter((c) => c === task.worktreePath).length;
    expect(app.store.getTask(task.id)!.status).toBe('running');
    expect(app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement').at(-1)!.status).toBe('running');

    const events: SdlcEvent[] = [];
    const off = app.events.on((e) => { if (e.type === 'task.status') events.push(e); });
    await gh.prMerge(repo, task.prNumber!, 'merge');
    const r = await app.engine.syncTasks();

    expect([r.errors, r.changes.map((c) => c.change)]).toEqual([[], ['merged (on GitHub)']]);
    expect(app.store.getTask(task.id)!.status).toBe('merged');
    expect(app.store.latestRunForTask(task.id)!.status).toBe('succeeded');

    h.release();
    await app.engine.advance(task.id);   // chains after the queued implement phase
    off();
    const implement = app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement').at(-1)!;
    expect([implement.status, implement.resultText]).toEqual(['aborted', 'PR merged on GitHub']);
    expect(ran.filter((c) => c === task.worktreePath).length).toBe(ranBefore);
    // the phase that stopped quietly must not take the delivered run or task back
    expect(statusesOf(events)).toEqual(['merged']);
    expect([app.store.getTask(task.id)!.status, app.store.latestRunForTask(task.id)!.status]).toEqual(['merged', 'succeeded']);
    expect([fs.existsSync(task.worktreePath), localHas(repo, task.branch), remoteHas(bare, task.branch)]).toEqual([false, false, false]);
    await app.engine.advance(holder.id);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });
});
