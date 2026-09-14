import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionItem, HilRequest, HilResponse, PhaseRun, PipelineRun, Task, TaskStatus } from '@sdlc/shared';
import type { SdlcConfig } from '../config/config.js';
import { loadRepoConfig, parseDuration } from '../config/config.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { findPipelineFile, loadPipeline, phaseIndex, type LoadedPipeline } from '../pipeline/loader.js';
import type { PhaseSpec, PipelineSpec, RepoConfig } from '../pipeline/schema.js';
import { PipelineSchema } from '../pipeline/schema.js';
import { evalExpr } from '../pipeline/expr.js';
import { renderTemplate } from '../pipeline/template.js';
import { createWorktree, defaultBase, removeWorktree, repoToplevel } from '../git/git.js';
import { prFeedback, repoSlug } from '../git/gh.js';
import type { Store } from '../store/repo.js';
import type { EventBus } from '../store/events.js';
import { newId, nowIso } from '../store/ids.js';
import type { LiveHandle, PhaseContext, PhaseExecutor, PhaseOutcome } from '../phases/executor.js';
import { ClaudePhaseExecutor } from '../phases/claude.js';
import { ShellPhaseExecutor } from '../phases/shell.js';
import { GitPhaseExecutor } from '../phases/git.js';
import { HilPhaseExecutor, newHilRequest } from '../phases/hil.js';
import { buildTemplateContext } from './context.js';
import { HilBroker } from './hil-broker.js';

export interface CreateTaskInput {
  prompt: string; repoPath: string; pipeline?: string; baseRemote?: string | null; baseBranch?: string;
  reviewMode?: 'conceptual' | 'line'; postReview?: boolean; title?: string;
}

export interface EngineDeps { config: SdlcConfig; store: Store; events: EventBus; runner: ClaudeRunner }

class Semaphore {
  private q: Array<() => void> = [];
  private n = 0;
  constructor(private max: number) {}
  async acquire(): Promise<() => void> {
    if (this.n < this.max) { this.n++; return () => this.release(); }
    await new Promise<void>((r) => this.q.push(r));
    this.n++;
    return () => this.release();
  }
  private release() { this.n--; const w = this.q.shift(); if (w) w(); }
}

export class Engine {
  private handles = new Map<string, LiveHandle>();
  private chains = new Map<string, Promise<void>>();
  private abortFlags = new Set<string>();
  private pauseFlags = new Set<string>();
  private pendingInject = new Map<string, string[]>();
  private slots: Semaphore;
  readonly broker = new HilBroker();
  private executors: Record<PhaseSpec['type'], PhaseExecutor> = {
    claude: new ClaudePhaseExecutor() as PhaseExecutor, shell: new ShellPhaseExecutor() as PhaseExecutor,
    git: new GitPhaseExecutor() as PhaseExecutor, hil: new HilPhaseExecutor() as PhaseExecutor,
  };

  constructor(private d: EngineDeps) { this.slots = new Semaphore(d.config.max_parallel_tasks); }

  // ------------------------------------------------------------------ tasks
  async createTask(input: CreateTaskInput): Promise<Task> {
    const { config, store, events } = this.d;
    const repoPath = await repoToplevel(path.resolve(input.repoPath));
    const repoConfig = loadRepoConfig(repoPath);
    const pipelineFile = findPipelineFile(input.pipeline ?? config.default_pipeline, config.pipelines_dirs);
    const loaded = loadPipeline(pipelineFile);
    const def = await defaultBase(repoPath);
    const baseRemote = input.baseRemote === undefined ? (repoConfig.base_remote ?? def.remote) : input.baseRemote;
    const baseBranch = input.baseBranch ?? repoConfig.base_branch ?? def.branch;
    const id = newId('t');
    const worktreesDir = config.worktrees_dir ?? path.join(path.dirname(repoPath), '.sdlc-worktrees', path.basename(repoPath));
    const wt = await createWorktree({ repo: repoPath, worktreesDir, taskId: id, baseRemote, baseBranch, copyUntracked: repoConfig.copy_untracked });
    const slug = (await repoSlug(repoPath))?.slug ?? null;
    const now = nowIso();
    const task: Task = {
      id, title: input.title ?? titleFrom(input.prompt), initialPrompt: input.prompt, refinedPrompt: null, repoPath, repoSlug: slug,
      baseRemote, baseBranch, branch: wt.branch, worktreePath: wt.worktreePath, pipelineName: loaded.spec.name,
      reviewMode: input.reviewMode ?? repoConfig.review_mode ?? 'conceptual', postReview: input.postReview ?? repoConfig.post_review ?? false,
      status: 'created', totalCostUsd: 0, prUrl: null, prNumber: null, prFeedbackCursor: null, createdAt: now, updatedAt: now,
    };
    const run: PipelineRun = { id: newId('r'), taskId: id, pipelineName: loaded.spec.name, pipelineSnapshot: { spec: loaded.spec, baseDir: loaded.baseDir, filePath: loaded.filePath },
      cursor: 0, loopCounts: {}, pendingResume: null, status: 'running', createdAt: now, updatedAt: now };
    store.tx(() => { store.insertTask(task); store.insertRun(run); });
    events.emit('task.created', { task }, { taskId: id });
    this.setTaskStatus(task, 'running');
    void this.advance(id);
    return task;
  }

  /** Kick the state machine for a task. Serialized per task; safe to call from anywhere. */
  advance(taskId: string): Promise<void> {
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.advanceInner(taskId)).catch((e) => {
      this.d.events.emit('engine.error', { taskId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, { taskId });
      const t = this.d.store.getTask(taskId);
      if (t && !['succeeded', 'failed', 'aborted'].includes(t.status)) this.setTaskStatus(t, 'failed');
    });
    this.chains.set(taskId, next);
    return next;
  }

  private async advanceInner(taskId: string): Promise<void> {
    const { store, events } = this.d;
    for (;;) {
      const task = store.getTask(taskId);
      const run = task && store.latestRunForTask(taskId);
      if (!task || !run) return;
      if (run.status !== 'running') return;
      const { spec, loaded } = snapshot(run);
      const repoConfig = loadRepoConfig(task.repoPath);
      const phase = spec.phases[run.cursor];
      if (!phase) { this.finishTask(task, run, 'succeeded'); return; }

      // loop / resume context
      const resume = run.pendingResume && run.pendingResume.phase === phase.name ? run.pendingResume : null;
      if (resume) { run.pendingResume = null; this.saveRun(run); }
      const loopCount = Object.values(run.loopCounts).reduce((a, b) => a + b, 0);
      let tpl = buildTemplateContext({ task, run, spec, repoConfig, store, loop: resume ? { feedback: resume.feedback, count: loopCount } : null });

      if (phase.when && !evalExpr(phase.when, tpl)) {
        const pr = this.newPhaseRun(run, task, phase);
        pr.status = 'skipped'; pr.endedAt = nowIso();
        store.insertPhaseRun(pr);
        events.emit('phase.finished', { phaseRun: pr }, { taskId, phaseRunId: pr.id });
        run.cursor++; this.saveRun(run); continue;
      }

      // task budget gate
      if (phase.type === 'claude' && task.totalCostUsd >= this.d.config.task_budget_usd) {
        const pr = this.newPhaseRun(run, task, phase); pr.status = 'failed'; pr.error = `task budget exhausted ($${task.totalCostUsd.toFixed(2)} >= $${this.d.config.task_budget_usd})`; pr.endedAt = nowIso();
        store.insertPhaseRun(pr);
        this.escalate(task, run, pr, pr.error); return;
      }

      const pr = this.newPhaseRun(run, task, phase);
      pr.status = 'running'; pr.startedAt = nowIso();
      store.insertPhaseRun(pr);
      events.emit('phase.started', { phaseRun: pr }, { taskId, phaseRunId: pr.id });
      let injected = this.pendingInject.get(taskId)?.splice(0).join('\n\n') ?? '';
      const feedback = [resume?.feedback, injected].filter(Boolean).join('\n\n') || null;

      const ctx: PhaseContext = {
        task, run, spec, loaded, repoConfig, config: this.d.config, store, events, runner: this.d.runner, tpl,
        resumeFeedback: feedback,
        abortRequested: this.abortFlags.has(taskId),
        canUseTool: (p) => this.makeCanUseTool(task, p),
        registerHandle: (h) => { if (h) this.handles.set(taskId, h); else this.handles.delete(taskId); },
        persistPhase: (p) => store.updatePhaseRun(p),
      };

      const needsSlot = phase.type === 'claude' || phase.type === 'shell';
      const release = needsSlot ? await this.slots.acquire() : () => {};
      let outcome: PhaseOutcome;
      try {
        outcome = await this.executors[phase.type].run(phase, pr, ctx);
      } catch (e) {
        outcome = { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
        pr.error = outcome.error;
      } finally { release(); this.handles.delete(taskId); }

      // classify by flags set while running
      if (this.abortFlags.has(taskId)) outcome = { kind: 'aborted' };
      else if (this.pauseFlags.has(taskId) && outcome.kind !== 'wait_hil') outcome = { kind: 'paused', reason: 'paused by user' };
      this.pauseFlags.delete(taskId);

      // refresh task (git phase may have set pr fields) and account cost
      const fresh = store.getTask(taskId)!;
      fresh.prUrl = task.prUrl; fresh.prNumber = task.prNumber;
      if (pr.costUsd) { fresh.totalCostUsd += pr.costUsd; events.emit('task.cost', { taskId, totalCostUsd: fresh.totalCostUsd }, { taskId }); }
      fresh.updatedAt = nowIso(); store.updateTask(fresh);

      switch (outcome.kind) {
        case 'ok':
          pr.status = 'succeeded'; pr.endedAt = pr.endedAt ?? nowIso(); store.updatePhaseRun(pr);
          events.emit('phase.finished', { phaseRun: pr }, { taskId, phaseRunId: pr.id });
          run.cursor = phase.on_success ? phaseIndex(spec, phase.on_success.goto) : run.cursor + 1;
          this.saveRun(run);
          continue;
        case 'skipped':
          pr.status = 'skipped'; pr.endedAt = nowIso(); store.updatePhaseRun(pr); run.cursor++; this.saveRun(run); continue;
        case 'wait_hil':
          pr.status = 'waiting_hil'; store.updatePhaseRun(pr);
          run.status = 'waiting_hil'; this.saveRun(run);
          this.setTaskStatus(fresh, 'waiting_hil');
          return;
        case 'paused':
          pr.status = 'paused'; pr.endedAt = nowIso(); store.updatePhaseRun(pr);
          events.emit('phase.paused', { phaseRun: pr, reason: outcome.reason }, { taskId, phaseRunId: pr.id });
          run.status = 'paused'; this.saveRun(run);
          this.setTaskStatus(fresh, 'paused');
          return;
        case 'aborted':
          pr.status = 'aborted'; pr.endedAt = nowIso(); store.updatePhaseRun(pr);
          this.finishTask(fresh, run, 'aborted');
          return;
        case 'failed': {
          pr.status = 'failed'; pr.error = pr.error ?? outcome.error; pr.endedAt = nowIso(); store.updatePhaseRun(pr);
          events.emit('phase.finished', { phaseRun: pr }, { taskId, phaseRunId: pr.id });
          const policy = phase.on_fail;
          const attempts = store.countAttempts(run.id, phase.name);
          const retriesUsed = attempts - 1 - (run.loopCounts[`retry:${phase.name}`] ?? 0) * 0; // attempts include loop re-entries; track retries separately
          const retryKey = `retry:${phase.name}`;
          if (policy?.retry && (run.loopCounts[retryKey] ?? 0) < policy.retry) {
            run.loopCounts[retryKey] = (run.loopCounts[retryKey] ?? 0) + 1; this.saveRun(run);
            void retriesUsed;
            continue; // same cursor, fresh attempt
          }
          if (policy?.back_to) {
            const key = `${phase.name}->${policy.back_to}`;
            if ((run.loopCounts[key] ?? 0) < policy.max_loops) {
              run.loopCounts[key] = (run.loopCounts[key] ?? 0) + 1;
              tpl = buildTemplateContext({ task: fresh, run, spec, repoConfig, store });
              const fb = policy.feedback ? renderTemplate(policy.feedback, tpl) : `Phase ${phase.name} failed: ${outcome.error}`;
              run.pendingResume = { phase: policy.back_to, feedback: fb };
              run.cursor = phaseIndex(spec, policy.back_to);
              this.saveRun(run);
              continue;
            }
            // loops exhausted
            if (policy.then === 'hil') { this.escalate(fresh, run, pr, `${outcome.error} (after ${policy.max_loops} loop(s) back to ${policy.back_to})`); return; }
            // then: fail
            if (isSoftFailure(phase)) { run.cursor++; this.saveRun(run); continue; }
          }
          if (!policy || policy.then === 'hil') { this.escalate(fresh, run, pr, outcome.error); return; }
          this.finishTask(fresh, run, 'failed');
          return;
        }
      }
    }
  }

  // ------------------------------------------------------------------ HIL
  async respondHil(hilId: string, response: HilResponse, via: HilRequest['answeredVia'] = 'web'): Promise<HilRequest> {
    const { store, events } = this.d;
    const hil = store.getHil(hilId);
    if (!hil) throw new HttpError(404, 'hil not found');
    if (hil.status !== 'open') throw new HttpError(409, `already ${hil.status}`, { answeredVia: hil.answeredVia });
    if (!hil.allowedDecisions.includes(response.decision)) throw new HttpError(400, `decision ${response.decision} not allowed for ${hil.kind}`);
    if (response.decision === 'request_changes' && !response.comment?.trim()) throw new HttpError(400, 'comment is required for request_changes');

    const task = store.getTask(hil.taskId)!;
    const run = store.latestRunForTask(task.id)!;
    const { spec } = snapshot(run);
    hil.status = 'answered'; hil.response = response; hil.answeredVia = via; hil.answeredAt = nowIso();
    store.updateHil(hil);
    events.emit('hil.answered', { hil }, { taskId: task.id, phaseRunId: hil.phaseRunId });

    if (response.decision === 'abort') { await this.abort(task.id, 'aborted from HIL'); return hil; }

    const phaseRun = hil.phaseRunId ? store.getPhaseRun(hil.phaseRunId) : null;
    const closePhase = (status: PhaseRun['status'], text: string) => {
      if (!phaseRun) return;
      phaseRun.status = status; phaseRun.resultText = text; phaseRun.endedAt = nowIso(); store.updatePhaseRun(phaseRun);
      events.emit('phase.finished', { phaseRun }, { taskId: task.id, phaseRunId: phaseRun.id });
    };
    const goBack = (target: string, feedback: string) => {
      run.pendingResume = { phase: target, feedback };
      run.cursor = phaseIndex(spec, target);
    };
    const hilPhase = phaseRun ? spec.phases[run.cursor] : undefined;
    const backTarget = (fallbacks: string[]) => {
      if (hilPhase?.type === 'hil' && hilPhase.back_to) return hilPhase.back_to;
      for (const f of fallbacks) if (spec.phases.some((p) => p.name === f)) return f;
      for (let i = run.cursor - 1; i >= 0; i--) if (spec.phases[i]!.type === 'claude') return spec.phases[i]!.name;
      throw new HttpError(400, 'no phase to go back to');
    };

    switch (hil.kind) {
      case 'refine_prompt': {
        const p = hil.payload as Extract<typeof hil.payload, { kind: 'refine_prompt' }>;
        task.refinedPrompt = response.edited?.prompt?.trim() || p.suggestedPrompt || task.initialPrompt;
        task.title = response.edited?.title?.trim() || p.suggestedTitle || task.title;
        closePhase('succeeded', 'approved');
        run.cursor++;
        break;
      }
      case 'approve_plan': {
        if (response.decision === 'approve') {
          if (response.edited?.planMd !== undefined) {
            const planPath = latestArtifact(store, run.id, 'plan_md');
            if (planPath) fs.writeFileSync(planPath, response.edited.planMd);
          }
          closePhase('succeeded', 'approved'); run.cursor++;
        } else { closePhase('succeeded', 'request_changes'); goBack(backTarget(['plan']), `The human reviewed your plan and requested changes:\n\n${response.comment}\n\nUpdate .sdlc/plan.md accordingly and reply with a short summary of what changed.`); }
        break;
      }
      case 'approve_result': {
        if (response.decision === 'approve') { closePhase('succeeded', 'approved'); run.cursor++; }
        else { closePhase('succeeded', 'request_changes'); goBack(backTarget(['implement']), `The human reviewed the result and requested changes:\n\n${response.comment}\n\nAddress this, keep the change minimal, then stop.`); }
        break;
      }
      case 'pr_feedback': {
        if (response.decision === 'approve') {
          const p = hil.payload as Extract<typeof hil.payload, { kind: 'pr_feedback' }>;
          const text = p.comments.map((c) => `- ${c.author}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : ''}: ${c.body}`).join('\n');
          task.prFeedbackCursor = p.comments.at(-1)?.id ?? task.prFeedbackCursor;
          goBack(backTarget(['implement']), `Reviewers left comments on the pull request. Address each one, keep changes minimal, then stop.\n\n${text}${response.comment ? `\n\nAdditional guidance: ${response.comment}` : ''}`);
        } // skip: nothing
        break;
      }
      case 'question': {
        const consumed = this.broker.resolve(hil.id, response);
        if (!consumed) {
          // phase was paused meanwhile: resume its session with the answers as text
          const p = hil.payload as Extract<typeof hil.payload, { kind: 'question' }>;
          const answers = Object.entries(response.answers ?? {}).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n') || response.comment || '';
          const target = phaseRun?.phaseName ?? spec.phases[run.cursor]?.name;
          if (target) goBack(target, `Answers to your questions:\n\n${answers || p.questions.map((q) => q.question).join('\n')}`);
        }
        task.updatedAt = nowIso(); store.updateTask(task);
        if (consumed) return hil; // phase is still running; nothing else to do
        break;
      }
      case 'escalation': {
        const p = hil.payload as Extract<typeof hil.payload, { kind: 'escalation' }>;
        if (response.decision === 'retry') { /* same cursor, fresh attempt */ }
        else if (response.decision === 'resume') goBack(p.phaseName, response.comment ?? 'Continue from where you left off.');
        else if (response.decision === 'skip') run.cursor++;
        break;
      }
    }
    run.status = 'running'; this.saveRun(run);
    task.updatedAt = nowIso(); store.updateTask(task);
    this.setTaskStatus(task, 'running');
    void this.advance(task.id);
    return hil;
  }

  /** On demand (button / CLI): read new PR comments via gh and open a pr_feedback HIL. */
  async pollPrFeedback(taskId: string): Promise<{ new: number; hilId?: string; state?: string }> {
    const { store, events } = this.d;
    const task = store.getTask(taskId);
    if (!task) throw new HttpError(404, 'task not found');
    if (!task.prNumber) throw new HttpError(409, 'task has no pull request');
    if (task.status !== 'pr_open') throw new HttpError(409, `task is ${task.status}; PR feedback can be pulled only while the PR is open and the task idle`);
    if (store.openHilForTask(taskId).some((h) => h.kind === 'pr_feedback')) throw new HttpError(409, 'a pr_feedback request is already open');
    const fb = await prFeedback(task.worktreePath, task.prNumber);
    if (fb.state === 'MERGED' || fb.state === 'CLOSED') {
      const run = store.latestRunForTask(taskId)!;
      this.finishTask(task, run, fb.state === 'MERGED' ? 'succeeded' : 'aborted');
      return { new: 0, state: fb.state };
    }
    const cursorIdx = task.prFeedbackCursor ? fb.comments.findIndex((c) => c.id === task.prFeedbackCursor) : -1;
    const fresh = fb.comments.slice(cursorIdx + 1).filter((c) => c.body.trim());
    if (!fresh.length) return { new: 0, state: fb.state };
    const hil = newHilRequest({ taskId, phaseRunId: null, kind: 'pr_feedback', title: task.title, summary: `${fresh.length} new comment(s) on the PR`,
      payload: { kind: 'pr_feedback', prUrl: task.prUrl ?? '', comments: fresh.map((c) => ({ id: c.id, author: c.author, body: c.body, path: c.path, line: c.line, url: c.url, reviewState: c.reviewState })) } });
    store.insertHil(hil);
    events.emit('hil.requested', { hil }, { taskId });
    const run = store.latestRunForTask(taskId)!;
    run.status = 'waiting_hil'; this.saveRun(run);
    this.setTaskStatus(task, 'waiting_hil');
    return { new: fresh.length, hilId: hil.id, state: fb.state };
  }

  private escalate(task: Task, run: PipelineRun, pr: PhaseRun, error: string) {
    const hil = newHilRequest({ taskId: task.id, phaseRunId: pr.id, kind: 'escalation', title: task.title, summary: `${pr.phaseName} failed: ${error.slice(0, 160)}`,
      payload: { kind: 'escalation', phaseName: pr.phaseName, error, resultSubtype: pr.resultSubtype } });
    this.d.store.insertHil(hil);
    this.d.events.emit('hil.requested', { hil }, { taskId: task.id, phaseRunId: pr.id });
    run.status = 'waiting_hil'; this.saveRun(run);
    this.setTaskStatus(task, 'waiting_hil');
  }

  /** canUseTool bridge: AskUserQuestion → HIL question; anything else that reaches the prompt is denied. */
  private makeCanUseTool(task: Task, pr: PhaseRun): CanUseTool {
    return async (toolName, input) => {
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'deny', message: `sdlc: ${toolName} is not pre-approved for this phase; proceed without it or explain what you need in your final message.` };
      }
      const questions = ((input as { questions?: AskUserQuestionItem[] }).questions ?? []);
      const hil = newHilRequest({ taskId: task.id, phaseRunId: pr.id, kind: 'question', title: task.title, summary: questions.map((q) => q.question).join(' / ').slice(0, 200), payload: { kind: 'question', questions } });
      this.d.store.insertHil(hil);
      pr.status = 'waiting_hil'; this.d.store.updatePhaseRun(pr);
      this.setTaskStatus(this.d.store.getTask(task.id)!, 'waiting_hil');
      this.d.events.emit('hil.requested', { hil }, { taskId: task.id, phaseRunId: pr.id });
      try {
        const resp = await this.broker.wait(hil.id, parseDuration(this.d.config.question_timeout), () => { void this.pause(task.id, 'question timeout'); });
        pr.status = 'running'; this.d.store.updatePhaseRun(pr);
        this.setTaskStatus(this.d.store.getTask(task.id)!, 'running');
        return { behavior: 'allow', updatedInput: { questions, answers: resp.answers ?? {}, ...(resp.comment ? { response: resp.comment } : {}) } };
      } catch (e) {
        return { behavior: 'deny', message: `sdlc: no answer (${e instanceof Error ? e.message : String(e)}). Proceed with your best assumption.` };
      }
    };
  }

  // ------------------------------------------------------------------ controls
  async pause(taskId: string, reason = 'paused by user'): Promise<void> {
    const task = this.d.store.getTask(taskId);
    if (!task) throw new HttpError(404, 'task not found');
    if (task.status !== 'running' && task.status !== 'waiting_hil') throw new HttpError(409, `cannot pause task in status ${task.status}`);
    const h = this.handles.get(taskId);
    if (h) {
      this.pauseFlags.add(taskId);
      const fallback = setTimeout(() => h.abort(), 30_000);
      try { await h.interrupt(); } catch { h.abort(); } finally { clearTimeout(fallback); }
    } else {
      const run = this.d.store.latestRunForTask(taskId);
      if (run) { run.status = 'paused'; this.saveRun(run); }
      this.setTaskStatus(task, 'paused');
    }
    void reason;
  }

  async resume(taskId: string, guidance?: string): Promise<void> {
    const { store } = this.d;
    const task = store.getTask(taskId);
    const run = task && store.latestRunForTask(taskId);
    if (!task || !run) throw new HttpError(404, 'task not found');
    if (run.status !== 'paused') throw new HttpError(409, `task is ${task.status}, not paused`);
    const phase = snapshot(run).spec.phases[run.cursor];
    const openHil = store.openHilForTask(taskId);
    if (openHil.length && phase?.type === 'hil') { run.status = 'waiting_hil'; this.saveRun(run); this.setTaskStatus(task, 'waiting_hil'); return; }
    if (phase && phase.type === 'claude') {
      const paused = store.latestPhaseRun(run.id, phase.name, ['paused']);
      run.pendingResume = { phase: phase.name, feedback: guidance ?? (paused?.sessionId ? 'You were interrupted. Continue the task from where you left off.' : '') };
      if (!run.pendingResume.feedback) run.pendingResume = null;
    }
    run.status = 'running'; this.saveRun(run);
    this.setTaskStatus(task, 'running');
    void this.advance(taskId);
  }

  async abort(taskId: string, reason = 'aborted by user'): Promise<void> {
    const { store, events } = this.d;
    const task = store.getTask(taskId);
    const run = task && store.latestRunForTask(taskId);
    if (!task || !run) throw new HttpError(404, 'task not found');
    if (['succeeded', 'failed', 'aborted'].includes(task.status)) throw new HttpError(409, `task already ${task.status}`);
    this.abortFlags.add(taskId);
    for (const h of store.openHilForTask(taskId)) { h.status = 'cancelled'; store.updateHil(h); this.broker.cancel(h.id, reason); events.emit('hil.answered', { hil: h }, { taskId }); }
    const h = this.handles.get(taskId);
    if (h) { h.abort(); await (this.chains.get(taskId) ?? Promise.resolve()).catch(() => {}); }
    else this.finishTask(task, run, 'aborted');
  }

  inject(taskId: string, text: string): { deliveredTo: 'session' | 'queued' } {
    const h = this.handles.get(taskId);
    if (h) { h.inject(text); return { deliveredTo: 'session' }; }
    const q = this.pendingInject.get(taskId) ?? [];
    q.push(text); this.pendingInject.set(taskId, q);
    return { deliveredTo: 'queued' };
  }

  /** After a restart: running phases become paused; optionally auto-resume. */
  async recover(): Promise<void> {
    const { store, events, config } = this.d;
    for (const pr of store.phaseRunsByStatus('running')) {
      pr.status = 'paused'; pr.endedAt = nowIso(); store.updatePhaseRun(pr);
      events.emit('phase.paused', { phaseRun: pr, reason: 'engine restart' }, { taskId: pr.taskId, phaseRunId: pr.id });
      const run = store.latestRunForTask(pr.taskId);
      const task = store.getTask(pr.taskId);
      if (run && task) { run.status = 'paused'; this.saveRun(run); this.setTaskStatus(task, 'paused'); if (config.auto_resume_on_restart) await this.resume(task.id).catch(() => {}); }
    }
    for (const pr of store.phaseRunsByStatus('waiting_hil')) {
      // a question HIL whose waiter died with the process: keep the request, park the phase
      if (pr.phaseType === 'claude') { pr.status = 'paused'; store.updatePhaseRun(pr); const run = store.latestRunForTask(pr.taskId); const t = store.getTask(pr.taskId); if (run && t && run.status !== 'waiting_hil') { run.status = 'paused'; this.saveRun(run); this.setTaskStatus(t, 'paused'); } }
    }
    for (const t of store.listTasks(['running'])) {
      const run = store.latestRunForTask(t.id);
      if (run?.status === 'running') void this.advance(t.id);
    }
  }

  // ------------------------------------------------------------------ helpers
  private newPhaseRun(run: PipelineRun, task: Task, phase: PhaseSpec): PhaseRun {
    return { id: newId('p'), runId: run.id, taskId: task.id, phaseName: phase.name, phaseType: phase.type, attempt: this.d.store.countAttempts(run.id, phase.name) + 1,
      status: 'pending', sessionId: null, resumedFromSessionId: null, costUsd: 0, numTurns: 0, resultText: null, structuredOutput: null, resultSubtype: null,
      error: null, transcriptPath: null, artifacts: {}, startedAt: null, endedAt: null };
  }
  private saveRun(run: PipelineRun) { run.updatedAt = nowIso(); this.d.store.updateRun(run); }
  private setTaskStatus(task: Task, status: TaskStatus) {
    const fresh = this.d.store.getTask(task.id) ?? task;
    if (fresh.status === status) return;
    const from = fresh.status; fresh.status = status; fresh.updatedAt = nowIso();
    fresh.refinedPrompt = task.refinedPrompt ?? fresh.refinedPrompt; fresh.title = task.title;
    this.d.store.updateTask(fresh);
    task.status = status;
    this.d.events.emit('task.status', { task: fresh, from, to: status }, { taskId: task.id });
  }
  private finishTask(task: Task, run: PipelineRun, status: 'succeeded' | 'failed' | 'aborted') {
    run.status = status; this.saveRun(run);
    this.abortFlags.delete(task.id); this.pauseFlags.delete(task.id); this.pendingInject.delete(task.id);
    const final: TaskStatus = status === 'succeeded' && task.prUrl ? 'pr_open' : status;
    this.setTaskStatus(task, final);
    void this.cleanup(task, status);
  }
  private async cleanup(task: Task, status: 'succeeded' | 'failed' | 'aborted') {
    const policy = this.d.config.cleanup;
    const shouldRemove = status === 'aborted' || (status === 'succeeded' && policy !== 'never');
    if (!shouldRemove) return;
    try {
      const baseRef = task.baseRemote ? `${task.baseRemote}/${task.baseBranch}` : task.baseBranch;
      const r = await removeWorktree(task.repoPath, task.worktreePath, task.branch, { deleteBranchIfEmpty: status === 'aborted' ? baseRef : undefined });
      if (r.removed) this.d.events.emit('engine.warning', { taskId: task.id, message: `worktree removed${r.branchDeleted ? ', empty branch deleted' : `, branch ${task.branch} kept`}` }, { taskId: task.id });
    } catch (e) { this.d.events.emit('engine.warning', { taskId: task.id, message: `cleanup failed: ${e instanceof Error ? e.message : String(e)}` }, { taskId: task.id }); }
  }
}

export class HttpError extends Error { constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

export function snapshot(run: PipelineRun): { spec: PipelineSpec; loaded: LoadedPipeline } {
  const s = run.pipelineSnapshot as { spec: unknown; baseDir: string; filePath: string };
  const spec = PipelineSchema.parse(s.spec);
  return { spec, loaded: { spec, baseDir: s.baseDir, filePath: s.filePath } };
}

function latestArtifact(store: Store, runId: string, name: string): string | null {
  for (const pr of store.phaseRunsForRun(runId).reverse()) if (pr.artifacts[name]) return pr.artifacts[name]!;
  return null;
}

function isSoftFailure(phase: PhaseSpec): boolean { return phase.type === 'claude' && !!phase.fail_if; }

export function titleFrom(prompt: string): string {
  const first = (prompt.trim().split('\n').find((l) => l.trim()) ?? 'task').replace(/^#+\s*/, '');
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.length > 60 ? sentence.slice(0, 57).replace(/\s+\S*$/, '') + '…' : sentence;
}

export type { RepoConfig };
