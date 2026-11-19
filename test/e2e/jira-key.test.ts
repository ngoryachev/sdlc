import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRemoteRepo, makeRepo, sh, testApp, tmpDir } from '../helpers.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: ['a.test.js'], failures: [], notes: '' };

/** implement writes the change, test writes a test file: two commits, so both commit phases really commit. */
const workRunner = () => new FakeRunner((spec) => ({
  act: () => {
    const p = spec.prompt;
    if (p.includes('Phase: clarify')) return { structured: { questions: [], suggestedPrompt: '', assumptions: [] } };
    if (p.includes('Phase: self_check')) return { text: 'checked' };
    if (p.includes('Phase: test')) { fs.writeFileSync(path.join(spec.cwd, 'a.test.js'), 'ok\n'); return { structured: PASS }; }
    if (p.includes('Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
    throw new Error('unexpected prompt: ' + p.slice(0, 120));
  },
}));

/** Commit subjects the task added on top of main, oldest first. */
const subjects = (repo: string, branch: string) => sh(repo, ['log', '--reverse', '--format=%s', `main..${branch}`]).split('\n').filter(Boolean);

describe('jira key: branch, commit subjects, PR title', () => {
  it('a key in the prompt lands on the branch next to the slug, on every commit subject and on the PR title', async () => {
    const dir = tmpDir('sdlc-jira-key-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const runner = workRunner();
    runner.brief = async () => '{"title": "Add a flag", "branch": "Add A Flag"}';
    const app = testApp(dir, runner, {}, gh);

    const t = await app.engine.createTask({ prompt: 'ABC-123 add a flag, see also UTF-8', repoPath: repo, pipeline: 'quick', baseRemote: 'origin', startAt: 'implement', stopAfter: 'pr' });
    expect(t.jiraKey).toBe('ABC-123');
    expect(t.branch).toBe(`sdlc/ABC-123-${t.id}`);          // the key is on the branch before naming ever runs
    await app.engine.settled(t.id);
    await app.engine.advance(t.id);

    const after = app.store.getTask(t.id)!;
    expect(after.branch).toBe(`sdlc/ABC-123-add-a-flag-${t.id}`);
    expect(sh(after.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(after.branch);
    expect(subjects(repo, after.branch)).toEqual([`ABC-123 sdlc(${t.id}): Add a flag`, `ABC-123 sdlc(${t.id}): tests`]);
    expect(gh.prs.get(1)!.title).toBe('ABC-123 Add a flag');
    expect(after.title).toBe('Add a flag');                 // the stored title stays unprefixed
  });

  it('without a key nothing changes: plain branch, plain subjects, plain PR title', async () => {
    const dir = tmpDir('sdlc-jira-none-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, workRunner(), {}, gh);

    const t = await app.engine.createTask({ prompt: 'add a flag', repoPath: repo, pipeline: 'quick', baseRemote: 'origin', startAt: 'implement', stopAfter: 'pr' });
    await app.engine.settled(t.id);
    await app.engine.advance(t.id);

    const after = app.store.getTask(t.id)!;
    expect(after.jiraKey).toBeNull();
    expect(after.branch).toBe(`sdlc/${t.id}`);
    expect(subjects(repo, after.branch)).toEqual([`sdlc(${t.id}): add a flag`, `sdlc(${t.id}): tests`]);
    expect(gh.prs.get(1)!.title).toBe('add a flag');
  });

  it('a key that only the refined prompt carries is picked up and renames the branch', async () => {
    const dir = tmpDir('sdlc-jira-refine-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const app = testApp(dir, workRunner());

    const t = await app.engine.createTask({ prompt: 'add a flag', repoPath: repo, pipeline: 'quick', baseRemote: null, stopAfter: 'commit_impl' });
    await app.engine.advance(t.id);
    expect(app.store.getTask(t.id)!.branch).toBe(`sdlc/${t.id}`);

    const hil = app.store.openHilForTask(t.id)[0]!;
    expect(hil.kind).toBe('refine_prompt');
    await app.engine.respondHil(hil.id, { decision: 'approve', edited: { prompt: 'ZZ-9 add a flag' } }, 'web');
    await app.engine.advance(t.id);

    const after = app.store.getTask(t.id)!;
    expect(after.jiraKey).toBe('ZZ-9');
    expect(after.branch).toBe(`sdlc/ZZ-9-${t.id}`);
    expect(sh(after.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(after.branch);
    expect(subjects(repo, after.branch)).toEqual([`ZZ-9 sdlc(${t.id}): add a flag`]);
  });
});
