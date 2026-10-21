import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CatchUpConflict, catchUpWithRemoteBranch, taskCommitCount } from '../../server/src/git/git.js';
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
  // the author is what the phase passes from the config, like every other commit sdlc writes
  const run = () => catchUpWithRemoteBranch({ worktree: repo, remote: 'origin', branch, author: 'SDLC <sdlc@local>' });
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

  it('replays the task commits on a non-conflicting edit of the same file, trailers and all', async () => {
    const s = setup('sdlc-catchup-same-file-');
    s.commit('a.txt', 'one\ntwo\nMINE\n', 'sdlc: edit the end\n\nTask: t_x');   // sdlc touched the last line
    commitOnRemote(s.bare, s.branch, 'a.txt', 'THEIRS\ntwo\nthree\n');            // someone else the first one
    expect((await s.run()).kind).toBe('rebased');
    expect(fs.readFileSync(path.join(s.repo, 'a.txt'), 'utf8')).toBe('THEIRS\ntwo\nMINE\n');
    expect(sh(s.repo, ['status', '--porcelain'])).toBe('');
    // the replayed commit keeps its `Task:` trailer, so land/close still see the task's own work
    expect(await taskCommitCount(s.repo, s.branch, 't_x')).toBe(1);
  });

  it('rebases with no git identity configured: sdlc commits never need one', async () => {
    const s = setup('sdlc-catchup-no-identity-');
    s.commit('mine.txt', 'mine\n', 'sdlc: mine');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    // the service may run without user.name/user.email anywhere: the catch-up passes config.git_author, like commitAll
    const saved = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_SYSTEM = '/dev/null';
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
    try {
      expect((await s.run()).kind).toBe('rebased');
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(fs.existsSync(path.join(s.repo, 'theirs.txt'))).toBe(true);
    expect(sh(s.repo, ['status', '--porcelain'])).toBe('');
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

  // git refuses before it ever gets to a patch: there is nothing for a human to merge, so it must not read as a conflict
  it('reports a plain failure, not a conflict, when an untracked file blocks the fast-forward', async () => {
    const s = setup('sdlc-catchup-ff-blocked-');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    fs.writeFileSync(path.join(s.repo, 'theirs.txt'), 'untracked leftover\n');
    const e = await s.run().then(() => null, (err) => err);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CatchUpConflict);
    expect((e as Error).message).toContain('could not be fast-forwarded to origin/' + s.branch);
    expect((e as Error).message).toContain('1 commit(s) pushed from outside sdlc');
    expect((e as Error).message).not.toContain('Resolve it by hand');
    expect(sh(s.repo, ['rev-parse', 'HEAD'])).toBe(sh(s.repo, ['rev-parse', `origin/${s.branch}^`]));
    expect(fs.readFileSync(path.join(s.repo, 'theirs.txt'), 'utf8')).toBe('untracked leftover\n');
  });

  it('reports a plain failure, not a conflict, when an untracked file blocks the rebase, and leaves no rebase in progress', async () => {
    const s = setup('sdlc-catchup-rebase-blocked-');
    const mine = s.commit('mine.txt', 'mine\n', 'sdlc: mine');
    commitOnRemote(s.bare, s.branch, 'theirs.txt');
    fs.writeFileSync(path.join(s.repo, 'theirs.txt'), 'untracked leftover\n');
    const e = await s.run().then(() => null, (err) => err);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CatchUpConflict);
    expect((e as Error).message).toContain('could not be rebased onto origin/' + s.branch);
    expect((e as Error).message).not.toContain('files in conflict');
    // the branch is still checked out at its own commit, no rebase left half-done, nothing lost
    expect(sh(s.repo, ['rev-parse', 'HEAD'])).toBe(mine);
    expect(sh(s.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(s.branch);
    expect(sh(s.repo, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    expect(fs.existsSync(path.join(s.repo, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.existsSync(path.join(s.repo, '.git', 'rebase-apply'))).toBe(false);
  });
});
