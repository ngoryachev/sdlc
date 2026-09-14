import fs from 'node:fs';
import type { PhaseRun, PipelineRun, Task } from '@sdlc/shared';
import type { PipelineSpec, RepoConfig } from '../pipeline/schema.js';
import type { TemplateContext } from '../pipeline/template.js';
import type { Store } from '../store/repo.js';

/** Build the `{{ … }}` context for a task at its current state. */
export function buildTemplateContext(o: {
  task: Task; run: PipelineRun; spec: PipelineSpec; repoConfig: RepoConfig; store: Store;
  loop?: { feedback: string; count: number } | null;
}): TemplateContext {
  const { task, run, store } = o;
  const phases: Record<string, unknown> = {};
  const artifacts: Record<string, unknown> = {};
  const hil: Record<string, unknown> = {};
  const runs = store.phaseRunsForRun(run.id);
  // latest attempt per phase wins
  const latest = new Map<string, PhaseRun>();
  for (const pr of runs) latest.set(pr.phaseName, pr);
  for (const [name, pr] of latest) {
    phases[name] = { output: pr.resultText ?? '', structured: pr.structuredOutput ?? null, status: pr.status, attempt: pr.attempt, error: pr.error ?? '' };
    for (const [aName, aPath] of Object.entries(pr.artifacts)) {
      artifacts[aName] = fs.existsSync(aPath) ? fs.readFileSync(aPath, 'utf8') : '';
    }
  }
  for (const h of store.listHil({ taskId: task.id, status: 'answered' })) {
    if (h.response?.comment) hil[h.kind] = { comment: h.response.comment };
    const phaseName = h.phaseRunId ? store.getPhaseRun(h.phaseRunId)?.phaseName : undefined;
    if (phaseName && h.response?.comment) hil[phaseName] = { comment: h.response.comment };
  }
  return {
    task: {
      id: task.id, title: task.title, prompt: task.refinedPrompt ?? task.initialPrompt, initial_prompt: task.initialPrompt,
      branch: task.branch, base_branch: task.baseBranch, base_remote: task.baseRemote ?? '', base_ref: task.baseRemote ? `${task.baseRemote}/${task.baseBranch}` : task.baseBranch,
      worktree: task.worktreePath, repo: task.repoPath, review_mode: task.reviewMode, post_review: String(task.postReview),
      cost_usd: task.totalCostUsd.toFixed(2), pr_url: task.prUrl ?? '',
    },
    phases, artifacts, hil,
    loop: o.loop ?? { feedback: '', count: 0 },
    repo: { ...o.repoConfig, test_command: o.repoConfig.test_command ?? '', lint_command: o.repoConfig.lint_command ?? '' },
  };
}
