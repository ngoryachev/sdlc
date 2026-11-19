import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@sdlc/shared';
import { statusView } from '../../ui/src/pages/Dashboard.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, makeRemoteRepo, sh, testApp, tmpDir } from '../helpers.js';

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

/** An author-role task with an open pull request, the state the dashboard shows an approval for. */
async function setup(prefix: string) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const gh = new FakeGitHub(bare);
  const app = testApp(dir, fileRunner(), {}, gh);
  const created = await app.engine.createTask({ prompt: 'task a', repoPath: repo, pipeline: 'auto', baseRemote: 'origin', baseBranch: 'main' });
  await app.engine.advance(created.id);
  const t = await app.engine.createPrForTask(created.id);
  expect(t).toMatchObject({ status: 'pr_open', prNumber: 1 });
  const task = () => app.store.getTask(created.id)!;
  const sync = async () => (await app.engine.syncTasks()).changes.map((c) => c.change);
  return { bare, gh, app, id: created.id, branch: t.branch, task, sync };
}

describe('GitHub approval on a task with an open PR', () => {
  it('records an approval, keeps quiet afterwards, and drops it once the PR head moves', async () => {
    const { bare, gh, branch, task, sync } = await setup('sdlc-approve-');
    expect(task()).toMatchObject({ reviewDecision: null, reviewDecisionSha: null });

    // nothing reviewed yet: no mark, nothing to report
    expect(await sync()).toEqual([]);

    gh.setReviewDecision(1, 'APPROVED');
    expect(await sync()).toEqual(['approved on GitHub']);
    const head = (await gh.prView('', 1)).headRefOid;
    expect(task()).toMatchObject({ reviewDecision: 'APPROVED', reviewDecisionSha: head, status: 'pr_open' });

    // same state on GitHub: the sync stays silent
    expect(await sync()).toEqual([]);

    // the author pushes: GitHub still says APPROVED, sdlc stops showing the mark
    commitOnRemote(bare, branch, 'more.txt');
    expect(await sync()).toEqual(['approval dropped (new commits)']);
    expect(task()).toMatchObject({ reviewDecision: null, reviewDecisionSha: head });
    expect((await gh.prView('', 1)).reviewDecision).toBe('APPROVED');

    // and it stays dropped, quietly
    expect(await sync()).toEqual([]);
    expect(task().reviewDecision).toBeNull();
  });

  it('changes requested clears the mark; a later approval sets it again', async () => {
    const { gh, task, sync } = await setup('sdlc-approve-again-');
    gh.setReviewDecision(1, 'APPROVED');
    expect(await sync()).toEqual(['approved on GitHub']);

    gh.setReviewDecision(1, 'CHANGES_REQUESTED');
    expect(await sync()).toEqual(['approval dropped (CHANGES_REQUESTED on GitHub)']);
    expect(task()).toMatchObject({ reviewDecision: 'CHANGES_REQUESTED', reviewDecisionSha: null });

    gh.setReviewDecision(1, 'APPROVED');
    expect(await sync()).toEqual(['approved on GitHub']);
    expect(task().reviewDecision).toBe('APPROVED');
  });

  it('is recorded for a reviewer-role task too', async () => {
    const dir = tmpDir('sdlc-approve-reviewer-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    // someone else's pull request, the kind a review-pr task works on
    sh(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\n');
    sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'feature: work']); sh(repo, ['push', '-q', 'origin', 'feature']);
    sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', 'feature']);
    const n = gh.openPr('feature', 'main', 'Add the feature');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'looks good', findings: [] } }) })), {}, gh);

    const t = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(t.id);
    await app.engine.respondHil(app.store.openHilForTask(t.id)[0]!.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(t.id);
    expect(app.store.getTask(t.id)!.status).toBe('pr_open');

    gh.setReviewDecision(n, 'APPROVED');
    expect((await app.engine.syncTasks()).changes.map((c) => c.change)).toEqual(['approved on GitHub']);
    expect(app.store.getTask(t.id)!.reviewDecision).toBe('APPROVED');
    expect((await app.engine.syncTasks()).changes).toEqual([]);
  });

  it('a review decision that is not an approval is persisted without a sync note', async () => {
    const { gh, task, sync } = await setup('sdlc-approve-required-');
    gh.setReviewDecision(1, 'REVIEW_REQUIRED');
    expect(await sync()).toEqual([]);
    expect(task()).toMatchObject({ reviewDecision: 'REVIEW_REQUIRED', reviewDecisionSha: null });
  });
});

describe('GitHub approval, further cases', () => {
  it('announces the approval and its drop as task.updated, with the task in the payload', async () => {
    const { bare, app, gh, id, branch, sync } = await setup('sdlc-approve-events-');
    gh.setReviewDecision(1, 'APPROVED');
    await sync();
    commitOnRemote(bare, branch, 'more.txt');
    await sync();

    const updates = app.events.replay(0, id).filter((e) => e.type === 'task.updated');
    expect(updates.map((e) => (e.payload as { change: string }).change).slice(-2)).toEqual(['approved on GitHub', 'approval dropped (new commits)']);
    // the dashboard re-renders from the event alone, so it has to carry the new field
    expect((updates.at(-2)!.payload as { task: Task }).task.reviewDecision).toBe('APPROVED');
    expect((updates.at(-1)!.payload as { task: Task }).task.reviewDecision).toBeNull();
    // a silent sync emits nothing
    const before = app.events.replay(0, id).length;
    expect(await sync()).toEqual([]);
    expect(app.events.replay(0, id).length).toBe(before);
  });

  it('treats the empty reviewDecision GitHub returns for an unreviewed PR as no review', async () => {
    const { gh, task, sync } = await setup('sdlc-approve-empty-');
    gh.reviewDecisions.set(1, '');                        // what `gh pr view --json reviewDecision` prints when nobody reviewed
    expect(await sync()).toEqual([]);
    expect(task()).toMatchObject({ reviewDecision: null, reviewDecisionSha: null });

    gh.setReviewDecision(1, 'APPROVED');
    expect(await sync()).toEqual(['approved on GitHub']);
    gh.reviewDecisions.set(1, '');                        // the review was dismissed on GitHub
    expect(await sync()).toEqual(['approval dropped (no review on GitHub)']);
    expect(task()).toMatchObject({ reviewDecision: null, reviewDecisionSha: null });
  });

  it('still follows an approved PR to merged, and the approval does not survive as a chip', async () => {
    const { gh, app, id, task, sync } = await setup('sdlc-approve-merged-');
    gh.setReviewDecision(1, 'APPROVED');
    expect(await sync()).toEqual(['approved on GitHub']);
    expect(statusView(task()).label).toBe('approved');

    await app.engine.landTask(id, 'merge');
    expect(task().status).toBe('merged');
    expect(await sync()).toEqual([]);
    expect(statusView(task()).label).toBe('merged');
  });

  it('reports the approval together with the new PR comments the same sync picked up', async () => {
    const { gh, task, sync } = await setup('sdlc-approve-plus-feedback-');
    gh.setReviewDecision(1, 'APPROVED');
    gh.comment(1, { body: 'one nit left' });
    expect(await sync()).toEqual(['approved on GitHub; 1 new PR comment(s) → HIL']);
    expect(task().reviewDecision).toBe('APPROVED');
  });
});

describe('GitHub approval on a reviewer-role task', () => {
  it('drops the mark and starts the re-review in the same sync, reporting both', async () => {
    const dir = tmpDir('sdlc-approve-reviewer-push-');
    const { repo, bare } = makeRemoteRepo(dir);
    const gh = new FakeGitHub(bare);
    sh(repo, ['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'one\n');
    sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'feature: work']); sh(repo, ['push', '-q', 'origin', 'feature']);
    sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', 'feature']);
    const n = gh.openPr('feature', 'main', 'Add the feature');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: { verdict: 'approve', summary: 'looks good', findings: [] } }) })), {}, gh);

    const t = await app.engine.createTask({ repoPath: repo, pipeline: 'review-pr', prNumber: n });
    await app.engine.advance(t.id);
    await app.engine.respondHil(app.store.openHilForTask(t.id)[0]!.id, { decision: 'approve', reviewEvent: 'approve' }, 'web');
    await app.engine.advance(t.id);

    gh.setReviewDecision(n, 'APPROVED');
    expect((await app.engine.syncTasks()).changes.map((c) => c.change)).toEqual(['approved on GitHub']);

    // the author pushes: the stale approval goes and the re-review starts, both in one sync
    commitOnRemote(bare, 'feature', 'two.txt');
    const notes = (await app.engine.syncTasks()).changes.map((c) => c.change);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^approval dropped \(new commits\); new commits \([0-9a-f]{7}\) → review$/);
    expect(app.store.getTask(t.id)!.reviewDecision).toBeNull();
  });
});
