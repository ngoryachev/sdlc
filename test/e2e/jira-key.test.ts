import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { taskLinks } from '../../server/src/engine/links.js';
import { makeRemoteRepo, makeRepo, remoteHas, sh, testApp, tmpDir } from '../helpers.js';

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

/** auto runs review and qa too: one runner that answers every phase of it. */
const autoRunner = () => new FakeRunner((spec) => ({
  act: () => {
    const p = spec.prompt;
    if (p.includes('Phase: test')) return { structured: PASS };
    if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    if (p.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
    if (p.includes('Phase: self_check')) return { text: 'checked' };
    fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n');
    return { text: 'implemented' };
  },
}));

describe('jira key: the other places a key can reach', () => {
  it('prefixes a custom pipeline commit message and PR title, and never prefixes twice', async () => {
    const dir = tmpDir('sdlc-jira-custom-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const root = path.join(dir, 'sdlc');
    fs.mkdirSync(path.join(root, 'pipelines'), { recursive: true });
    // templates a user could write: one without the key, one that already renders it through {{task.jira_key}}
    fs.writeFileSync(path.join(root, 'pipelines/custom.yaml'), `name: custom
phases:
  - name: make
    type: shell
    command: "printf one > one.txt"
  - name: c1
    type: git
    git: commit
    message: "custom({{task.id}}): {{task.title}}"
  - name: make2
    type: shell
    command: "printf two > two.txt"
  - name: c2
    type: git
    git: commit
    message: "{{task.jira_key}} second commit"
  - name: open_pr
    type: git
    git: pr
    pr:
      title: "[custom] {{task.title}}"
`);
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })), { pipelines_dirs: [path.join(root, 'pipelines')] }, gh);

    const t = await app.engine.createTask({ prompt: 'Add a flag\n\nTracked in ABC-123.', repoPath: repo, pipeline: 'custom', baseRemote: 'origin' });
    await app.engine.advance(t.id);

    const after = app.store.getTask(t.id)!;
    expect(after.jiraKey).toBe('ABC-123');
    expect(after.title).toBe('Add a flag');
    expect(subjects(repo, after.branch)).toEqual([`ABC-123 custom(${t.id}): Add a flag`, 'ABC-123 second commit']);
    expect(gh.prs.get(1)!.title).toBe('ABC-123 [custom] Add a flag');
  });

  it('prefixes the title of a pull request opened by hand and leaves the stored title alone', async () => {
    const dir = tmpDir('sdlc-jira-manual-pr-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, autoRunner(), {}, gh);

    const t = await app.engine.createTask({ prompt: 'Add a flag, tracked in ABC-123', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await app.engine.advance(t.id);
    const withPr = await app.engine.createPrForTask(t.id, { title: 'Add a flag' });

    expect(gh.prs.get(1)!.title).toBe('ABC-123 Add a flag');
    expect(withPr.title).toBe('Add a flag');
    expect(app.store.getTask(t.id)!.title).toBe('Add a flag');

    const t2 = await app.engine.createTask({ prompt: 'Flip b, tracked in ABC-123', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await app.engine.advance(t2.id);
    await app.engine.createPrForTask(t2.id, { title: 'ABC-123 Flip b' });
    expect(gh.prs.get(2)!.title).toBe('ABC-123 Flip b');          // the key the human typed is not doubled
  });

  it('carries the key into the merge commit when a task is landed without a pull request', async () => {
    const dir = tmpDir('sdlc-jira-land-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, autoRunner(), {}, gh);

    const t = await app.engine.createTask({ prompt: 'Add a flag\n\nTracked in ABC-123.', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await app.engine.advance(t.id);
    expect(app.store.getTask(t.id)!.title).toBe('Add a flag');     // the title alone does not carry the key
    const r = await app.engine.landTask(t.id, 'squash');

    expect(r.via).toBe('local');                                   // no PR: sdlc writes the merge commit itself
    expect(sh(bare, ['log', '-1', '--format=%s', 'main'])).toBe('ABC-123 Add a flag');
  });

  it('never renames a branch sdlc adopted, however the pull request mentions a key', async () => {
    const dir = tmpDir('sdlc-jira-adopted-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    sh(repo, ['checkout', '-q', '-b', 'mine']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n');
    sh(repo, ['commit', '-q', '-am', 'mine: work']);
    sh(repo, ['push', '-q', 'origin', 'mine']);
    sh(repo, ['checkout', '-q', 'main']); sh(repo, ['branch', '-q', '-D', 'mine']);
    const n = gh.openPr('mine', 'main', 'My change', 'Tracked in ABC-123.');
    // the adopted branch already carries a.txt: this task writes its own files, so both commit phases commit
    const app = testApp(dir, new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: test')) { fs.writeFileSync(path.join(spec.cwd, 'b.test.js'), 'ok\n'); return { structured: PASS }; }
        if (spec.prompt.includes('Phase: self_check')) return { text: 'checked' };
        fs.writeFileSync(path.join(spec.cwd, 'b.txt'), 'flag\n');
        return { text: 'implemented' };
      },
    })), {}, gh);

    const t = await app.engine.createTask({ repoPath: repo, pipeline: 'fix-pr', prNumber: n });
    await app.engine.settled(t.id);
    expect(app.store.getTask(t.id)!.jiraKey).toBe('ABC-123');
    expect(app.store.getTask(t.id)!.branch).toBe('mine');
    expect(sh(t.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mine');

    await app.engine.requestChanges(t.id, 'add a flag');
    await app.engine.advance(t.id);
    expect(app.store.getTask(t.id)!.branch).toBe('mine');
    expect(gh.prs.size).toBe(1);                                   // the PR that was already there, no new one
    expect(subjects(bare, 'mine')).toEqual(['mine: work', `ABC-123 sdlc(${t.id}): implement (attempt 1)`, `ABC-123 sdlc(${t.id}): tests`]);
  });
});

/**
 * A bare repository at a local path that nevertheless matches a GitHub URL (`…/github.com/me/shop.git`): pushes still
 * go nowhere but the filesystem, while `repoSlug` is `me/shop`, which is what the branch link needs to exist at all.
 */
function makeSlugRepo(dir: string, files: Record<string, string>): { repo: string; bare: string } {
  const repo = makeRepo(dir, files);
  const bare = path.join(dir, 'github.com', 'me', 'shop.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, ['remote', 'add', 'origin', bare]);
  sh(repo, ['push', '-q', '-u', 'origin', 'main']);
  return { repo, bare };
}

describe('jira key: the links in the pull request body', () => {
  it('carries the issue and the branch when the repository has a jira_url and the prompt a key', async () => {
    const dir = tmpDir('sdlc-jira-links-');
    const { repo, bare } = makeSlugRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, workRunner(), { repos: [{ name: 'shop', path: repo, gh_user: 'tester', jira_url: 'https://x.atlassian.net/' }] }, gh);

    const t = await app.engine.createTask({ prompt: 'ABC-123 add a flag', repoPath: repo, pipeline: 'quick', baseRemote: 'origin', startAt: 'implement', stopAfter: 'pr' });
    await app.engine.settled(t.id);
    await app.engine.advance(t.id);

    const after = app.store.getTask(t.id)!;
    expect(after.repoSlug).toBe('me/shop');
    const body = gh.prs.get(1)!.body;
    expect(body).toContain('https://x.atlassian.net/browse/ABC-123');     // the trailing slash of the config value is normalised away
    expect(body).toContain(`https://github.com/me/shop/tree/${after.branch}`);
  });

  /** The branch link must not outlive the branch; this is the flow that deletes it, so the event the link reads has to be there. */
  it('drops the branch link once landing has deleted the branch', async () => {
    const dir = tmpDir('sdlc-jira-links-landed-');
    const { repo, bare } = makeSlugRepo(dir, { 'a.txt': 'x\n' });
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, autoRunner(), { repos: [{ name: 'shop', path: repo, gh_user: 'tester', jira_url: 'https://x.atlassian.net' }] }, gh);

    const t = await app.engine.createTask({ prompt: 'ABC-123 add a flag', repoPath: repo, pipeline: 'auto', baseRemote: 'origin' });
    await app.engine.advance(t.id);
    const withPr = await app.engine.createPrForTask(t.id, { title: 'Add a flag' });
    expect(taskLinks(app, withPr).branchUrl).toBe(`https://github.com/me/shop/tree/${withPr.branch}`);

    await app.engine.landTask(t.id, 'merge');
    const landed = app.store.getTask(t.id)!;
    expect(landed.status).toBe('merged');
    expect(remoteHas(bare, landed.branch)).toBe(false);
    expect(taskLinks(app, landed).branchUrl).toBeNull();      // the Telegram card for the merge would have offered a 404
    expect(taskLinks(app, landed).jiraUrl).toBe('https://x.atlassian.net/browse/ABC-123');   // the issue outlives the branch
  });

  it('leaves the body exactly as it was for a repository without jira_url and a prompt without a key', async () => {
    const dir = tmpDir('sdlc-jira-links-none-');
    const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'x\n' });   // a local bare origin: no slug, so no branch link either
    const gh = new FakeGitHub(bare);
    const app = testApp(dir, workRunner(), {}, gh);

    const t = await app.engine.createTask({ prompt: 'add a flag', repoPath: repo, pipeline: 'quick', baseRemote: 'origin', startAt: 'implement', stopAfter: 'pr' });
    await app.engine.settled(t.id);
    await app.engine.advance(t.id);

    const body = gh.prs.get(1)!.body;
    expect(body).not.toContain('/browse/');
    expect(body).not.toContain('/tree/');
    // the two optional lines left no blank line behind: the footer follows the last section as it always did
    expect(body).toContain(`</details>\n\n---\nGenerated by sdlc · task \`${t.id}\``);
  });
});
