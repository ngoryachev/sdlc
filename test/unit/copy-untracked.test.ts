import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, sh, testApp, tmpDir } from '../helpers.js';
import { recreateWorktree } from '../../server/src/git/git.js';

const PASS = { verdict: 'pass', summary: 'ok', commands: [], tests_added: [], failures: [], notes: '' };
const QA_OK = { verdict: 'pass', summary: 'works', checks: [], issues: [] };
const APPROVE = { verdict: 'approve', summary: 'ok', findings: [] };

/**
 * A repo asking for `.env` in every worktree, with that file present in the main checkout. It is in `.gitignore`,
 * so a commit phase can never turn it into a tracked file that git itself would restore.
 */
function repoWithUntracked(prefix: string): { dir: string; repo: string } {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n', '.gitignore': '.env\n' }, 'copy_untracked: [.env]\n');
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
  return { dir, repo };
}

/** `copy_untracked` is a property of every worktree of the repository, not only of a freshly branched one. */
describe('copy_untracked', () => {
  it('reaches a worktree adopted for an existing branch', async () => {
    const { dir, repo } = repoWithUntracked('sdlc-copy-adopt-');
    sh(repo, ['checkout', '-q', '-b', 'handmade']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n');
    sh(repo, ['commit', '-q', '-am', 'flip a to y']);
    sh(repo, ['checkout', '-q', 'main']);

    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })));
    const task = await app.engine.createTask({ prompt: 'look at it', repoPath: repo, pipeline: 'auto', baseRemote: null, branch: 'handmade', startAt: 'end' });
    expect(task.branch).toBe('handmade');
    expect(fs.readFileSync(path.join(task.worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('reaches a worktree re-attached for a later round of changes', async () => {
    const { dir, repo } = repoWithUntracked('sdlc-copy-recreate-');
    const runner = new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: test')) return { structured: PASS };
        if (spec.prompt.includes('Phase: review')) return { structured: APPROVE };
        if (spec.prompt.includes('Phase: QA')) return { structured: QA_OK };
        fs.appendFileSync(path.join(spec.cwd, 'a.txt'), 'more\n');
        return { text: 'ok' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');

    expect(await app.engine.removeTaskWorktree(task.id)).toEqual({ removed: true });
    expect(fs.existsSync(path.join(task.worktreePath, '.env'))).toBe(false);

    await app.engine.requestChanges(task.id, 'rename the flag');   // ensureWorktree brings the worktree back
    expect(fs.readFileSync(path.join(task.worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('leaves a worktree that is still there alone, including a copy the phases edited', async () => {
    const { dir, repo } = repoWithUntracked('sdlc-copy-noop-');
    const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })));
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, startAt: 'end' });
    const wtEnv = path.join(task.worktreePath, '.env');
    expect(fs.readFileSync(wtEnv, 'utf8')).toBe('SECRET=1\n');
    fs.writeFileSync(wtEnv, 'SECRET=edited-in-the-worktree\n');

    await recreateWorktree({ repo, worktreePath: task.worktreePath, branch: task.branch, remote: null, copyUntracked: ['.env'] });
    expect(fs.readFileSync(wtEnv, 'utf8')).toBe('SECRET=edited-in-the-worktree\n');
  });
});
