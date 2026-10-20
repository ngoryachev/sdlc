import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const APPROVE = { verdict: 'approve', summary: 'ok', findings: [] };

/**
 * The way back into a delivered task that does not go through GitHub: the only one for a task without a PR,
 * and the only one for a comment written from the very account sdlc works with (those are filtered out of pr_feedback).
 */
describe('request changes by hand (fake runner + fake GitHub)', () => {
  it('quick: a delivered task goes back into the implement session, the fix lands in the existing PR', async () => {
    const dir = tmpDir('sdlc-rc-quick-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const calls: string[] = []; const prompts: Record<string, string> = {};
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        const mark = (name: string) => { calls.push(name); prompts[`${name}#${calls.filter((c) => c === name).length}`] = p; };
        if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: 'Change a.txt to y', assumptions: [] } };
        if (p.includes('requested changes to this task')) { mark('fix'); fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'handmade fix\n'); return { text: 'fixed' }; }
        if (p.includes('Phase: implement')) { mark('implement'); fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
        if (p.includes('Phase: self_check')) return { text: 'checked' };
        if (p.includes('Phase: test')) { mark('test'); return { structured: PASS }; }
        if (p.includes('Phase: review')) { mark('review'); return { structured: APPROVE }; }
        if (p.includes('Phase: QA')) { mark('qa'); return { structured: QA_OK }; }
        throw new Error('unexpected prompt: ' + p.slice(0, 80));
      },
    })), { max_loops: 0 }, gh);

    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick' });
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');   // refine
    await app.engine.advance(task.id);
    await app.engine.respondHil(app.store.openHilForTask(task.id)[0]!.id, { decision: 'approve' }, 'web');   // approve_result
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(gh.prs.size).toBe(1);
    const prNumber = app.store.getTask(task.id)!.prNumber!;
    const callsBefore = [...gh.calls];
    const implementSession = app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement').at(-1)!.sessionId;

    // the developer types a change request on the task page; no gh call is made to start it
    expect(await app.engine.requestChanges(task.id, 'also append a line about the flag')).toEqual({ phase: 'implement' });
    expect(app.store.getTask(task.id)!.status).toBe('running');
    expect(gh.calls).toEqual(callsBefore);
    // the request itself is in the task's history, so the restart is not an unexplained new implement round
    expect(app.events.replay(0, task.id).filter((e) => e.type === 'task.updated').map((e) => (e.payload as { change: string }).change)).toEqual(['changes requested → implement']);
    // while it runs, the background sync keeps its hands off: the task is not idle any more
    expect((await app.engine.syncTasks()).changes).toEqual([]);
    expect(app.store.getTask(task.id)!.status).toBe('running');

    await app.engine.advance(task.id);
    // implement continued its own session with the developer's text, not a fresh run of the phase prompt
    const impl = app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement');
    expect(impl).toHaveLength(2);
    expect(impl[1]!.resumedFromSessionId).toBe(implementSession);
    expect(prompts['fix#1']).toContain('also append a line about the flag');
    expect(prompts['fix#1']).not.toContain('Phase: implement');
    // commit → test → push into the same PR → review → checkpoint again
    expect(calls).toEqual(['implement', 'test', 'review', 'qa', 'fix', 'test', 'review']);
    expect(gh.prs.size).toBe(1);
    expect(gh.calls.filter((c) => c.startsWith('create #'))).toHaveLength(1);   // the one from the first round, not a second PR
    expect(sh(bare, ['show', `${app.store.getTask(task.id)!.branch}:a.txt`])).toContain('handmade fix');

    const hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_result');
    await app.engine.respondHil(hil.id, { decision: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(app.store.getTask(task.id)!.prNumber).toBe(prNumber);
  });

  it('auto: a succeeded task without a pull request runs again and finishes, GitHub is never touched', async () => {
    const dir = tmpDir('sdlc-rc-auto-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        prompts.push(p);
        if (p.includes('Phase: test')) return { structured: PASS };
        if (p.includes('Phase: review')) return { structured: APPROVE };
        if (p.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), `round ${prompts.length}\n`);
        return { text: 'ok' };
      },
    })));
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(app.store.getTask(task.id)!.prNumber).toBeNull();

    expect(await app.engine.requestChanges(task.id, 'mention the flag in a.txt')).toEqual({ phase: 'implement' });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    expect(prompts.filter((p) => p.includes('mention the flag in a.txt'))).toHaveLength(1);
    expect(sh(task.worktreePath, ['log', '--format=%s']).split('\n').length).toBeGreaterThan(1);

    // a second round is possible, and a request on a task that is not finished is refused
    await expect(app.engine.requestChanges(task.id, '   ')).rejects.toThrow(/empty/);
    const t = app.store.getTask(task.id)!; t.status = 'paused'; app.store.updateTask(t);
    await expect(app.engine.requestChanges(task.id, 'x')).rejects.toThrow(/task is paused/);
  });

  it('recreates a worktree that was cleaned up after delivery', async () => {
    const dir = tmpDir('sdlc-rc-worktree-');
    const { repo } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: review')) return { structured: APPROVE };
        if (spec.prompt.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'more\n');
        return { text: 'ok' };
      },
    })), {}, new FakeGitHub(path.join(dir, 'remote.git')));
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto' });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
    await app.engine.removeTaskWorktree(task.id);
    expect(fs.existsSync(path.join(task.worktreePath, '.git'))).toBe(false);

    await app.engine.requestChanges(task.id, 'one more line');
    await app.engine.advance(task.id);
    expect(fs.existsSync(path.join(task.worktreePath, '.git'))).toBe(true);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });
  it('fix-pr: a task that never ran implement takes the text as a fresh brief and pushes into the pull request', async () => {
    const dir = tmpDir('sdlc-rc-fixpr-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    // a pull request for a branch that is already on the remote, as `sdlc new --pr n --pipeline fix-pr` expects
    sh(repo, ['checkout', '-q', '-b', 'mine']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n');
    sh(repo, ['commit', '-q', '-am', 'mine: work']);
    sh(repo, ['push', '-q', 'origin', 'mine']);
    sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', 'mine']);
    const n = gh.openPr('mine', 'main', 'My change', 'body');
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        prompts.push(spec.prompt);
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: self_check')) return { text: 'checked' };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'handmade\n');
        return { text: 'done' };
      },
    })), {}, gh);

    const task = await app.engine.createTask({ repoPath: repo, pipeline: 'fix-pr', prNumber: n });
    await app.engine.settled(task.id);                 // the first poll finds no comments; the task just waits
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(prompts).toEqual([]);

    // a text that looks like a template and like a regexp replacement must reach the phase verbatim
    const text = 'drop {{task.prompt}} and keep $& as it is';
    expect(await app.engine.requestChanges(task.id, text)).toEqual({ phase: 'implement' });
    await app.engine.advance(task.id);

    const impl = app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement');
    expect(impl).toHaveLength(1);
    expect(impl[0]!.resumedFromSessionId).toBeNull();   // no session of this phase yet: the phase prompt plus the text
    expect(prompts[0]).toContain('Phase: implement');
    expect(prompts[0]).toContain(text);
    // the segment ends at the push: no review, no checkpoint, and the pull request is the one that was already there
    expect(app.store.phaseRunsForTask(task.id).filter((p) => p.status === 'succeeded').map((p) => p.phaseName)).toEqual(['implement', 'self_check', 'commit_impl', 'test', 'commit_tests', 'pr']);
    expect(app.store.getTask(task.id)!.status).toBe('pr_open');
    expect(gh.prs.size).toBe(1);
    expect(gh.calls).toEqual([]);                      // nothing on GitHub: no second PR and no "addressed the review comments"
    expect(sh(bare, ['show', 'mine:a.txt'])).toContain('handmade');
  });

  it('two rounds in a row continue the same implement session, and neither touches the task prompt', async () => {
    const dir = tmpDir('sdlc-rc-twice-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const prompts: string[] = [];
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        prompts.push(spec.prompt);
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: review')) return { structured: APPROVE };
        if (spec.prompt.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), `round ${prompts.length}\n`);
        return { text: 'ok' };
      },
    })));
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    const promptBefore = app.store.getTask(task.id)!.refinedPrompt;

    // `{{nope}}` is a canary: were the text rendered as a template anywhere, the phase would fail on an unknown variable
    for (const text of ['first {{nope}} round', 'second round']) {
      expect(await app.engine.requestChanges(task.id, text)).toEqual({ phase: 'implement' });
      await app.engine.advance(task.id);
      expect(app.store.getTask(task.id)!.status).toBe('succeeded');
      expect(prompts.filter((p) => p.includes(text))).toHaveLength(1);
    }
    const impl = app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement');
    expect(impl).toHaveLength(3);
    expect(impl[1]!.resumedFromSessionId).toBe(impl[0]!.sessionId);
    expect(impl[2]!.resumedFromSessionId).toBe(impl[1]!.sessionId);
    // the request is feedback for the implementer only: the prompt that test/review/qa read stays as the human wrote it
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe(promptBefore);
  });
});
