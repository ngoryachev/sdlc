import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { commitOnRemote, makeRemoteRepo, sh, testApp, tmpDir } from '../helpers.js';
import type { ClaudeRunSpec } from '../../server/src/claude/runner.js';

const TEST_OK = { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' };

/**
 * A task branch that is pushed, carries one unpushed sdlc commit, and got a commit from outside sdlc on the remote:
 * the branch and `origin/<branch>` have diverged, so a plain `git push` would be rejected.
 */
function diverged(prefix: string, mine: { file: string; content: string }, theirs: { file: string; content: string }) {
  const dir = tmpDir(prefix);
  const { repo, bare } = makeRemoteRepo(dir, { 'a.txt': 'one\ntwo\nthree\n' });
  const branch = 'feature';
  sh(repo, ['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'shared\n');
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'feature: shared base']);
  fs.writeFileSync(path.join(repo, mine.file), mine.content);
  sh(repo, ['add', '-A']); sh(repo, ['commit', '-q', '-m', 'sdlc: my unpushed commit']);
  sh(repo, ['push', '-q', 'origin', `${branch}~1:refs/heads/${branch}`]);   // only the shared base is on the remote
  sh(repo, ['checkout', '-q', 'main']);
  commitOnRemote(bare, branch, theirs.file, theirs.content);                 // someone pushes from another machine
  const gh = new FakeGitHub(bare);
  const seen: ClaudeRunSpec[] = [];
  const runner = new FakeRunner((spec) => ({
    act: () => {
      seen.push(spec);
      if (spec.prompt.includes('Phase: test')) return { structured: TEST_OK };
      if (spec.prompt.includes('Phase: self_check')) return { text: 'ok' };
      fs.writeFileSync(path.join(spec.cwd, 'implemented.txt'), 'work\n');
      return { text: 'done' };
    },
  }));
  const app = testApp(dir, runner, {}, gh);
  const start = async () => {
    const t = await app.engine.createTask({ prompt: 'carry on', repoPath: repo, pipeline: 'quick', baseRemote: 'origin', baseBranch: 'main', branch, startAt: 'implement', stopAfter: 'pr' });
    await app.engine.advance(t.id);
    return app.store.getTask(t.id)!;
  };
  return { dir, repo, bare, gh, app, branch, seen, start };
}

describe('a task branch that got commits from outside sdlc', () => {
  it('rebases onto them before implement and pushes without a non-fast-forward', async () => {
    const d = diverged('sdlc-catchup-e2e-ok-', { file: 'mine.txt', content: 'mine\n' }, { file: 'theirs.txt', content: 'theirs\n' });
    const task = await d.start();
    expect(task.status).toBe('pr_open');
    expect(task.prNumber).toBe(1);

    // the implement agent already saw the commit from outside, on top of the task's own work
    const impl = d.seen.find((s) => s.prompt.includes('Phase: implement'))!;
    expect(fs.existsSync(path.join(impl.cwd, 'theirs.txt'))).toBe(true);
    expect(fs.existsSync(path.join(impl.cwd, 'mine.txt'))).toBe(true);

    // the push went through and the outside commit survived on the remote, without a force-push
    const remoteLog = sh(d.bare, ['log', '--format=%s', `refs/heads/${d.branch}`]).split('\n');
    expect(remoteLog).toContain('remote theirs.txt');
    expect(remoteLog).toContain('sdlc: my unpushed commit');
    expect(remoteLog.at(-1)).toBe('init');
    expect(sh(d.bare, ['rev-parse', `refs/heads/${d.branch}`])).toBe(sh(task.worktreePath, ['rev-parse', 'HEAD']));
    expect(sh(task.worktreePath, ['status', '--porcelain'])).toBe('');
  });

  it('escalates on a conflict, leaving the worktree clean and the local commits in place', async () => {
    const d = diverged('sdlc-catchup-e2e-conflict-', { file: 'a.txt', content: 'one\nMINE\nthree\n' }, { file: 'a.txt', content: 'one\nTHEIRS\nthree\n' });
    const head = sh(d.repo, ['rev-parse', 'refs/heads/feature']);
    const task = await d.start();
    expect(task.status).toBe('waiting_hil');

    const hil = d.app.store.listHil({ taskId: task.id, status: 'open' })[0]!;
    expect(hil.kind).toBe('escalation');
    const impl = d.app.store.phaseRunsForTask(task.id).filter((p) => p.phaseName === 'implement');
    expect(impl.map((p) => p.status)).toEqual(['failed', 'failed']);        // the retry hits the same conflict
    expect(impl[0]!.error).toContain('files in conflict:');
    expect(impl[0]!.error).toContain('a.txt');
    expect(impl[0]!.error).toContain('remote a.txt');                       // the commit that came from outside
    expect(d.seen).toHaveLength(0);                                         // no agent was started

    // nothing was rewritten or lost, and no rebase was left in progress
    expect(sh(task.worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(task.worktreePath, ['status', '--porcelain'])).toBe('');
    expect(fs.readFileSync(path.join(task.worktreePath, 'a.txt'), 'utf8')).toBe('one\nMINE\nthree\n');
    expect(sh(d.bare, ['log', '--format=%s', `refs/heads/${d.branch}`])).toContain('remote a.txt');
  });

  it('a remote that cannot be reached does not stop the implementing phase', async () => {
    const d = diverged('sdlc-catchup-e2e-offline-', { file: 'mine.txt', content: 'mine\n' }, { file: 'theirs.txt', content: 'theirs\n' });
    fs.rmSync(d.bare, { recursive: true, force: true });
    const warnings: string[] = [];
    d.app.events.on((e) => { if (e.type === 'engine.warning') warnings.push((e.payload as { message: string }).message); });
    const task = await d.start();
    const byName = d.app.store.phaseRunsForTask(task.id).map((p) => `${p.phaseName}:${p.status}`);
    expect(byName).toContain('implement:succeeded');                        // the agent worked, offline remote or not
    expect(warnings.join('\n')).toContain(`could not check ${d.branch} against its remote`);
    expect(task.status).toBe('waiting_hil');                                // only the push itself escalates
  });
});
