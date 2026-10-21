import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CatchUpConflict, catchUpWithRemoteBranch } from '../../server/src/git/git.js';
import { commitOnRemote, makeRemoteRepo, sh, tmpDir } from '../helpers.js';

/** A real repository with a bare origin and a task branch that is pushed and then worked on locally. */
function setup(prefix: string, files: Record<string, string> = { 'a.txt': 'one\ntwo\nthree\n' }) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir, files);
  const branch = 'sdlc/t_x';
  sh(repo, ['checkout', '-q', '-b', branch]);
  sh(repo, ['push', '-q', '-u', 'origin', branch]);
  const commit = (file: string, content: string, msg: string) => {
    fs.writeFileSync(path.join(repo, file), content);
    sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', msg]);
    return sh(repo, ['rev-parse', 'HEAD']);
  };
  const subjects = () => sh(repo, ['log', '--format=%s', 'origin/main..HEAD']).split('\n').filter(Boolean);
  const run = () => catchUpWithRemoteBranch({ worktree: repo, remote: 'origin', branch });
  return { dir, repo, bare, branch, commit, subjects, run };
}

describe('catchUpWithRemoteBranch', () => {
  it('does nothing when there is no remote, the branch is not pushed, or the remote copy is behind', async () => {
    const dir = tmpDir('sdlc-catchup-none-');
    const { repo } = makeRemoteRepo(dir);
    sh(repo, ['checkout', '-q', '-b', 'sdlc/t_x']);
    expect(await catchUpWithRemoteBranch({ worktree: repo, remote: null, branch: 'sdlc/t_x' })).toMatchObject({ kind: 'no-remote' });
    expect(await catchUpWithRemoteBranch({ worktree: repo, remote: 'upstream', branch: 'sdlc/t_x' })).toMatchObject({ kind: 'no-remote' });
    // not on the remote yet: the first push creates it
    expect(await catchUpWithRemoteBranch({ worktree: repo, remote: 'origin', branch: 'sdlc/t_x' })).toMatchObject({ kind: 'not-pushed' });
    // another branch checked out: nothing safe to move
    sh(repo, ['checkout', '-q', 'main']);
    expect(await catchUpWithRemoteBranch({ worktree: repo, remote: 'origin', branch: 'sdlc/t_x' })).toMatchObject({ kind: 'not-checked-out' });

    const s = setup('sdlc-catchup-ahead-');
    expect(await s.run()).toMatchObject({ kind: 'up-to-date' });
    s.commit('mine.txt', 'mine\n', 'sdlc: mine');
    expect(await s.run()).toMatchObject({ kind: 'remote-behind' });   // a plain push fast-forwards the remote
  });

  it('fast-forwards when the branch has no unpushed commits of its own', async () => {
    const s = setup('sdlc-catchup-ff-');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    const r = await s.run();
    expect(r.kind).toBe('fast-forwarded');
    expect(r.incoming).toHaveLength(1);
    expect(r.incoming[0]).toContain('remote theirs.txt');
    expect(fs.existsSync(path.join(s.repo, 'theirs.txt'))).toBe(true);
    expect(sh(s.repo, ['rev-parse', 'HEAD'])).toBe(sh(s.repo, ['rev-parse', `origin/${s.branch}`]));
  });

  it('a diverged branch is rebased onto the remote: the outside commit is kept and the local commits are replayed', async () => {
    const s = setup('sdlc-catchup-rebase-');
    const before = s.commit('mine.txt', 'mine\n', 'sdlc: mine');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    const r = await s.run();
    expect(r.kind).toBe('rebased');
    expect(r.replayed).toHaveLength(1);
    expect(r.incoming[0]).toContain('remote theirs.txt');
    expect(r.note).toContain('rebased 1 unpushed commit(s)');
    // both files are in the worktree, the outside commit is the parent of the replayed one
    expect(fs.existsSync(path.join(s.repo, 'theirs.txt'))).toBe(true);
    expect(fs.existsSync(path.join(s.repo, 'mine.txt'))).toBe(true);
    expect(sh(s.repo, ['rev-parse', 'HEAD'])).not.toBe(before);
    expect(sh(s.repo, ['rev-parse', 'HEAD~1'])).toBe(sh(s.repo, ['rev-parse', `origin/${s.branch}`]));
    expect(s.subjects()).toEqual(['sdlc: mine', 'remote theirs.txt']);   // newest first
    // and now a push is a fast-forward
    sh(s.repo, ['push', '-q', 'origin', s.branch]);
    expect(await s.run()).toMatchObject({ kind: 'up-to-date' });
  });

  it('a conflicting rebase is aborted: the worktree is clean and the local commits are intact', async () => {
    const s = setup('sdlc-catchup-conflict-');
    const before = s.commit('a.txt', 'one\nMINE\nthree\n', 'sdlc: edit a');
    commitOnRemote(s.bare, s.branch, 'a.txt', 'one\nTHEIRS\nthree\n');
    await expect(s.run()).rejects.toThrow(/pushed from outside sdlc/);
    const err = await s.run().catch((e: Error) => e.message);
    expect(err).toContain('files in conflict:');
    expect(err).toContain('a.txt');
    expect(err).toContain('commits that came from outside');
    expect(err).toContain('remote a.txt');
    expect(err).toContain('sdlc: edit a');
    // nothing was lost and no rebase is in progress
    expect(sh(s.repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(s.repo, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8')).toBe('one\nMINE\nthree\n');
    expect(fs.existsSync(path.join(s.repo, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.existsSync(path.join(s.repo, '.git', 'rebase-apply'))).toBe(false);
  });

  it('a conflict is told apart from a failed fetch (network, auth), which is not the human\'s problem to resolve', async () => {
    const s = setup('sdlc-catchup-unreachable-');
    s.commit('a.txt', 'one\nMINE\nthree\n', 'sdlc: edit a');
    commitOnRemote(s.bare, s.branch, 'a.txt', 'one\nTHEIRS\nthree\n');
    await expect(s.run()).rejects.toBeInstanceOf(CatchUpConflict);
    fs.rmSync(s.bare, { recursive: true, force: true });
    const e = await s.run().catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CatchUpConflict);
    expect((e as Error).message).toContain('git fetch origin');
  });

  it('leaves a worktree with uncommitted work alone', async () => {
    const s = setup('sdlc-catchup-dirty-');
    s.commit('mine.txt', 'mine\n', 'sdlc: mine');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    fs.writeFileSync(path.join(s.repo, 'a.txt'), 'work in progress\n');
    expect(await s.run()).toMatchObject({ kind: 'dirty' });
    expect(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8')).toBe('work in progress\n');
    expect(fs.existsSync(path.join(s.repo, 'theirs.txt'))).toBe(false);
  });
});
