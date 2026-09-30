import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';

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
