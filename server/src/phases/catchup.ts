import type { PhaseRun } from '@sdlc/shared';
import { catchUpWithRemoteBranch, type CatchUp } from '../git/git.js';
import type { PhaseContext } from './executor.js';

/**
 * Take in commits pushed to the task branch from outside sdlc before a phase writes code or pushes: otherwise the
 * push is rejected as a non-fast-forward and the task escalates for nothing. Throws `CatchUpConflict` when the
 * replay conflicts (the worktree is left clean) and a plain error when git could not do it at all (fetch, auth).
 *
 * A reviewer task is left alone: it never commits, and a re-review resets its worktree to the remote branch.
 */
export async function catchUpTaskBranch(ctx: PhaseContext, pr: PhaseRun): Promise<CatchUp | null> {
  const { task } = ctx;
  if (ctx.role === 'reviewer') return null;
  const remote = task.baseRemote ?? 'origin';
  const auth = await ctx.accounts.forRepo(task.repoPath);
  const r = await catchUpWithRemoteBranch({ worktree: task.worktreePath, remote, branch: task.branch, auth, author: ctx.config.git_author });
  if (r.note) ctx.events.emit('engine.warning', { taskId: task.id, message: r.note }, { taskId: task.id, phaseRunId: pr.id });
  return r;
}

/** The same, before a push: uncommitted work blocks the catch-up, and then the push itself would be rejected. */
export async function catchUpBeforePush(ctx: PhaseContext, pr: PhaseRun): Promise<void> {
  const r = await catchUpTaskBranch(ctx, pr);
  if (r?.kind !== 'dirty') return;
  const remote = ctx.task.baseRemote ?? 'origin';
  throw new Error(`${ctx.task.branch} and ${remote}/${ctx.task.branch} have each got commits the other lacks, and the worktree has uncommitted changes: commit or discard them so that the branch can be brought in line, then push again.`);
}
