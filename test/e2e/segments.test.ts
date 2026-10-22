import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, localHas, makeRemoteRepo, makeRepo, remoteHas, sh, testApp, tmpDir } from '../helpers.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };

/** A branch with one commit pushed to the remote and a pull request for it, as if a colleague opened it. */
function someonesPr(repo: string, bare: string, gh: FakeGitHub, branch = 'feature', files: Record<string, string> = { 'feature.txt': 'one\ntwo\nthree\n' }): number {
  sh(repo, ['checkout', '-q', '-b', branch]);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), c);
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', `${branch}: work`]);
  sh(repo, ['push', '-q', 'origin', branch]);
  sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', branch]);
  return gh.openPr(branch, 'main', 'Add the feature', 'Adds feature.txt.');
}

describe('segments, roles, granular checkpoints (fake runner + fake GitHub)', () => {
  it('stopAfter ends the task after the named phase', async () => {
    const dir = tmpDir('sdlc-seg-stop-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, new FakeRunner((spec) => ({ act: () => { if (spec.prompt.includes('Phase: implement')) fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'ok' }; } })));
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null, stopAfter: 'commit_impl' });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(app.store.phaseRunsForTask(task.id).map((p) => `${p.phaseName}:${p.status}`)).toEqual(['implement:succeeded', 'self_check:succeeded', 'commit_impl:succeeded']);
    await expect(app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, startAt: 'review', stopAfter: 'implement' })).rejects.toThrow(/ends .* before it starts/);
  });

  it('the prompt may be omitted on an existing branch after implement; a summary of the branch stands in', async () => {
    const dir = tmpDir('sdlc-seg-prompt-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    sh(repo, ['checkout', '-q', '-b', 'handmade']); fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n'); sh(repo, ['commit', '-q', '-am', 'flip a to y']); sh(repo, ['checkout', '-q', 'main']);
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({ act: () => { prompts.push(spec.prompt); return spec.prompt.includes('Phase: review') ? { structured: { verdict: 'approve', summary: 'fine', findings: [] } } : { structured: QA_OK }; } })));
    await expect(app.engine.createTask({ repoPath: repo, pipeline: 'auto', baseRemote: null })).rejects.toThrow(/prompt is required/);
    await expect(app.engine.createTask({ repoPath: repo, pipeline: 'auto', baseRemote: null, branch: 'handmade', startAt: 'implement' })).rejects.toThrow(/prompt is required/);
    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'auto', baseRemote: null, branch: 'handmade', startAt: 'review' });
    await app.engine.advance(task.id);
    expect(task.initialPrompt).toMatch(/No task description was given/);
    expect(task.initialPrompt).toContain('flip a to y');
    expect(prompts[0]).toContain('flip a to y');   // the review phase got the summary as the request
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('review-pr: reviews a pull request, the human posts some findings, new commits start a narrowed re-review', async () => {
    const dir = tmpDir('sdlc-seg-reviewer-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const findings = [
      { severity: 'blocking', title: 'Wrong second line', description: 'two should be 2', file: 'feature.txt', line: 2 },
      { severity: 'should_fix', title: 'README is stale', description: 'mention the feature', file: 'README.md', line: 1 },   // not part of the PR diff
      { severity: 'nit', title: 'Naming', description: 'meh' },
    ];
    const app = testApp(dir, new FakeRunner((spec) => ({ act: () => { prompts.push(spec.prompt); return { structured: { verdict: 'request_changes', summary: 'needs work', findings } }; } })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    expect(task.title).toBe('Add the feature');
    expect(task.initialPrompt).toBe('Add the feature\n\nAdds feature.txt.');
    expect([task.branch, task.baseBranch, task.prNumber]).toEqual(['feature', 'main', n]);
    expect(app.engine.roleOfTask(task.id)).toBe('reviewer');
    // the review asked for changes, but a reviewer task has nobody to send them to: straight to the checkpoint
    expect(prompts.length).toBe(1);
    let hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');
    expect(hil.payload.kind === 'approve_result' && [hil.payload.canFix, hil.payload.canPost, hil.payload.role]).toEqual([false, true, 'reviewer']);
    await expect(app.engine.respondHil(hil.id, { decision: 'request_changes', comment: 'fix it' }, 'web')).rejects.toThrow(/no implementing phase/);
    await expect(app.engine.respondHil(hil.id, { decision: 'approve', findings: { 'review:0': 'fix' } }, 'web')).rejects.toThrow(/no implementing phase/);
    expect(app.store.getHil(hil.id)!.status).toBe('open');

    await app.engine.respondHil(hil.id, { decision: 'approve', comment: 'Thanks, two things.', findings: { 'review:0': 'post', 'review:1': 'post', 'review:2': 'skip' }, reviewEvent: 'request_changes' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews.length).toBe(1);
    expect(gh.reviews[0]!.event).toBe('REQUEST_CHANGES');
    expect(gh.reviews[0]!.comments).toEqual([{ path: 'feature.txt', line: 2, body: expect.stringContaining('Wrong second line') }]);
    expect(gh.reviews[0]!.body).toContain('Thanks, two things.');
    expect(gh.reviews[0]!.body).toContain('README is stale');      // a line outside the diff cannot be an inline comment
    expect(gh.reviews[0]!.body).not.toContain('Naming');           // skipped by the human
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(app.store.phaseRunsForTask(task.id).some((p) => p.phaseName === 'qa' && p.status !== 'skipped')).toBe(false);   // the segment ends at publish

    // nothing new on GitHub: a sync changes nothing and no review comments are polled for a reviewer
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    await expect(app.engine.pollPrFeedback(task.id)).rejects.toThrow(/only reviews/);

    // the author pushes a fix: the next sync starts the review again, narrowed to the new commits
    const firstSha = app.store.getTask(task.id)!.prHeadSha!;
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    const sync = await app.engine.syncTasks();
    expect(sync.changes.map((c) => c.change)).toEqual([expect.stringMatching(/^new commits \(.+\) → review$/)]);
    await app.engine.advance(task.id);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('Repeat pass: check only what changed');
    expect(prompts[1]).toContain(`git diff ${firstSha}..HEAD`);
    expect(prompts[1]).toContain('Wrong second line');             // what the first pass reported
    expect(fs.readFileSync(path.join(task.worktreePath, 'feature.txt'), 'utf8')).toBe('one\n2\nthree\n');
    expect(app.store.getTask(task.id)!.prHeadSha).not.toBe(firstSha);
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');
    await app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews[1]).toEqual({ number: n, event: 'APPROVE', body: '', comments: [] });
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');

    // closing a reviewer task only stops tracking: the colleague's PR and branch are left alone, whatever is asked for
    const closed = await app.engine.closeTask(task.id, { closePr: true, deleteBranch: true });
    expect(closed.status).toBe('closed');
    expect(gh.calls.filter((c) => c.startsWith('close'))).toEqual([]);
    expect(gh.prs.get(n)!.state).toBe('OPEN');
    expect(localHas(repo, 'feature')).toBe(true);
    expect(remoteHas(bare, 'feature')).toBe(true);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('closed');

    // and new commits of the colleague no longer start a review: the task is out of the sync for good
    const phaseRuns = app.store.phaseRunsForTask(task.id).length;
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\nfour\n');
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('closed');
    expect(app.store.phaseRunsForTask(task.id).length).toBe(phaseRuns);
    expect(app.store.openHilForTask(task.id)).toEqual([]);
    expect(fs.existsSync(task.worktreePath)).toBe(false);
    expect(prompts.length).toBe(2);
    expect(gh.prs.get(n)!.state).toBe('OPEN');
  });

  it('review-pr: a clean review is approved on GitHub with nothing marked to post', async () => {
    const dir = tmpDir('sdlc-seg-approve-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'looks good', findings: [] } }) })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'approve_result' && [hil.payload.review?.findings.length, hil.payload.canPost, hil.payload.role]).toEqual([0, true, 'reviewer']);

    // no findings, no review text: the event alone is enough to publish
    await app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews).toEqual([{ number: n, event: 'APPROVE', body: '', comments: [] }]);
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!.status).toBe('succeeded');
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
  });

  it('review-pr: request changes with nothing to post is published; a plain comment with nothing to say is not', async () => {
    const dir = tmpDir('sdlc-seg-event-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const first = someonesPr(repo, bare, gh);
    const second = someonesPr(repo, bare, gh, 'feature2', { 'feature2.txt': 'a\nb\n' });
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'nothing to say', findings: [] } }) })), {}, gh);

    // request_changes is the human's own call: it is published even though the agent found nothing to report
    const t1 = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: first });
    await app.engine.advance(t1.id);
    await app.engine.respondHil(app.store.openHilForTask(t1.id)[0]!.id, { decision: 'approve', reviewEvent: 'request_changes' }, 'web');
    await app.engine.advance(t1.id);
    expect(gh.reviews).toEqual([{ number: first, event: 'REQUEST_CHANGES', body: '', comments: [] }]);
    expect(app.store.phaseRunsForTask(t1.id).find((p) => p.phaseName === 'publish')!.status).toBe('succeeded');

    // a comment event with no findings and no text would be an empty review: still skipped
    const t2 = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: second });
    await app.engine.advance(t2.id);
    await app.engine.respondHil(app.store.openHilForTask(t2.id)[0]!.id, { decision: 'approve', reviewEvent: 'comment' }, 'web');
    await app.engine.advance(t2.id);
    expect(gh.reviews.length).toBe(1);
    const publish = app.store.phaseRunsForTask(t2.id).find((p) => p.phaseName === 'publish')!;
    expect([publish.status, publish.resultText]).toEqual(['skipped', 'nothing marked to publish']);
  });

  it('review-pr: an approve event rides along with the findings the human still wants posted', async () => {
    const dir = tmpDir('sdlc-seg-approve-nits-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const findings = [
      { severity: 'nit', title: 'Naming', description: 'two could be clearer', file: 'feature.txt', line: 2 },
      { severity: 'nit', title: 'Changelog', description: 'worth a line', file: 'CHANGELOG.md', line: 1 },   // outside the PR diff
    ];
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'good with nits', findings } }) })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;

    // the event selector no longer hangs off the findings: approving while posting nits is one answer
    await app.engine.respondHil(hil.id, { decision: 'approve', comment: 'Nice, two nits.', findings: { 'review:0': 'post', 'review:1': 'post' }, reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews.length).toBe(1);
    expect(gh.reviews[0]!.event).toBe('APPROVE');
    expect(gh.reviews[0]!.comments).toEqual([{ path: 'feature.txt', line: 2, body: expect.stringContaining('Naming') }]);
    expect(gh.reviews[0]!.body).toContain('Nice, two nits.');
    expect(gh.reviews[0]!.body).toContain('Changelog');
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!.status).toBe('succeeded');
  });

  it('author: an approve event is never published on the task\u2019s own pull request', async () => {
    const dir = tmpDir('sdlc-seg-own-pr-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'Change a.txt to y', assumptions: [] } };
        if (p.includes('Phase: test')) return { structured: PASS };
        if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'good', findings: [] } };
        if (p.includes('Phase: QA')) return { structured: QA_OK };
        if (p.includes('Phase: self_check')) return { text: 'checked' };
        fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n');
        return { text: 'implemented' };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');   // refine
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'approve_result' && [hil.payload.review?.findings.length, hil.payload.canPost, hil.payload.role]).toEqual([0, true, 'author']);

    // the UI hides the event selector for an author, but a stale or hand-made body must not approve the author's own PR
    await app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews).toEqual([]);
    const publish = app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'publish')!;
    expect([publish.status, publish.resultText]).toEqual(['skipped', 'nothing marked to publish']);
  });

  it('review-pr: commits pushed while the reviewer waits at its checkpoint drop it as stale and review again', async () => {
    const dir = tmpDir('sdlc-seg-stale-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        prompts.push(spec.prompt);
        return { structured: { verdict: 'request_changes', summary: `pass ${prompts.length}`, findings: [{ severity: 'blocking', title: `Problem ${prompts.length}`, description: 'x', file: 'feature.txt', line: 2 }] } };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const stale = app.store.openHilForTask(task.id)[0]!;
    expect([stale.kind, app.store.getTask(task.id)!.status]).toEqual(['approve_result', 'waiting_hil']);
    expect(stale.payload.kind === 'approve_result' && stale.payload.supersedes).toBe(null);
    const firstSha = app.store.getTask(task.id)!.prHeadSha!;

    // the author pushes two commits while the checkpoint is still waiting for an answer
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\n3\n');
    const sync = await app.engine.syncTasks();
    expect(sync.changes.map((c) => c.change)).toEqual([expect.stringMatching(/^new commits \(.+\) → review \(stale checkpoint dropped\)$/)]);
    await app.engine.advance(task.id);

    const dropped = app.store.getHil(stale.id)!;
    expect([dropped.status, dropped.answeredVia, dropped.response]).toEqual(['cancelled', null, null]);   // not an answer from a human
    expect(dropped.summary).toContain('stale: the PR got 2 new commit(s)');
    expect(app.store.phaseRunsForTask(task.id).find((p) => p.phaseName === 'approve_result')!.status).toBe('skipped');
    // the review ran again, narrowed to what the two commits changed
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('Repeat pass: check only what changed');
    expect(prompts[1]).toContain(`git diff ${firstSha}..HEAD`);
    expect(fs.readFileSync(path.join(task.worktreePath, 'feature.txt'), 'utf8')).toBe('one\n2\n3\n');
    expect(app.store.getTask(task.id)!.prHeadSha).not.toBe(firstSha);
    // a fresh checkpoint is open and points at the one it replaces
    const fresh = app.store.openHilForTask(task.id)[0]!;
    expect([fresh.kind, fresh.status, fresh.id !== stale.id]).toEqual(['approve_result', 'open', true]);
    expect(fresh.payload.kind === 'approve_result' && fresh.payload.supersedes).toBe(stale.id);
    // an answer that arrives for the dropped checkpoint is refused, not applied to the new pass
    await expect(app.engine.respondHil(stale.id, { decision: 'approve', reviewEvent: 'approve' }, 'web')).rejects.toThrow(/already cancelled/);
    expect(gh.reviews).toEqual([]);
  });

  it('an answer racing the sync waits for it: the answer to a dropped checkpoint is refused, never published', async () => {
    const dir = tmpDir('sdlc-seg-race-');
    const { repo, bare } = makeRemoteRepo(dir);
    let gate: Promise<void> | null = null;
    class GatedGitHub extends FakeGitHub {
      async prView(cwd: string, n: number) { await gate; return super.prView(cwd, n); }
    }
    const gh = new GatedGitHub(bare);
    const n = someonesPr(repo, bare, gh);
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'request_changes', summary: 'needs work', findings: [{ severity: 'blocking', title: 'Wrong second line', description: 'two should be 2', file: 'feature.txt', line: 2 }] } }) })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    commitOnRemote(bare, 'feature', 'feature.txt', 'one\n2\nthree\n');

    let openGate!: () => void;
    gate = new Promise<void>((r) => { openGate = r; });
    const sync = app.engine.syncTasks();                                            // parked inside prView, holding the task lock
    const answer = app.engine.respondHil(hil.id, { decision: 'approve', reviewEvent: 'approve' }, 'web').then(() => 'applied', (e: Error) => e.message);
    openGate();
    await sync;
    expect(await answer).toMatch(/already cancelled/);
    await app.engine.advance(task.id);
    expect(gh.reviews).toEqual([]);                                                 // the approval was never turned into a GitHub review
    expect(app.store.openHilForTask(task.id)[0]!.id).not.toBe(hil.id);              // the human decides again, on the new head
  });

  it('an author waiting at its own checkpoint is left alone when the PR branch gets new commits', async () => {
    const dir = tmpDir('sdlc-seg-author-stale-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'change a', assumptions: [] } };
        if (p.includes('Phase: test')) return { structured: PASS };
        if (p.includes('Phase: review')) return { structured: { verdict: 'request_changes', summary: 'one thing', findings: [{ severity: 'blocking', title: 'Fix a', description: 'do it', file: 'a.txt', line: 1 }] } };
        if (p.includes('Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
        return { text: 'checked' };
      },
    })), { max_loops: 0 }, gh);

    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');   // refine
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    expect([hil.kind, app.engine.roleOfTask(task.id), app.store.getTask(task.id)!.prNumber]).toEqual(['approve_result', 'author', 1]);

    commitOnRemote(bare, app.store.getTask(task.id)!.branch, 'a.txt', 'someone else\n');
    expect((await app.engine.syncTasks()).changes).toEqual([]);            // the author side never re-reviews on new commits
    expect(app.store.getHil(hil.id)!.status).toBe('open');
    expect(app.store.getTask(task.id)!.status).toBe('waiting_hil');
  });

  it('fix-pr: waits for review comments, the human picks which to fix, the fix is pushed; new comments are polled', async () => {
    const dir = tmpDir('sdlc-seg-author-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    const n = someonesPr(repo, bare, gh, 'mine');
    gh.comment(n, { body: 'Please rename two to 2', path: 'feature.txt', line: 2 });
    gh.comment(n, { body: 'Also rewrite everything in Rust' });
    gh.comment(n, { body: 'my own note', author: 'tester' });            // the account sdlc works with: never feedback
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        prompts.push(spec.prompt);
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: self_check')) return { text: 'checked' };
        fs.writeFileSync(path.join(spec.cwd, 'feature.txt'), `one\n2\nthree\n${prompts.length}\n`);
        return { text: 'renamed' };
      },
    })), { repos: [{ name: 'r', path: repo, gh_user: 'tester' }] }, gh);   // the repo is worked on as "tester": that account's comments are not feedback

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'fix-pr', prNumber: n });
    await app.engine.settled(task.id);                                     // the first poll runs in the background
    expect(app.engine.roleOfTask(task.id)).toBe('author');
    expect(prompts).toEqual([]);                                           // nothing runs until a human takes comments into work
    let hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('pr_feedback');
    const comments = hil.payload.kind === 'pr_feedback' ? hil.payload.comments : [];
    expect(comments.map((c) => c.body)).toEqual(['Please rename two to 2', 'Also rewrite everything in Rust']);

    await app.engine.respondHil(hil.id, { decision: 'approve', comments: { [comments[1]!.id]: 'skip' } }, 'web');
    await app.engine.advance(task.id);
    expect(prompts[0]).toContain('Please rename two to 2');
    expect(prompts[0]).not.toContain('Rust');
    // implement → self_check → commit → test → commit_tests → push; the segment ends there: no review, no checkpoint
    expect(app.store.phaseRunsForTask(task.id).filter((p) => p.status === 'succeeded').map((p) => p.phaseName)).toEqual(['implement', 'self_check', 'commit_impl', 'test', 'commit_tests', 'pr']);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(sh(bare, ['show', 'mine:feature.txt'])).toContain('2');
    expect(gh.calls).toEqual([`comment #${n}`]);                           // reviewers are told once that their comments were addressed

    // a sync with nothing new is silent; a new comment opens the next checkpoint without anyone pressing a button
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    gh.comment(n, { body: 'One more thing: add a test' });
    expect((await app.engine.syncTasks()).changes.map((c) => c.change)).toEqual(['1 new PR comment(s) → HIL']);
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'pr_feedback' && hil.payload.comments.map((c) => c.body)).toEqual(['One more thing: add a test']);
    // every comment skipped: the task goes back to waiting, the comments do not come back
    await app.engine.respondHil(hil.id, { decision: 'approve', comments: Object.fromEntries((hil.payload.kind === 'pr_feedback' ? hil.payload.comments : []).map((c) => [c.id, 'skip' as const])) }, 'web');
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    await expect(app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'fix-pr' })).rejects.toThrow(/works on an existing pull request/);
  });

  it('quick: findings are fixed, posted or skipped one by one; fixes return straight to review, QA fixes straight to QA', async () => {
    const dir = tmpDir('sdlc-seg-granular-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const calls: string[] = []; const prompts: Record<string, string> = {};
    let reviews = 0; let qas = 0;
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        const mark = (name: string) => { calls.push(name); prompts[`${name}#${calls.filter((c) => c === name).length}`] = p; };
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'Change a.txt to y', assumptions: [] } };
        if (p.includes('Phase: implement')) { mark('implement'); fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
        if (p.includes('reviewed the result and requested changes')) { mark('fix'); fs.appendFileSync(path.join(spec.cwd, 'a.txt'), `fix ${calls.length}\n`); return { text: 'fixed' }; }
        if (p.includes('Phase: self_check')) return { text: 'checked' };
        if (p.includes('Phase: test')) { mark('test'); return { structured: PASS }; }
        if (p.includes('Phase: review')) {
          mark('review');
          return reviews++ === 0
            ? { structured: { verdict: 'request_changes', summary: 'two things', findings: [{ severity: 'blocking', title: 'Missing newline handling', description: 'handle it', file: 'a.txt', line: 1 }, { severity: 'should_fix', title: 'Document the change', description: 'say why', file: 'a.txt', line: 1 }] } }
            : { structured: { verdict: 'approve', summary: 'good now', findings: [{ severity: 'nit', title: 'Could be shorter', description: 'optional', file: 'a.txt', line: 1 }] } };
        }
        if (p.includes('Phase: QA')) { mark('qa'); return { structured: qas++ === 0 ? { verdict: 'issues', summary: 'one problem', checks: [], issues: [{ severity: 'blocking', title: 'Crashes on empty input', description: 'boom' }, { severity: 'nit', title: 'Slow start', description: 'meh' }] } : QA_OK }; }
        throw new Error('unexpected prompt: ' + p.slice(0, 80));
      },
    })), { max_loops: 0 }, gh);   // no automatic review → implement rounds: the human decides

    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');   // refine
    await app.engine.advance(task.id);

    // checkpoint 1: fix the first finding, leave the second
    let hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'approve_result' && hil.payload.review?.findings.length).toBe(2);
    await app.engine.respondHil(hil.id, { decision: 'request_changes', findings: { 'review:0': 'fix', 'review:1': 'skip' } }, 'web');   // no comment needed when something is marked
    await app.engine.advance(task.id);
    expect(prompts['fix#1']).toContain('Missing newline handling');
    expect(prompts['fix#1']).not.toContain('Document the change');
    expect(prompts['fix#1']).toContain('deliberately skipped');
    // straight back to review, which looks only at the fix
    expect(calls).toEqual(['implement', 'test', 'review', 'fix', 'review']);
    expect(prompts['review#2']).toContain('Repeat pass: check only what changed');
    expect(prompts['review#1']).not.toContain('Repeat pass');

    // checkpoint 2: post the nit to the PR and move on
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'approve_result' && hil.payload.review?.findings.map((f) => f.title)).toEqual(['Could be shorter']);
    await app.engine.respondHil(hil.id, { decision: 'approve', findings: { 'review:0': 'post' }, reviewEvent: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(gh.reviews).toEqual([{ number: 1, event: 'COMMENT', body: '', comments: [{ path: 'a.txt', line: 1, body: expect.stringContaining('Could be shorter') }] }]);   // own PR: only a comment, whatever was asked

    // QA found issues: its gate decides on QA issues, and the fix goes commit → push → QA, without test and review
    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.payload.kind === 'approve_result' && [hil.payload.focus, hil.payload.canPost]).toEqual(['qa', false]);
    await app.engine.respondHil(hil.id, { decision: 'request_changes', findings: { 'qa:0': 'fix' } }, 'web');
    await app.engine.advance(task.id);
    expect(prompts['fix#2']).toContain('Crashes on empty input');
    expect(prompts['fix#2']).not.toContain('Slow start');
    expect(calls).toEqual(['implement', 'test', 'review', 'fix', 'review', 'qa', 'fix', 'qa']);
    expect(prompts['qa#2']).toContain('Repeat pass: check only what changed');
    expect(gh.reviews.length).toBe(1);                                   // the findings were not posted a second time
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(sh(bare, ['show', `${app.store.getTask(task.id)!.branch}:a.txt`]).split('\n').length).toBe(3);   // both fixes reached the PR
  });

  it('recheck_scope: full repeats the whole check', async () => {
    const dir = tmpDir('sdlc-seg-full-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const prompts: string[] = []; let tests = 0;
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: test')) { prompts.push(spec.prompt); return { structured: tests++ === 0 ? { ...PASS, verdict: 'fail', failures: [{ title: 'bug', description: 'd' }] } : PASS }; }
        if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
        if (spec.prompt.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'more\n');
        return { text: 'ok' };
      },
    })), { recheck_scope: 'full' });
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(prompts.length).toBe(2);
    expect(prompts[1]).not.toContain('Repeat pass');
  });
});
