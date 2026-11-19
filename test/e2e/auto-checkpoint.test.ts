import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const CLEAN = { verdict: 'approve', summary: 'looks good', findings: [] };
const NITS = { verdict: 'approve', summary: 'good with nits', findings: [{ severity: 'nit', title: 'Naming', description: 'meh', file: 'feature.txt', line: 2 }] };
const FINDING = { verdict: 'request_changes', summary: 'one thing', findings: [{ severity: 'should_fix', title: 'Wrong second line', description: 'two should be 2', file: 'feature.txt', line: 2 }] };

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, gh: FakeGitHub, branch = 'feature'): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\ntwo\nthree\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.');
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
