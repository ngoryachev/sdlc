import fs from 'node:fs';
import type { ClarifyOutput, HilDecision, HilKind, HilPayload, HilRequest, HilResponse, PhaseRun, QaOutput, ReviewOutput, TestOutput } from '@sdlc/shared';
import { HIL_DECISIONS, defaultFindingActions, defaultReviewEvent } from '@sdlc/shared';
import type { HilPhaseSpec } from '../pipeline/schema.js';
import { diffAgainst } from '../git/git.js';
import { newId, nowIso } from '../store/ids.js';
import { parseDuration } from '../config/config.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export const HIL_NEXT: Record<HilKind, Partial<Record<HilDecision, string>>> = {
  refine_prompt: { approve: 'Start the pipeline with this prompt', abort: 'Cancel the task' },
  approve_plan: { approve: 'Start implementation', request_changes: 'Re-plan with your comment', abort: 'Cancel the task' },
  approve_result: { approve: 'Continue; findings marked post go to the pull request', request_changes: 'Back to implementation with the items marked fix and your comment', abort: 'Cancel the task' },
  pr_feedback: { approve: 'Address the comments marked fix in implementation', skip: 'Leave all for later', abort: 'Cancel the task' },
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
    const auto = await autoAnswer(payload, ctx);
    const summary = [summaryFor(payload), auto?.reason].filter(Boolean).join(' — ');
    const expiresAt = phase.timeout ? new Date(Date.now() + parseDuration(phase.timeout)).toISOString() : null;
    const hil = newHilRequest({ taskId: task.id, phaseRunId: pr.id, kind: phase.hil, title, summary, payload, expiresAt });
    if (auto) {
      // nothing for the human to decide: the checkpoint is stored already answered, so the phases that read it
      // (publish looks up the latest approved review) still find it, and no card or notification is sent out
      hil.status = 'answered'; hil.response = auto.response; hil.answeredVia = 'auto'; hil.answeredAt = nowIso();
      store.insertHil(hil);
      pr.resultText = auto.reason;
      events.emit('hil.answered', { hil }, { taskId: task.id, phaseRunId: pr.id });
      // the reason also reaches the task log as `task.updated`, but from the engine: only there has the answer been
      // applied, so the payload carries the refined title and the renamed branch rather than the values it replaced
      return { kind: 'wait_hil', hilId: hil.id, autoResponse: auto.response };
    }
    store.insertHil(hil);
    events.emit('hil.requested', { hil }, { taskId: task.id, phaseRunId: pr.id });
    return { kind: 'wait_hil', hilId: hil.id };
  }
}

/**
 * The answer a checkpoint with nothing to decide gets from the pipeline itself, or null when a human is needed.
 * The decision comes from the same defaults the UI proposes (`defaultFindingActions` / `defaultReviewEvent`),
 * so what is auto-approved is exactly what the human would have confirmed without touching anything.
 */
async function autoAnswer(payload: HilPayload, ctx: PhaseContext): Promise<{ response: HilResponse; reason: string } | null> {
  if (payload.kind === 'approve_result') {
    const findings = defaultFindingActions(payload, null);
    const reviewEvent = defaultReviewEvent(payload);
    // `approve` requires a real review verdict, so a failed, skipped or out-of-segment review still asks the human;
    // a qa gate (focus 'qa') exists only when QA reported issues and is never auto-passed
    if (reviewEvent !== 'approve') return null;
    if (Object.values(findings).some((a) => a === 'fix' || a === 'post')) return null;
    // approving someone else's pull request is a published act: a task may be told not to do it on its own
    if (ctx.role === 'reviewer' && !ctx.task.approveOnClean) return null;
    // only a reviewer with a pull request publishes the approval; an author's `approve` is forced to COMMENT, and
    // without a PR `publish` has nothing to post on, so neither may claim it in the reason a human reads
    const approves = ctx.role === 'reviewer' && payload.canPost;
    // GitHub rejects an approval of your own pull request (422) and `publish` has no on_fail: an unattended
    // auto-approve would fail the task, so this one checkpoint is left to the human, who can downgrade the event
    if (approves && await isOwnPr(ctx)) return null;
    const reason = `auto-approved: no finding needs fixing or publishing${approves ? '; approving the pull request' : ''}`;
    return { response: { decision: 'approve', findings, reviewEvent }, reason };
  }
  if (payload.kind === 'refine_prompt') {
    const clarify = (ctx.tpl.phases as Record<string, { structured?: unknown; status?: string } | undefined>).clarify;
    if (clarify?.status !== 'succeeded' || !clarify.structured) return null;
    if (payload.questions.length || payload.clarifyError) return null;
    // no answers and no edits: respondHilInner's refine_prompt branch applies the suggested prompt, title and branch
    return { response: { decision: 'approve' }, reason: 'auto-approved: clarify had no questions' };
  }
  return null;
}

/**
 * Was the pull request opened by the very account sdlc reviews it with? Only a known match counts: when the account
 * or the author cannot be read, the approval is still attempted, and `publish` falls back to a comment if GitHub says no.
 */
async function isOwnPr(ctx: PhaseContext): Promise<boolean> {
  const { task } = ctx;
  if (!task.prNumber) return false;
  const auth = await ctx.accounts.forRepo(task.repoPath).catch(() => null);
  if (!auth?.user) return false;
  const pr = await ctx.github.prView(task.repoPath, task.prNumber, auth).catch(() => null);
  return pr?.author?.login === auth.user;
}

async function buildPayload(kind: HilPhaseSpec['hil'], ctx: PhaseContext): Promise<HilPayload> {
  const { task, tpl } = ctx;
  const phases = tpl.phases as Record<string, { output?: string; structured?: unknown; status?: string; error?: string }>;
  switch (kind) {
    case 'refine_prompt': {
      const c = phases.clarify?.structured as ClarifyOutput | null | undefined;
      return { kind, prompt: task.refinedPrompt ?? task.initialPrompt, questions: c?.questions ?? [], suggestedPrompt: c?.suggestedPrompt ?? null, assumptions: c?.assumptions ?? [], suggestedTitle: c?.title ?? null, suggestedBranch: c?.branch ?? null,
        // clarify is optional (on_fail: continue): say so, or its silence reads as "nothing to clarify"
        clarifyError: phases.clarify?.status === 'failed' ? phases.clarify.error || 'failed' : null };
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
      // a gate placed after the QA phase decides on QA issues; the checkpoint before it decides on review findings
      const qaIdx = ctx.spec.phases.findIndex((p) => p.name === 'qa');
      const focus = qa?.verdict === 'issues' && qaIdx >= 0 && qaIdx < ctx.run.cursor ? 'qa' : 'review';
      const hilPhase = ctx.spec.phases[ctx.run.cursor];
      const backIdx = ctx.spec.phases.findIndex((p) => p.name === (hilPhase?.type === 'hil' && hilPhase.back_to ? hilPhase.back_to : 'implement'));
      // a previous checkpoint dropped as stale (the PR moved while it was open) is linked from the one that replaces it
      const prev = ctx.store.listHil({ taskId: task.id }).find((h) => h.kind === 'approve_result');
      return { kind, diffStat: d.stat, diff: d.patch, testOutput, test, review, qa, commits: d.commits, branch: task.branch,
        focus, canFix: backIdx >= ctx.segment.fromIdx && backIdx >= 0, canPost: !!task.prNumber && focus === 'review', role: ctx.role,
        supersedes: prev?.status === 'cancelled' ? prev.id : null };
    }
  }
}

function summaryFor(p: HilPayload): string {
  switch (p.kind) {
    case 'refine_prompt': return p.questions.length ? `${p.questions.length} clarifying question(s)` : p.clarifyError ? `clarify failed (${p.clarifyError}); confirm the original prompt` : 'Confirm the prompt';
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
