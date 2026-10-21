import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { HilRequest, SdlcEvent } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, makeRemoteRepo, sh, testApp, tmpDir } from '../helpers.js';

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, bare: string, gh: FakeGitHub, branch = 'feature'): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\nthree\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.');
}

const reviewRunner = (prompts: string[]) => new FakeRunner((spec) => ({
  act: () => {
    prompts.push(spec.prompt);
    return { structured: { verdict: 'request_changes', summary: `pass ${prompts.length}`, findings: [{ severity: 'blocking', title: `Problem ${prompts.length}`, description: 'x', file: 'feature.txt', line: 2 }] } };
  },
}));

const supersedesOf = (h: HilRequest) => (h.payload.kind === 'approve_result' ? h.payload.supersedes : 'not-approve-result');

describe('a reviewer checkpoint that goes stale when the PR gets new commits', () => {
  it('is left alone while the PR head has not moved, however often the sync runs', async () => {
    const dir = tmpDir('sdlc-stale-noop-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;

    expect((await app.engine.syncTasks()).changes).toEqual([]);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    expect(app.store.getHil(hil.id)!.status).toBe('open');
    expect(app.store.getHil(hil.id)!.summary).not.toContain('stale');
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
    expect(prompts.length).toBe(1);                                     // the review did not run again
  });

  it('is dropped again on a second round, and the fresh checkpoint links to the one it really replaces', async () => {
    const dir = tmpDir('sdlc-stale-chain-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const first = app.store.openHilForTask(task.id)[0]!;

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);
    const second = app.store.openHilForTask(task.id)[0]!;
    expect([second.id !== first.id, supersedesOf(second)]).toEqual([true, first.id]);

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\n3\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);
    const third = app.store.openHilForTask(task.id)[0]!;

    expect([third.id !== second.id, third.status]).toEqual([true, 'open']);
    expect(supersedesOf(third)).toBe(second.id);                        // the second one, not the first
    expect([app.store.getHil(first.id)!.status, app.store.getHil(second.id)!.status]).toEqual(['cancelled', 'cancelled']);
    expect(prompts.length).toBe(3);
    expect(app.store.listHil({ taskId: task.id }).filter((h) => h.kind === 'approve_result').length).toBe(3);
  });

  it('is dropped after a force-push too, and the re-review sees the rewritten head', async () => {
    const dir = tmpDir('sdlc-stale-force-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const firstSha = app.store.getTask(task.id)!.prHeadSha!;

    // the author rewrites the single commit of the branch and force-pushes it
    const clone = path.join(dir, 'author');
    sh(dir, ['clone', '-q', bare, clone]);
    sh(clone, ['checkout', '-q', 'feature']);
    fs.writeFileSync(path.join(clone, 'feature.txt'), 'one\n2\nthree\n');
    sh(clone, ['commit', '-q', '-a', '--amend', '-m', 'feature: work, rewritten']);
    sh(clone, ['push', '-q', '--force', 'origin', 'feature']);

    const sync = await app.engine.syncTasks();
    expect(sync.errors).toEqual([]);
    expect(sync.changes.length).toBe(1);
    await app.engine.advance(task.id);

    const dropped = app.store.getHil(hil.id)!;
    expect([dropped.status, dropped.answeredVia]).toEqual(['cancelled', null]);
    expect(dropped.summary).toContain('stale: the PR got');
    expect(app.store.getTask(task.id)!.prHeadSha).not.toBe(firstSha);
    expect(fs.readFileSync(path.join(task.worktreePath, 'feature.txt'), 'utf8')).toBe('one\n2\nthree\n');
    expect(prompts.length).toBe(2);
    expect(app.store.openHilForTask(task.id)[0]!.id).not.toBe(hil.id);
  });

  it('a reviewer that opened the pull request itself keeps its fresh checkpoint: nothing moved yet', async () => {
    const dir = tmpDir('sdlc-stale-ownpr-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    // work done by hand on a branch that is not on the remote yet: the task's own `pr` phase opens the pull request,
    // so `prHeadSha` (set only when a task is created from a PR, and by a re-review) is still empty at the checkpoint
    sh(repo, ['checkout', '-q', '-b', 'handmade']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n');
    sh(repo, ['commit', '-q', '-am', 'flip a to y']);
    sh(repo, ['checkout', '-q', 'main']);
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        prompts.push(spec.prompt);
        return spec.prompt.includes('Phase: test')
          ? { structured: { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' } }
          : { structured: { verdict: 'request_changes', summary: 'needs work', findings: [{ severity: 'blocking', title: 'Problem 1', description: 'x', file: 'a.txt', line: 1 }] } };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ prompt: 'check the branch', repoPath: repo, pipeline: 'standard', branch: 'handmade', startAt: 'test', stopAfter: 'publish' });
    await app.engine.advance(task.id);
    const fresh = app.store.getTask(task.id)!;
    expect([app.engine.roleOfTask(task.id), fresh.status, fresh.prNumber, fresh.prHeadSha]).toEqual(['reviewer', 'waiting_hil', 1, null]);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');

    expect((await app.engine.syncTasks()).changes).toEqual([]);          // the PR head is exactly what the review saw
    expect(app.store.getHil(hil.id)!.status).toBe('open');
    expect(prompts.length).toBe(2);                                      // test + review, no second pass burned

    // and a real push is still noticed afterwards
    commitOnRemote(bare, 'handmade', 'a.txt', 'z\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);
    expect(app.store.getHil(hil.id)!.status).toBe('cancelled');
    expect(app.store.getHil(hil.id)!.summary).toContain('stale: the PR got 1 new commit(s)');
    expect(app.store.openHilForTask(task.id)[0]!.id).not.toBe(hil.id);
  });

  it('falls back to the commit the review pass saw when the checkpoint recorded none', async () => {
    const dir = tmpDir('sdlc-stale-fallback-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const shown = app.store.getPhaseRun(hil.phaseRunId!)!;
    expect(shown.headSha).toBe(app.store.getTask(task.id)!.prHeadSha);   // the checkpoint records what the human is shown

    // a checkpoint opened before hil phases recorded their head, on a task whose `prHeadSha` lags behind the pass
    shown.headSha = null; app.store.updatePhaseRun(shown);
    const stale = app.store.getTask(task.id)!;
    stale.prHeadSha = sh(repo, ['rev-parse', 'main']); app.store.updateTask(stale);

    expect((await app.engine.syncTasks()).changes).toEqual([]);          // the review pass itself saw the current head
    expect([app.store.getHil(hil.id)!.status, prompts.length]).toEqual(['open', 1]);

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);       // and a real push is still caught
    await app.engine.advance(task.id);
    expect([app.store.getHil(hil.id)!.status, prompts.length]).toEqual(['cancelled', 2]);
  });

  it('drops a QA gate of a reviewer segment too and starts the whole segment again', async () => {
    const dir = tmpDir('sdlc-stale-qagate-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const calls: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const qa = spec.prompt.includes('Phase: QA');
        calls.push(qa ? 'qa' : 'review');
        return qa
          ? { structured: { verdict: 'issues', summary: 'one problem', checks: [], issues: [{ severity: 'blocking', title: 'Crashes on empty input', description: 'boom' }] } }
          : { structured: { verdict: 'approve', summary: 'fine', findings: [] } };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'standard', prNumber: n, startAt: 'review', stopAfter: 'qa_gate' });
    expect(app.engine.roleOfTask(task.id)).toBe('reviewer');
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');
    await app.engine.advance(task.id);

    const gate = app.store.openHilForTask(task.id)[0]!;
    expect([gate.kind, calls]).toEqual(['approve_result', ['review', 'qa']]);
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.id === gate.phaseRunId)!.phaseName).toBe('qa_gate');

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);

    expect(app.store.getHil(gate.id)!.status).toBe('cancelled');
    expect(app.store.getHil(gate.id)!.summary).toContain('stale: the PR got 1 new commit(s)');
    expect(calls).toEqual(['review', 'qa', 'review']);                   // the segment runs again from its first phase
    const next = app.store.openHilForTask(task.id)[0]!;
    expect([next.id !== gate.id, next.kind, supersedesOf(next)]).toEqual([true, 'approve_result', gate.id]);
  });

  it('does not throw the checkpoint away when the re-review cannot be started', async () => {
    const dir = tmpDir('sdlc-stale-nofetch-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    // the pull request is still readable (gh has its own token) but git cannot fetch: expired credentials, network, …
    sh(repo, ['remote', 'set-url', 'origin', path.join(dir, 'unreachable.git')]);

    const sync = await app.engine.syncTasks();
    await app.engine.advance(task.id);

    // the re-review could not start, so the decision the human still owes must survive
    expect([app.store.openHilForTask(task.id).length, app.store.getHil(hil.id)!.status]).toEqual([1, 'open']);
    expect(sync.errors.length ? 'reported' : 'silent').toBe('reported');

    // and once git works again the task moves on by itself
    sh(repo, ['remote', 'set-url', 'origin', bare]);
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);
    expect([prompts.length, app.store.getHil(hil.id)!.status]).toEqual([2, 'cancelled']);
    expect(app.store.openHilForTask(task.id)[0]!.id).not.toBe(hil.id);
  });

  it('does not touch a reviewer parked on a question from its still running review phase', async () => {
    const dir = tmpDir('sdlc-stale-question-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    let asked!: Promise<unknown>;
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: async () => {
        // the review phase asks the human something and keeps running while it waits
        asked = spec.canUseTool!('AskUserQuestion', { questions: [{ question: 'Is the old API still used?', header: 'API', options: ['yes', 'no'] }] }, {} as never);
        await asked;
        return { structured: { verdict: 'approve', summary: 'fine', findings: [] } };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    const running = app.engine.advance(task.id);
    for (let i = 0; i < 200 && !app.store.openHilForTask(task.id).length; i++) await new Promise((r) => setTimeout(r, 5));
    const question = app.store.openHilForTask(task.id)[0]!;
    expect([question.kind, app.store.getTask(task.id)!.status, app.engine.roleOfTask(task.id)]).toEqual(['question', 'waiting_hil', 'reviewer']);

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    const sync = await app.engine.syncTasks();
    expect([sync.changes, sync.errors]).toEqual([[], []]);               // a question is not a result checkpoint
    expect(app.store.getHil(question.id)!.status).toBe('open');

    await app.engine.respondHil(question.id, { decision: 'answer', answers: { 'Is the old API still used?': 'no' } }, 'web');
    await running;
    await app.engine.advance(task.id);
    expect(app.store.getHil(question.id)!.status).toBe('answered');
  });

  it('keeps the stale findings off the pull request: what is published comes from the pass that was approved', async () => {
    const dir = tmpDir('sdlc-stale-publish-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, reviewRunner(prompts), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const stale = app.store.openHilForTask(task.id)[0]!;

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    await app.engine.syncTasks();
    await app.engine.advance(task.id);

    const fresh = app.store.openHilForTask(task.id)[0]!;
    expect(fresh.id).not.toBe(stale.id);
    await app.engine.respondHil(fresh.id, { decision: 'approve', findings: { 'review:0': 'post' }, reviewEvent: 'request_changes' }, 'web');
    await app.engine.advance(task.id);

    expect(gh.reviews.length).toBe(1);
    const posted = JSON.stringify(gh.reviews[0]);
    expect(posted).toContain('Problem 2');            // the finding of the pass the human actually saw
    expect(posted).not.toContain('Problem 1');        // the one from the dropped checkpoint
    expect(app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'publish' && p.status === 'succeeded').length).toBe(1);
  });

  it('an aborted task is not brought back to life by a sync that was already under way', async () => {
    const dir = tmpDir('sdlc-stale-abort-');
    const { repo, bare } = makeRemoteRepo(dir);
    let gate: Promise<void> | null = null;
    class GatedGitHub extends FakeGitHub {
      async prView(cwd: string, n: number) { await gate; return super.prView(cwd, n); }
    }
    const gh = new GatedGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const app = testApp(dir, reviewRunner([]), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');

    let openGate!: () => void;
    gate = new Promise<void>((r) => { openGate = r; });
    const sync = app.engine.syncTasks();                                  // parked inside prView
    await new Promise((r) => setTimeout(r, 30));
    await app.engine.abort(task.id, 'aborted by user');                   // abort does not go through the task lock
    openGate();
    await sync;
    await new Promise((r) => setTimeout(r, 100));

    expect(app.store.getTask(task.id)!.status).toBe('aborted');
    expect([app.store.getHil(hil.id)!.status, app.store.openHilForTask(task.id).length]).toEqual(['cancelled', 0]);
  });

  it('announces the drop as hil.answered so a notifier can rewrite the card it sent', async () => {
    const dir = tmpDir('sdlc-stale-event-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const app = testApp(dir, reviewRunner([]), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;

    const seen: SdlcEvent[] = [];
    const off = app.events.on((e) => { if (e.type === 'hil.answered' || e.type === 'hil.requested') seen.push(e); });
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    await app.engine.syncTasks();
    await app.engine.advance(task.id);
    off();

    const answered = seen.filter((e) => e.type === 'hil.answered').map((e) => (e.payload as { hil: HilRequest }).hil);
    expect(answered.map((h) => [h.id, h.status, h.response, h.answeredVia])).toEqual([[hil.id, 'cancelled', null, null]]);
    expect(answered[0]!.summary).toContain('stale: the PR got');
    expect(seen.filter((e) => e.type === 'hil.requested').length).toBe(1);   // exactly one replacement card
  });
});
