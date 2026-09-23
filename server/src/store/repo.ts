import type { DatabaseSync } from 'node:sqlite';
import type { HilRequest, PhaseRun, PipelineRun, Task } from '@sdlc/shared';

import type { SQLInputValue } from 'node:sqlite';
type Row = Record<string, unknown>;
type Params = Record<string, SQLInputValue>;
/** node:sqlite rejects named parameters that are not referenced by the statement, so pass only the ones it uses. */
const pick = (sql: string, p: Params): Params => { const out: Params = {}; for (const m of sql.matchAll(/@([a-z_]+)/g)) out[m[1]!] = p[m[1]!] ?? null; return out; };
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: unknown, fallback: T): T => { if (typeof s !== 'string') return fallback; try { return JSON.parse(s) as T; } catch { return fallback; } };

export class Store {
  constructor(public readonly db: DatabaseSync) {}

  private exec(sql: string, p: Params) { return this.db.prepare(sql).run(pick(sql, p)); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- tasks
  insertTask(t: Task) {
    this.exec(`INSERT INTO tasks VALUES (@id,@title,@initial_prompt,@refined_prompt,@repo_path,@repo_slug,@base_remote,@base_branch,@branch,@worktree_path,@pipeline_name,@review_mode,@post_review,@status,@total_cost_usd,@pr_url,@pr_number,@pr_feedback_cursor,@created_at,@updated_at,@model_overrides)`, taskToRow(t));
  }
  updateTask(t: Task) {
    this.exec(`UPDATE tasks SET title=@title, refined_prompt=@refined_prompt, review_mode=@review_mode, post_review=@post_review, status=@status, total_cost_usd=@total_cost_usd, pr_url=@pr_url, pr_number=@pr_number, pr_feedback_cursor=@pr_feedback_cursor, model_overrides=@model_overrides, updated_at=@updated_at, worktree_path=@worktree_path, branch=@branch, base_remote=@base_remote, base_branch=@base_branch WHERE id=@id`, taskToRow(t));
  }
  getTask(id: string): Task | null { const r = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined; return r ? rowToTask(r) : null; }
  listTasks(status?: string[]): Task[] {
    const rows = status?.length
      ? this.db.prepare(`SELECT * FROM tasks WHERE status IN (${status.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...status)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
    return (rows as Row[]).map(rowToTask);
  }

  // ---- runs
  insertRun(r: PipelineRun) {
    this.exec(`INSERT INTO pipeline_runs VALUES (@id,@task_id,@pipeline_name,@pipeline_snapshot,@cursor,@loop_counts,@pending_resume,@status,@created_at,@updated_at)`, runToRow(r));
  }
  updateRun(r: PipelineRun) {
    this.exec(`UPDATE pipeline_runs SET cursor=@cursor, loop_counts=@loop_counts, pending_resume=@pending_resume, status=@status, updated_at=@updated_at WHERE id=@id`, runToRow(r));
  }
  getRun(id: string): PipelineRun | null { const r = this.db.prepare('SELECT * FROM pipeline_runs WHERE id=?').get(id) as Row | undefined; return r ? rowToRun(r) : null; }
  latestRunForTask(taskId: string): PipelineRun | null {
    const r = this.db.prepare('SELECT * FROM pipeline_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(taskId) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  // ---- phase runs
  insertPhaseRun(p: PhaseRun) {
    this.exec(`INSERT INTO phase_runs VALUES (@id,@run_id,@task_id,@phase_name,@phase_type,@attempt,@status,@session_id,@resumed_from_session_id,@cost_usd,@num_turns,@result_text,@structured_output,@result_subtype,@error,@transcript_path,@artifacts,@started_at,@ended_at)`, phaseToRow(p));
  }
  updatePhaseRun(p: PhaseRun) {
    this.exec(`UPDATE phase_runs SET status=@status, session_id=@session_id, resumed_from_session_id=@resumed_from_session_id, cost_usd=@cost_usd, num_turns=@num_turns, result_text=@result_text, structured_output=@structured_output, result_subtype=@result_subtype, error=@error, transcript_path=@transcript_path, artifacts=@artifacts, started_at=@started_at, ended_at=@ended_at WHERE id=@id`, phaseToRow(p));
  }
  getPhaseRun(id: string): PhaseRun | null { const r = this.db.prepare('SELECT * FROM phase_runs WHERE id=?').get(id) as Row | undefined; return r ? rowToPhase(r) : null; }
  phaseRunsForRun(runId: string): PhaseRun[] { return (this.db.prepare('SELECT * FROM phase_runs WHERE run_id=? ORDER BY started_at, attempt').all(runId) as Row[]).map(rowToPhase); }
  phaseRunsForTask(taskId: string): PhaseRun[] { return (this.db.prepare('SELECT * FROM phase_runs WHERE task_id=? ORDER BY started_at, attempt').all(taskId) as Row[]).map(rowToPhase); }
  latestPhaseRun(runId: string, phaseName: string, statuses?: string[]): PhaseRun | null {
    const rows = this.db.prepare('SELECT * FROM phase_runs WHERE run_id=? AND phase_name=? ORDER BY attempt DESC').all(runId, phaseName) as Row[];
    const r = rows.map(rowToPhase).find((p) => !statuses || statuses.includes(p.status));
    return r ?? null;
  }
  countAttempts(runId: string, phaseName: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM phase_runs WHERE run_id=? AND phase_name=?').get(runId, phaseName) as { c: number }).c;
  }
  sumCostForSession(sessionId: string, excludePhaseRunId: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM phase_runs WHERE session_id=? AND id<>?').get(sessionId, excludePhaseRunId) as { s: number }).s;
  }
  phaseRunsByStatus(status: string): PhaseRun[] { return (this.db.prepare('SELECT * FROM phase_runs WHERE status=?').all(status) as Row[]).map(rowToPhase); }

  // ---- hil
  insertHil(h: HilRequest) {
    this.exec(`INSERT INTO hil_requests VALUES (@id,@task_id,@phase_run_id,@kind,@title,@summary,@payload,@allowed_decisions,@next,@status,@response,@answered_via,@expires_at,@created_at,@answered_at)`, hilToRow(h));
  }
  updateHil(h: HilRequest) {
    this.exec(`UPDATE hil_requests SET status=@status, response=@response, answered_via=@answered_via, answered_at=@answered_at, payload=@payload WHERE id=@id`, hilToRow(h));
  }
  getHil(id: string): HilRequest | null { const r = this.db.prepare('SELECT * FROM hil_requests WHERE id=?').get(id) as Row | undefined; return r ? rowToHil(r) : null; }
  listHil(opts: { status?: string; taskId?: string } = {}): HilRequest[] {
    const where: string[] = []; const args: unknown[] = [];
    if (opts.status && opts.status !== 'all') { where.push('status=?'); args.push(opts.status); }
    if (opts.taskId) { where.push('task_id=?'); args.push(opts.taskId); }
    const sql = `SELECT * FROM hil_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...(args as string[])) as Row[]).map(rowToHil);
  }
  openHilForTask(taskId: string): HilRequest[] { return this.listHil({ status: 'open', taskId }); }

  // ---- notifications
  setNotificationRef(hilId: string, channel: string, ref: string) {
    this.db.prepare('INSERT OR REPLACE INTO notifications VALUES (?,?,?)').run(hilId, channel, ref);
  }
  getNotificationRef(hilId: string, channel: string): string | null {
    return (this.db.prepare('SELECT ref FROM notifications WHERE hil_id=? AND channel=?').get(hilId, channel) as { ref: string } | undefined)?.ref ?? null;
  }
}

// ---- mappers
function taskToRow(t: Task): Params {
  return { id: t.id, title: t.title, initial_prompt: t.initialPrompt, refined_prompt: t.refinedPrompt, repo_path: t.repoPath, repo_slug: t.repoSlug,
    base_remote: t.baseRemote, base_branch: t.baseBranch, branch: t.branch, worktree_path: t.worktreePath, pipeline_name: t.pipelineName,
    review_mode: t.reviewMode, post_review: t.postReview ? 1 : 0, status: t.status, total_cost_usd: t.totalCostUsd, pr_url: t.prUrl,
    pr_number: t.prNumber, pr_feedback_cursor: t.prFeedbackCursor, created_at: t.createdAt, updated_at: t.updatedAt, model_overrides: t.modelOverrides ? j(t.modelOverrides) : null };
}
function rowToTask(r: Row): Task {
  return { id: r.id as string, title: r.title as string, initialPrompt: r.initial_prompt as string, refinedPrompt: (r.refined_prompt as string) ?? null,
    repoPath: r.repo_path as string, repoSlug: (r.repo_slug as string) ?? null, baseRemote: (r.base_remote as string) ?? null, baseBranch: r.base_branch as string,
    branch: r.branch as string, worktreePath: r.worktree_path as string, pipelineName: r.pipeline_name as string, reviewMode: r.review_mode as Task['reviewMode'],
    postReview: !!r.post_review, status: r.status as Task['status'], totalCostUsd: r.total_cost_usd as number, prUrl: (r.pr_url as string) ?? null,
    prNumber: (r.pr_number as number) ?? null, prFeedbackCursor: (r.pr_feedback_cursor as string) ?? null, modelOverrides: pj(r.model_overrides, null), createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function runToRow(x: PipelineRun): Params {
  return { id: x.id, task_id: x.taskId, pipeline_name: x.pipelineName, pipeline_snapshot: j(x.pipelineSnapshot), cursor: x.cursor,
    loop_counts: j(x.loopCounts), pending_resume: x.pendingResume ? j(x.pendingResume) : null, status: x.status, created_at: x.createdAt, updated_at: x.updatedAt };
}
function rowToRun(r: Row): PipelineRun {
  return { id: r.id as string, taskId: r.task_id as string, pipelineName: r.pipeline_name as string, pipelineSnapshot: pj(r.pipeline_snapshot, null),
    cursor: r.cursor as number, loopCounts: pj(r.loop_counts, {}), pendingResume: pj(r.pending_resume, null), status: r.status as PipelineRun['status'],
    createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}
function phaseToRow(p: PhaseRun): Params {
  return { id: p.id, run_id: p.runId, task_id: p.taskId, phase_name: p.phaseName, phase_type: p.phaseType, attempt: p.attempt, status: p.status,
    session_id: p.sessionId, resumed_from_session_id: p.resumedFromSessionId, cost_usd: p.costUsd, num_turns: p.numTurns, result_text: p.resultText,
    structured_output: p.structuredOutput === null || p.structuredOutput === undefined ? null : j(p.structuredOutput), result_subtype: p.resultSubtype,
    error: p.error, transcript_path: p.transcriptPath, artifacts: j(p.artifacts), started_at: p.startedAt, ended_at: p.endedAt };
}
function rowToPhase(r: Row): PhaseRun {
  return { id: r.id as string, runId: r.run_id as string, taskId: r.task_id as string, phaseName: r.phase_name as string, phaseType: r.phase_type as PhaseRun['phaseType'],
    attempt: r.attempt as number, status: r.status as PhaseRun['status'], sessionId: (r.session_id as string) ?? null, resumedFromSessionId: (r.resumed_from_session_id as string) ?? null,
    costUsd: r.cost_usd as number, numTurns: r.num_turns as number, resultText: (r.result_text as string) ?? null, structuredOutput: pj(r.structured_output, null),
    resultSubtype: (r.result_subtype as string) ?? null, error: (r.error as string) ?? null, transcriptPath: (r.transcript_path as string) ?? null,
    artifacts: pj(r.artifacts, {}), startedAt: (r.started_at as string) ?? null, endedAt: (r.ended_at as string) ?? null };
}
function hilToRow(h: HilRequest): Params {
  return { id: h.id, task_id: h.taskId, phase_run_id: h.phaseRunId, kind: h.kind, title: h.title, summary: h.summary, payload: j(h.payload),
    allowed_decisions: j(h.allowedDecisions), next: j(h.next), status: h.status, response: h.response ? j(h.response) : null, answered_via: h.answeredVia,
    expires_at: h.expiresAt, created_at: h.createdAt, answered_at: h.answeredAt };
}
function rowToHil(r: Row): HilRequest {
  return { id: r.id as string, taskId: r.task_id as string, phaseRunId: (r.phase_run_id as string) ?? null, kind: r.kind as HilRequest['kind'], title: r.title as string,
    summary: r.summary as string, payload: pj(r.payload, null as unknown as HilRequest['payload']), allowedDecisions: pj(r.allowed_decisions, []), next: pj(r.next, {}),
    status: r.status as HilRequest['status'], response: pj(r.response, null), answeredVia: (r.answered_via as HilRequest['answeredVia']) ?? null,
    expiresAt: (r.expires_at as string) ?? null, createdAt: r.created_at as string, answeredAt: (r.answered_at as string) ?? null };
}
