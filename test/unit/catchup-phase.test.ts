import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PhaseRun, TaskRole } from '@sdlc/shared';
import { catchUpBeforePush, catchUpTaskBranch } from '../../server/src/phases/catchup.js';
import type { PhaseContext } from '../../server/src/phases/executor.js';
import { commitOnRemote, makeRemoteRepo, sh, tmpDir } from '../helpers.js';

/** A task whose branch is pushed, has one unpushed sdlc commit and got a commit from outside on the remote. */
function divergedTask(prefix: string, role: TaskRole) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir);
  const branch = 'sdlc/t_x';
  sh(repo, ['checkout', '-q', '-b', branch]);
  sh(repo, ['push', '-q', '-u', 'origin', branch]);
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'sdlc: mine']);
  commitOnRemote(bare, branch, 'theirs.txt');
  const warnings: string[] = [];
  const ctx = {
    task: { id: 't_x', repoPath: repo, worktreePath: repo, branch, baseRemote: 'origin' },
    role,
    config: { git_author: 'SDLC <sdlc@local>' },
    accounts: { forRepo: async () => ({}) },
    events: { emit: (_t: string, p: { message: string }) => warnings.push(p.message) },
  } as unknown as PhaseContext;
  const pr = { id: 'pr_1' } as PhaseRun;
  return { repo, bare, branch, warnings, run: () => catchUpTaskBranch(ctx, pr), beforePush: () => catchUpBeforePush(ctx, pr) };
}

describe('catchUpTaskBranch', () => {
  it('leaves a reviewer task alone (a re-review resets its worktree to the remote branch itself)', async () => {
    const t = divergedTask('sdlc-catchup-reviewer-', 'reviewer');
    const head = sh(t.repo, ['rev-parse', 'HEAD']);
    await t.run();
    expect(sh(t.repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.existsSync(path.join(t.repo, 'theirs.txt'))).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it('rebases an author task onto the remote and says so', async () => {
    const t = divergedTask('sdlc-catchup-author-', 'author');
    await t.run();
    expect(fs.existsSync(path.join(t.repo, 'theirs.txt'))).toBe(true);
    expect(sh(t.repo, ['rev-parse', 'HEAD~1'])).toBe(sh(t.repo, ['rev-parse', `origin/${t.branch}`]));
    expect(t.warnings.join('\n')).toContain('rebased 1 unpushed commit(s)');
  });

  it('says why a push cannot be made fast-forward when the worktree still has uncommitted work', async () => {
    const t = divergedTask('sdlc-catchup-push-dirty-', 'author');
    fs.writeFileSync(path.join(t.repo, 'README.md'), 'work in progress\n');
    const head = sh(t.repo, ['rev-parse', 'HEAD']);
    await expect(t.beforePush()).rejects.toThrow(/uncommitted changes: commit or discard them/);
    expect(sh(t.repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.readFileSync(path.join(t.repo, 'README.md'), 'utf8')).toBe('work in progress\n');
  });
});
