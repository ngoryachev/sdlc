import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import { defaultReviewEvent } from '@sdlc/shared';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const CLEAN = { verdict: 'approve', summary: 'looks good', findings: [] };
const NITS = { verdict: 'approve', summary: 'good with nits', findings: [{ severity: 'nit', title: 'Naming', description: 'meh', file: 'feature.txt', line: 2 }] };
const FINDING = { verdict: 'request_changes', summary: 'one thing', findings: [{ severity: 'should_fix', title: 'Wrong second line', description: 'two should be 2', file: 'feature.txt', line: 2 }] };
const UNNAMED = { verdict: 'request_changes', summary: 'something is off and I cannot name it', findings: [] };

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, gh: FakeGitHub, branch = 'feature', author = 'alice'): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\nthree\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.', author);
}

/** A reviewer task on somebody else's pull request, run to wherever it stops. */
async function reviewPr(prefix: string, review: unknown, opts: { approveOnClean?: boolean } = {}) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const gh = new FakeGitHub(bare);
  const n = someonesPr(repo, gh);
  const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: review }) })), {}, gh);
  const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n, ...opts });
  await app.engine.advance(task.id);
  return { app, task, gh, n };
}

const requested = (app: ReturnType<typeof testApp>, taskId: string) => app.events.replay(0, taskId).filter((e) => e.type === 'hil.requested');

describe('checkpoints with nothing to decide answer themselves', () => {
  it('reviewer, clean review, approveOnClean on: no checkpoint, the PR is approved on GitHub', async () => {
    const { app, task, gh, n } = await reviewPr('sdlc-auto-clean-', CLEAN);

    expect(app.store.openHilForTask(task.id)).toEqual([]);
    const hil = app.store.listHil({ taskId: task.id }).find((h) => h.kind === 'approve_result')!;
    expect([hil.status, hil.answeredVia, hil.response?.decision, hil.response?.reviewEvent]).toEqual(['answered', 'auto', 'approve', 'approve']);
    expect(hil.response?.findings).toEqual({});
    expect(hil.summary).toContain('auto-approved: no finding needs fixing or publishing; approving the pull request');
    expect(hil.answeredAt).toBeTruthy();

    // no card and no browser notification: that is what hil.requested would have produced
    expect(requested(app, task.id)).toEqual([]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'hil.answered').length).toBe(1);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'task.updated').map((e) => (e.payload as { change: string }).change))
      .toEqual(['approve_result: auto-approved: no finding needs fixing or publishing; approving the pull request']);

    expect(gh.reviews).toEqual([{ number: n, event: 'APPROVE', body: '', comments: [] }]);
    const runs = Object.fromEntries(app.store.phaseRunsForTask(task.id).map((p) => [p.phaseName, p]));
    expect([runs.approve_result!.status, runs.approve_result!.resultText]).toEqual(['succeeded', 'auto-approved: no finding needs fixing or publishing; approving the pull request']);
    expect(runs.publish!.status).toBe('succeeded');
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('reviewer, clean review, approveOnClean off: the checkpoint opens as before', async () => {
    const { app, task, gh } = await reviewPr('sdlc-auto-clean-off-', CLEAN, { approveOnClean: false });

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['approve_result', 'open', null]);
    expect(requested(app, task.id).length).toBe(1);
    expect(gh.reviews).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
  });

  it('a nit-only review is clean too: nothing is fixed or posted, and nobody is asked', async () => {
    const { app, task, gh } = await reviewPr('sdlc-auto-nits-', NITS);

    expect(app.store.openHilForTask(task.id)).toEqual([]);
    const hil = app.store.listHil({ taskId: task.id }).find((h) => h.kind === 'approve_result')!;
    expect([hil.answeredVia, hil.response?.findings]).toEqual(['auto', { 'review:0': 'skip' }]);
    expect(gh.reviews).toEqual([{ number: 1, event: 'APPROVE', body: '', comments: [] }]);   // the nit is dropped, the approval is not
  });

  it('a finding to publish opens the checkpoint, whatever approveOnClean says', async () => {
    for (const approveOnClean of [true, false]) {
      const { app, task, gh } = await reviewPr(`sdlc-auto-finding-${approveOnClean}-`, FINDING, { approveOnClean });
      const hil = app.store.openHilForTask(task.id)[0]!;
      expect([hil.kind, hil.status, hil.response]).toEqual(['approve_result', 'open', null]);
      expect(requested(app, task.id).length).toBe(1);
      expect(gh.reviews).toEqual([]);
    }
  });

  it('a request_changes review that named no finding still goes to the human', async () => {
    // the defaults are all `skip` here too (there is nothing to mark), but the verdict is not an approval
    const { app, task, gh } = await reviewPr('sdlc-auto-unnamed-', UNNAMED);

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['approve_result', 'open', null]);
    expect(requested(app, task.id).length).toBe(1);
    expect(gh.reviews).toEqual([]);
  });

  it('a second clean pass over new commits answers itself again and approves again', async () => {
    const dir = tmpDir('sdlc-auto-rounds-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({ act: () => { prompts.push(spec.prompt); return { structured: CLEAN }; } })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    expect([app.store.getTask(task.id)!.status, gh.reviews.length]).toEqual(['pr_open', 1]);

    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    expect((await app.engine.syncTasks()).changes.length).toBe(1);
    await app.engine.advance(task.id);

    // the re-review is its own round: a fresh auto-answered checkpoint, and publish is not fooled by the first one
    expect(prompts.length).toBe(2);
    const autos = app.store.listHil({ taskId: task.id }).filter((h) => h.answeredVia === 'auto');
    expect(autos.length).toBe(2);
    expect(new Set(autos.map((h) => h.id)).size).toBe(2);
    expect(requested(app, task.id)).toEqual([]);
    expect(gh.reviews).toEqual([{ number: n, event: 'APPROVE', body: '', comments: [] }, { number: n, event: 'APPROVE', body: '', comments: [] }]);
    expect(app.store.openHilForTask(task.id)).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('a QA gate is never auto-passed: it exists only when QA reported issues', async () => {
    const dir = tmpDir('sdlc-auto-qagate-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh);
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => (spec.prompt.includes('Phase: QA')
        ? { structured: { verdict: 'issues', summary: 'one problem', checks: [], issues: [{ severity: 'blocking', title: 'Crashes on empty input', description: 'boom' }] } }
        : { structured: CLEAN }),
    })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'standard', prNumber: n, startAt: 'review', stopAfter: 'qa_gate' });
    await app.engine.advance(task.id);

    // the clean review answered its own checkpoint; the gate decides on QA issues and has something to decide
    const gate = app.store.openHilForTask(task.id)[0]!;
    expect([gate.kind, gate.status, gate.answeredVia]).toEqual(['approve_result', 'open', null]);
    expect(gate.payload.kind === 'approve_result' && gate.payload.focus).toBe('qa');
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.id === gate.phaseRunId)!.phaseName).toBe('qa_gate');
    expect(app.store.listHil({ taskId: task.id }).filter((h) => h.answeredVia === 'auto').length).toBe(1);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
  });

  it('a pull request sdlc opened itself is never auto-approved: GitHub would refuse the verdict', async () => {
    const dir = tmpDir('sdlc-auto-own-pr-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    // the colleague here is sdlc's own account for this repo: GitHub rejects an approval from the PR's author (422)
    const n = someonesPr(repo, gh, 'feature', 'tester');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);

    // the human is asked instead, with `approve` still the proposed event: only they may downgrade it to a comment
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['approve_result', 'open', null]);
    expect(defaultReviewEvent(hil.payload)).toBe('approve');
    expect(requested(app, task.id).length).toBe(1);
    expect(gh.reviews).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');

    // the same PR opened by somebody else is auto-approved as usual
    const other = someonesPr(repo, gh, 'feature2');
    const t2 = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: other });
    await app.engine.advance(t2.id);
    expect(app.store.openHilForTask(t2.id)).toEqual([]);
    expect(gh.reviews).toEqual([{ number: other, event: 'APPROVE', body: '', comments: [] }]);
  });

  it('publish degrades to a comment when GitHub refuses the verdict on sdlc\'s own pull request', async () => {
    const dir = tmpDir('sdlc-auto-own-pr-publish-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh, 'feature', 'tester');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: NITS }) })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    // the human answers with the proposed approve anyway (or the PR changed hands after the checkpoint opened)
    const hil = app.store.openHilForTask(task.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'approve', findings: { 'review:0': 'post' }, reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);

    // the finding still reached the PR, as a comment, and the phase succeeded instead of failing the task
    // the comment carries the reason the verdict is missing: GitHub refuses a bodyless COMMENT review as well
    expect(gh.reviews).toEqual([{ number: n, event: 'COMMENT', body: 'sdlc reviewed this pull request; the `approve` verdict cannot be submitted on a pull request opened by the same account.', comments: [{ path: 'feature.txt', line: 2, body: expect.stringContaining('Naming') }] }]);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect(publish.status).toBe('succeeded');
    expect(publish.resultText).toContain('as COMMENT (APPROVE refused: own pull request)');
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'engine.warning').map((e) => (e.payload as { message: string }).message))
      .toEqual([`GitHub refused APPROVE on PR #${n} (sdlc opened it itself); posted the review as a comment instead`]);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('the degraded comment still says something when the clean review had nothing to post', async () => {
    const dir = tmpDir('sdlc-auto-own-pr-clean-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh, 'feature', 'tester');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    // the human keeps the proposed approve: nothing is marked to post, so the review has no body of its own
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);

    // an empty COMMENT review is a 422 too: the fallback writes the reason instead of failing the run
    expect(gh.reviews).toEqual([{ number: n, event: 'COMMENT', body: 'sdlc reviewed this pull request and found nothing to report; the `approve` verdict cannot be submitted on a pull request opened by the same account.', comments: [] }]);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect([publish.status, publish.resultText]).toEqual(['succeeded', expect.stringContaining('as COMMENT (APPROVE refused: own pull request)')]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'engine.warning').length).toBe(1);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('a reviewer task without a pull request does not claim it approved one', async () => {
    const dir = tmpDir('sdlc-auto-no-pr-');
    const repo = makeRepo(dir, { 'feature.txt': 'one\n' });
    sh(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\n');
    sh(repo, ['commit', '-q', '-am', 'feature: work']);
    sh(repo, ['checkout', '-q', 'main']);
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })));

    // review only, on a local branch: nothing to approve on, since `publish` has no pull request
    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'standard', baseRemote: null, branch: 'feature', startAt: 'review', stopAfter: 'publish' });
    await app.engine.advance(task.id);

    const hil = app.store.listHil({ taskId: task.id }).find((h) => h.kind === 'approve_result')!;
    expect([hil.answeredVia, hil.payload.kind === 'approve_result' && hil.payload.canPost]).toEqual(['auto', false]);
    expect(hil.summary).toContain('auto-approved: no finding needs fixing or publishing');
    expect(hil.summary).not.toContain('approving the pull request');
    const runs = Object.fromEntries(app.store.phaseRunsForTask(task.id).map((p) => [p.phaseName, p]));
    expect(runs.approve_result!.resultText).toBe('auto-approved: no finding needs fixing or publishing');
    expect([runs.publish!.status, runs.publish!.resultText]).toEqual(['skipped', 'no pull request; nothing to publish']);
  });

  it('author, clean review: auto-passed, and the approve it carries is not published on its own PR', async () => {
    const dir = tmpDir('sdlc-auto-author-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'Change a.txt to y', assumptions: [] } };
        if (p.includes('Phase: test')) return { structured: PASS };
        if (p.includes('Phase: review')) return { structured: CLEAN };
        if (p.includes('Phase: QA')) return { structured: QA_OK };
        if (p.includes('Phase: self_check')) return { text: 'checked' };
        fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n');
        return { text: 'implemented' };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await app.engine.advance(task.id);

    expect(app.store.openHilForTask(task.id)).toEqual([]);
    expect(app.store.listHil({ taskId: task.id }).map((h) => [h.kind, h.answeredVia])).toEqual(expect.arrayContaining([['approve_result', 'auto'], ['refine_prompt', 'auto']]));
    const hil = app.store.listHil({ taskId: task.id }).find((h) => h.kind === 'approve_result')!;
    expect(hil.summary).toContain('auto-approved: no finding needs fixing or publishing');
    expect(hil.summary).not.toContain('approving the pull request');   // the author side cannot approve
    expect(gh.reviews).toEqual([]);
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!.status).toBe('skipped');
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });
});

describe('refine answers itself when clarify asked nothing', () => {
  /** clarify → refine only: what the checkpoint does with the clarify output is the whole subject. */
  const refineOnly = async (prefix: string, clarify: unknown) => {
    const dir = tmpDir(prefix);
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, new FakeRunner(() => ({ act: () => (clarify === null ? { subtype: 'error_during_execution' as const } : { structured: clarify }) })));
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick', baseRemote: null, stopAfter: 'refine' });
    await app.engine.advance(task.id);
    return { app, task };
  };

  it('no questions: the suggested prompt, title and branch are applied without asking', async () => {
    const { app, task } = await refineOnly('sdlc-auto-refine-', { title: 'Flip a.txt to y', branch: 'Flip A Txt', questions: [], suggestedPrompt: 'Change a.txt from x to y', assumptions: ['only a.txt'] });

    expect(app.store.openHilForTask(task.id)).toEqual([]);
    const hil = app.store.listHil({ taskId: task.id })[0]!;
    expect([hil.kind, hil.status, hil.answeredVia, hil.response?.decision]).toEqual(['refine_prompt', 'answered', 'auto', 'approve']);
    expect(hil.summary).toContain('auto-approved: clarify had no questions');
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'hil.requested')).toEqual([]);

    const t = app.store.getTask(task.id)!;
    expect([t.refinedPrompt, t.title, t.branch, t.status]).toEqual(['Change a.txt from x to y', 'Flip a.txt to y', `sdlc/flip-a-txt-${task.id}`, 'succeeded']);
    expect(sh(t.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(`sdlc/flip-a-txt-${task.id}`);

    // the dashboard upserts the task from this payload: it has to be the refined one, not the task as it was
    const updates = app.events.replay(0, task.id).filter((e) => e.type === 'task.updated').map((e) => e.payload as { task: typeof t; change: string });
    expect(updates.map((u) => u.change)).toEqual(['refine: auto-approved: clarify had no questions']);
    expect([updates[0]!.task.title, updates[0]!.task.branch, updates[0]!.task.refinedPrompt]).toEqual(['Flip a.txt to y', t.branch, t.refinedPrompt]);
  });

  it('a question keeps the checkpoint open', async () => {
    const { app, task } = await refineOnly('sdlc-auto-refine-q-', { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'Change a.txt', assumptions: [] });

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['refine_prompt', 'open', null]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'hil.requested').length).toBe(1);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe(null);
  });

  it('a failed clarify keeps the checkpoint open: there is no suggestion to approve', async () => {
    const { app, task } = await refineOnly('sdlc-auto-refine-fail-', null);

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['refine_prompt', 'open', null]);
    expect(hil.payload.kind === 'refine_prompt' && hil.payload.clarifyError).toBe('fake failure');
  });
});

describe('an auto-approve GitHub may refuse', () => {
  /** A GitHub whose `pr view` does not say who opened the PR (an older `gh`, or a reply without the field). */
  class AuthorlessGitHub extends FakeGitHub {
    async prView(cwd: string, n: number) { const p = await super.prView(cwd, n); return { ...p, author: undefined }; }
  }
  /** A GitHub that is simply broken: nothing to do with who opened the pull request. */
  class BrokenReviewGitHub extends FakeGitHub {
    async postReview(): Promise<void> { throw new Error('gh api repos/test/repo/pulls/1/reviews failed: HTTP 503: Service unavailable'); }
  }

  it('an unknown PR author still auto-approves, and the refusal degrades to a comment instead of failing the task', async () => {
    const dir = tmpDir('sdlc-auto-own-unknown-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new AuthorlessGitHub(bare);
    const n = someonesPr(repo, gh, 'feature', 'tester');          // sdlc's own account, but `prView` does not say so
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);

    // the checkpoint is skipped as usual, and the approval nobody is watching is not allowed to break the run
    expect(app.store.openHilForTask(task.id)).toEqual([]);
    expect(app.store.listHil({ taskId: task.id }).map((h) => h.answeredVia)).toEqual(['auto']);
    expect(requested(app, task.id)).toEqual([]);
    expect(gh.reviews).toEqual([{ number: n, event: 'COMMENT', body: expect.stringContaining('cannot be submitted on a pull request opened by the same account'), comments: [] }]);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect([publish.status, publish.error]).toEqual(['succeeded', null]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'engine.warning').length).toBe(1);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('the account and the PR author are matched the way GitHub compares logins, whatever their case', async () => {
    const dir = tmpDir('sdlc-auto-own-case-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh, 'feature', 'tester');
    // the same account, written as GitHub displays it: the fake would accept the approval, the checkpoint must still open
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })), { repos: [{ name: 'r', path: repo, gh_user: 'Tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, hil.status, hil.answeredVia]).toEqual(['approve_result', 'open', null]);
    expect(gh.reviews).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
  });

  it('a refused request_changes degrades to a comment too, with its findings', async () => {
    const dir = tmpDir('sdlc-auto-own-rc-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, gh, 'feature', 'tester');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: FINDING }) })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    // a finding always asks the human; they keep the proposed verdict, which GitHub refuses on sdlc's own PR
    const hil = app.store.openHilForTask(task.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'approve', findings: { 'review:0': 'post' }, reviewEvent: 'request_changes' }, 'web');
    await app.engine.advance(task.id);

    expect(gh.reviews).toEqual([{ number: n, event: 'COMMENT', body: expect.stringContaining('the `request_changes` verdict cannot be submitted'), comments: [{ path: 'feature.txt', line: 2, body: expect.stringContaining('Wrong second line') }] }]);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect([publish.status, publish.resultText]).toEqual(['succeeded', expect.stringContaining('as COMMENT (REQUEST_CHANGES refused: own pull request)')]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'engine.warning').map((e) => (e.payload as { message: string }).message))
      .toEqual([`GitHub refused REQUEST_CHANGES on PR #${n} (sdlc opened it itself); posted the review as a comment instead`]);
  });

  it('any other GitHub failure still fails the phase: only the own-PR refusal is forgiven', async () => {
    const dir = tmpDir('sdlc-auto-publish-broken-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new BrokenReviewGitHub(bare);
    const n = someonesPr(repo, gh);                               // somebody else's PR: the auto-approve goes ahead
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: CLEAN }) })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);

    expect(app.store.listHil({ taskId: task.id }).filter((h) => h.kind === 'approve_result').map((h) => h.answeredVia)).toEqual(['auto']);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect(publish.status).toBe('failed');
    expect(publish.error).toContain('HTTP 503');
    expect(gh.reviews).toEqual([]);
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'engine.warning')).toEqual([]);
    // the failure is not degraded and not swallowed: it reaches the human as the escalation of the failed phase
    const esc = app.store.openHilForTask(task.id)[0]!;
    expect([esc.kind, esc.phaseRunId]).toEqual(['escalation', publish.id]);
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
  });
});
