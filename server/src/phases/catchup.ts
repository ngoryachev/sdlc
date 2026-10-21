import type { PhaseRun } from '@sdlc/shared';
import { catchUpWithRemoteBranch } from '../git/git.js';
import type { PhaseContext } from './executor.js';

/**
 * Take in commits pushed to the task branch from outside sdlc before a phase writes code or pushes: otherwise the
 * push is rejected as a non-fast-forward and the task escalates for nothing. Throws `CatchUpConflict` when the
 * replay conflicts (the worktree is left clean) and a plain error when the fetch itself fails.
 *
 * A reviewer task is left alone: it never commits, and a re-review resets its worktree to the remote branch.
 */
export async function catchUpTaskBranch(ctx: PhaseContext, pr: PhaseRun): Promise<void> {
  const { task } = ctx;
  if (ctx.role === 'reviewer') return;
  const remote = task.baseRemote ?? 'origin';
  const auth = await ctx.accounts.forRepo(task.repoPath);
  const r = await catchUpWithRemoteBranch({ worktree: task.worktreePath, remote, branch: task.branch, auth });
  if (r.note) ctx.events.emit('engine.warning', { taskId: task.id, message: r.note }, { taskId: task.id, phaseRunId: pr.id });
}
