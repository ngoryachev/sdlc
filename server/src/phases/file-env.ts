import type { PhaseRun } from '@sdlc/shared';
import { missingFileWarning, repoFileEnv } from '../config/repo-files.js';
import type { PhaseContext } from './executor.js';

/**
 * Env variables for the files configured for this task's repository (Settings → Repositories), each holding the
 * absolute path of its file. A file that is gone from disk only warns: the phase runs, the variable stays unset.
 */
export function repoFileEnvFor(ctx: PhaseContext, pr: PhaseRun): Record<string, string> {
  const { env, missing } = repoFileEnv(ctx.config, ctx.task.repoPath);
  for (const f of missing) ctx.events.emit('engine.warning', { taskId: ctx.task.id, message: missingFileWarning(f) }, { taskId: ctx.task.id, phaseRunId: pr.id });
  return env;
}
