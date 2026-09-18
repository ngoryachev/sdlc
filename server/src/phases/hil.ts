import fs from 'node:fs';
import type { ClarifyOutput, HilDecision, HilKind, HilPayload, HilRequest, PhaseRun, QaOutput, ReviewOutput, TestOutput } from '@sdlc/shared';
import { HIL_DECISIONS } from '@sdlc/shared';
import type { HilPhaseSpec } from '../pipeline/schema.js';
import { diffAgainst } from '../git/git.js';
import { newId, nowIso } from '../store/ids.js';
import { parseDuration } from '../config/config.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export const HIL_NEXT: Record<HilKind, Partial<Record<HilDecision, string>>> = {
  refine_prompt: { approve: 'Start the pipeline with this prompt', abort: 'Cancel the task' },
  approve_plan: { approve: 'Start implementation', request_changes: 'Re-plan with your comment', abort: 'Cancel the task' },
  approve_result: { approve: 'Create the pull request', request_changes: 'Back to implementation with your comment', abort: 'Cancel the task' },
  pr_feedback: { approve: 'Address the comments in implementation', skip: 'Leave for later', abort: 'Cancel the task' },
  question: { answer: 'Continue', abort: 'Cancel the task' },
  escalation: { retry: 'Re-run the phase from scratch', resume: 'Resume the phase with your guidance', skip: 'Skip this phase', abort: 'Cancel the task' },
};

export function newHilRequest(o: { taskId: string; phaseRunId: string | null; kind: HilKind; title: string; summary: string; payload: HilPayload; expiresAt?: string | null }): HilRequest {
  return {
    id: newId('h'), taskId: o.taskId, phaseRunId: o.phaseRunId, kind: o.kind, title: o.title, summary: o.summary, payload: o.payload,
    allowedDecisions: HIL_DECISIONS[o.kind], next: HIL_NEXT[o.kind], status: 'open', response: null, answeredVia: null,
    expiresAt: o.expiresAt ?? null, createdAt: nowIso(), answeredAt: null,
  };
}

export class HilPhaseExecutor implements PhaseExecutor<HilPhaseSpec> {
  async run(phase: HilPhaseSpec, pr: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome> {
    const { task, store, events } = ctx;
    const payload = await buildPayload(phase.hil, ctx);
    const title = `${task.title}`;
    const summary = summaryFor(payload);
    const expiresAt = phase.timeout ? new Date(Date.now() + parseDuration(phase.timeout)).toISOString() : null;
    const hil = newHilRequest({ taskId: task.id, phaseRunId: pr.id, kind: phase.hil, title, summary, payload, expiresAt });
    store.insertHil(hil);
    events.emit('hil.requested', { hil }, { taskId: task.id, phaseRunId: pr.id });
    return { kind: 'wait_hil', hilId: hil.id };
  }
}

async function buildPayload(kind: HilPhaseSpec['hil'], ctx: PhaseContext): Promise<HilPayload> {
  const { task, tpl } = ctx;
  const phases = tpl.phases as Record<string, { output?: string; structured?: unknown }>;
  switch (kind) {
    case 'refine_prompt': {
      const c = phases.clarify?.structured as ClarifyOutput | null | undefined;
      return { kind, prompt: task.refinedPrompt ?? task.initialPrompt, questions: c?.questions ?? [], suggestedPrompt: c?.suggestedPrompt ?? null, assumptions: c?.assumptions ?? [], suggestedTitle: c?.title ?? null };
    }
    case 'approve_plan': {
      const artifacts = tpl.artifacts as Record<string, string>;
      const planMd = artifacts.plan_md ?? '';
      return { kind, planMd, summary: phases.plan?.output ?? '', costUsd: task.totalCostUsd };
    }
    case 'approve_result': {
      const baseRef = (tpl.task as { base_ref: string }).base_ref;
      const d = await diffAgainst(task.worktreePath, baseRef);
      const review = (phases.review?.structured as ReviewOutput | null) ?? null;
      const test = (phases.test?.structured as TestOutput | null) ?? null;
      const qa = (phases.qa?.structured as QaOutput | null) ?? null;
      const testOutput = test ? [`${test.verdict}: ${test.summary}`, test.commands.length ? `\ncommands:\n${test.commands.map((c) => `  $ ${c}`).join('\n')}` : '', test.failures.length ? `\nfailures:\n${test.failures.map((f) => `  - ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}: ${f.description}`).join('\n')}` : '', test.notes ? `\nnotes: ${test.notes}` : ''].join('\n') : (phases.test?.output || null);
      return { kind, diffStat: d.stat, diff: d.patch, testOutput, test, review, qa, commits: d.commits, branch: task.branch };
    }
  }
}

function summaryFor(p: HilPayload): string {
  switch (p.kind) {
    case 'refine_prompt': return p.questions.length ? `${p.questions.length} clarifying question(s)` : 'Confirm the prompt';
    case 'approve_plan': return p.summary.slice(0, 200) || 'Plan is ready for review';
    case 'approve_result': return `${p.commits.length} commit(s); ${p.diffStat.split('\n').pop() ?? ''}${p.test ? `; tests: ${p.test.verdict}` : ''}${p.review ? `; review: ${p.review.verdict}` : ''}${p.qa ? `; qa: ${p.qa.verdict}${p.qa.issues.length ? ` (${p.qa.issues.length} issue(s))` : ''}` : ''}`;
    case 'pr_feedback': return `${p.comments.length} new comment(s) on the PR`;
    case 'question': return p.questions.map((q) => q.question).join(' / ').slice(0, 200);
    case 'escalation': return `${p.phaseName} failed: ${p.error.slice(0, 160)}`;
  }
}

export function planArtifactPath(ctx: PhaseContext): string | null {
  for (const pr of ctx.store.phaseRunsForRun(ctx.run.id).reverse()) {
    if (pr.artifacts.plan_md && fs.existsSync(pr.artifacts.plan_md)) return pr.artifacts.plan_md;
  }
  return null;
}
