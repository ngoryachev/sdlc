import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionItem, HilRequest, HilResponse, ModelOverrides, PhaseRun, PipelineRun, Task, TaskStatus } from '@sdlc/shared';
import { ACTIVE_STATUSES, FINISHED_STATUSES } from '@sdlc/shared';
import type { SdlcConfig } from '../config/config.js';
import { loadRepoConfig, parseDuration } from '../config/config.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { findPipelineFile, loadPipeline, phaseIndex, resolvePipelineFile, type LoadedPipeline } from '../pipeline/loader.js';
import type { PhaseSpec, PipelineSpec, RepoConfig } from '../pipeline/schema.js';
import { PipelineSchema } from '../pipeline/schema.js';
import { evalExpr } from '../pipeline/expr.js';
import { renderTemplate } from '../pipeline/template.js';
import { adoptWorktree, branchNameFor, createWorktree, defaultBase, deleteLocalBranch, deleteRemoteBranch, fetchBranch, isAncestor, isSdlcBranch, mergeLocally, push, pushBranch, recreateWorktree, refExists, remoteHasBranch, remotes, removeWorktree, renameBranch, repoToplevel, slugFromRemote, syncBranchWithRemote, syncLocalBase, taskCommitCount } from '../git/git.js';
import { TRUSTED_ASSOCIATIONS, type GitHub, type MergeMethod, type RepoAuth } from '../git/gh.js';
import type { RepoAccounts } from '../git/accounts.js';
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
  /** Work on an existing branch instead of creating one (imported PR, "start from this branch"). */
  branch?: string;
  /** Start the pipeline at this phase; earlier phases are recorded as skipped. 'end' = do not run anything (imported PR waits for feedback). */
  startAt?: string;
  pr?: { number: number; url: string };
  modelOverrides?: ModelOverrides | null;
}

export interface EngineDeps { config: SdlcConfig; store: Store; events: EventBus; runner: ClaudeRunner; github: GitHub; accounts: RepoAccounts; persistConfig: () => void }

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
    let baseRemote = input.baseRemote === undefined ? (repoConfig.base_remote ?? def.remote) : input.baseRemote;
    let baseBranch = input.baseBranch ?? repoConfig.base_branch ?? def.branch;
    // "sdlc/t_123" split on the first slash is not remote "sdlc": when the remote does not exist, treat the whole ref as a local branch.
    if (baseRemote && !(await remotes(repoPath)).includes(baseRemote)) { baseBranch = `${baseRemote}/${baseBranch}`; baseRemote = null; }
    const baseRef = baseRemote ? `${baseRemote}/${baseBranch}` : baseBranch;
    if (!(await refExists(repoPath, baseRef))) throw new Error(`base ref ${baseRef} does not exist in ${repoPath}`);
    const id = newId('t');
    const worktreesDir = config.worktrees_dir ?? path.join(path.dirname(repoPath), '.sdlc-worktrees', path.basename(repoPath));
    const auth = await this.d.accounts.forRepo(repoPath);
    const wt = input.branch
      ? await adoptWorktree({ repo: repoPath, worktreesDir, taskId: id, branch: input.branch, remote: baseRemote, auth })
      : await createWorktree({ repo: repoPath, worktreesDir, taskId: id, baseRemote, baseBranch, copyUntracked: repoConfig.copy_untracked, auth });
    try { await runSetup(repoConfig, wt.worktreePath); }
    catch (e) { await removeWorktree(repoPath, wt.worktreePath, wt.branch, { deleteBranchIfEmpty: wt.baseRef }).catch(() => {}); throw e; }
    const slug = await slugFromRemote(repoPath);
    const now = nowIso();
    const title = input.title ?? titleFrom(input.prompt);
    const task: Task = {
      id, title, initialPrompt: input.prompt, refinedPrompt: null, repoPath, repoSlug: slug,
      baseRemote, baseBranch, branch: wt.branch, worktreePath: wt.worktreePath, pipelineName: loaded.spec.name,
      reviewMode: input.reviewMode ?? repoConfig.review_mode ?? 'conceptual', postReview: input.postReview ?? repoConfig.post_review ?? false,
      status: 'created', totalCostUsd: 0, prUrl: input.pr?.url ?? null, prNumber: input.pr?.number ?? null, prFeedbackCursor: null, modelOverrides: input.modelOverrides ?? null, createdAt: now, updatedAt: now,
    };
    const startIdx = input.startAt === 'end' ? loaded.spec.phases.length : input.startAt ? phaseIndex(loaded.spec, input.startAt) : 0;
    const idle = startIdx >= loaded.spec.phases.length;
    const run: PipelineRun = { id: newId('r'), taskId: id, pipelineName: loaded.spec.name, pipelineSnapshot: { spec: loaded.spec, baseDir: loaded.baseDir, filePath: loaded.filePath },
      cursor: startIdx, loopCounts: {}, pendingResume: null, status: idle ? 'succeeded' : 'running', createdAt: now, updatedAt: now };
    store.tx(() => {
      store.insertTask(task); store.insertRun(run);
      for (const ph of loaded.spec.phases.slice(0, startIdx)) { const pr = this.newPhaseRun(run, task, ph); pr.status = 'skipped'; pr.resultText = `skipped: task started at ${input.startAt}`; pr.endedAt = now; store.insertPhaseRun(pr); }
    });
    events.emit('task.created', { task }, { taskId: id });
    this.registerRepo(repoPath, slug);
    // a readable title and branch (sdlc/<english-slug>-<id>) come from a short haiku call in the background;
    // refine may rename them again later, as long as the branch has not been pushed
    if (!input.title || !input.branch) this.background(id, this.nameTask(id, { title: !input.title, branch: !input.branch }));
    if (idle) { this.setTaskStatus(task, task.prUrl ? 'pr_open' : 'succeeded'); return task; }
    this.setTaskStatus(task, 'running');
    void this.advance(id);
    return task;
  }

  /** Create a task from an existing pull request: its head branch becomes the task branch, the task waits for PR feedback. */
  async importPr(input: { repoPath: string; number: number; pipeline?: string; reviewMode?: 'conceptual' | 'line'; modelOverrides?: ModelOverrides | null }): Promise<Task> {
    const repoPath = await repoToplevel(path.resolve(input.repoPath));
    const pr = await this.d.github.prView(repoPath, input.number, await this.d.accounts.forRepo(repoPath));
    if (pr.state !== 'OPEN') throw new HttpError(409, `PR #${input.number} is ${pr.state}`);
    if (this.d.store.listTasks().some((t) => t.prNumber === pr.number && t.repoPath === repoPath && !['failed', 'aborted', 'merged', 'closed'].includes(t.status))) throw new HttpError(409, `PR #${pr.number} is already attached to a task`);
    const rs = await remotes(repoPath);
    const remote = rs.includes('origin') ? 'origin' : rs[0] ?? null;
    return this.createTask({
      prompt: [pr.title, pr.body].filter(Boolean).join('\n\n'), title: pr.title, repoPath, pipeline: input.pipeline, baseRemote: remote, baseBranch: pr.baseRefName,
      branch: pr.headRefName, pr: { number: pr.number, url: pr.url }, startAt: 'end', reviewMode: input.reviewMode, modelOverrides: input.modelOverrides,
    });
  }

  // ------------------------------------------------------------------ delivery
  /**
   * Merge the task branch into its base (through the PR when there is one), move tasks stacked on this branch onto
   * its base (PRs retargeted on GitHub first), then remove the worktree and the branch.
   */
  async landTask(taskId: string, method?: MergeMethod): Promise<{ method: MergeMethod; via: 'pr' | 'local'; restacked: string[]; notes: string[] }> {
    return this.withLock(taskId, async () => {
      const { store, events, config } = this.d;
      const task = this.mustTask(taskId);
      if (!['pr_open', 'succeeded'].includes(task.status)) throw new HttpError(409, `task is ${task.status}; only pr_open or succeeded tasks can be landed`);
      const m = method ?? config.merge_method;
      const children = this.childTasks(task);
      const busy = children.filter((c) => ACTIVE_STATUSES.includes(c.status));
      if (busy.length) throw new HttpError(409, `tasks stacked on ${task.branch} are still running: ${busy.map(taskLabel).join(', ')}. Wait for them or abort them, then land.`);
      if (children.length && m !== 'merge') throw new HttpError(409, `${children.length} task(s) are stacked on ${task.branch}: ${children.map(taskLabel).join(', ')}. "${m}" would rewrite the commits they build on; land with "merge", or land the stacked tasks first.`);
      const auth = await this.d.accounts.forRepo(task.repoPath);
      const remote = task.baseRemote ?? (await defaultRemote(task.repoPath));
      const notes: string[] = [];
      // the local branch may lag behind its remote copy (PRs merged into it on GitHub) or carry unpushed commits
      const synced = await syncBranchWithRemote({ repo: task.repoPath, remote, branch: task.branch, auth, push: !!task.prNumber }).catch((e) => { throw new HttpError(409, msg(e)); });
      if (synced === 'fast-forwarded' || synced === 'pushed' || synced === 'created') notes.push(`${task.branch}: ${synced} (${remote})`);
      const into = task.baseRemote ? `${task.baseRemote}/${task.baseBranch}` : task.baseBranch;
      let via: 'pr' | 'local';
      if (task.prNumber) { await this.d.github.prMerge(task.repoPath, task.prNumber, m, auth); via = 'pr'; }
      else { await mergeLocally({ repo: task.repoPath, base: task.baseBranch, baseRemote: task.baseRemote, head: task.branch, method: m, message: `${task.title}\n\nsdlc task ${task.id}`, author: config.git_author, auth }); via = 'local'; }
      events.emit('git.merged', { taskId: task.id, method: m, into, via }, { taskId: task.id });
      const re = await this.restack(task, children, auth);
      notes.push(...re.notes);
      // the remote branch goes only when every stacked PR was retargeted: deleting a PR's base closes the PR
      await this.cleanupDelivered(task, auth, { remote, deleteRemote: re.ok });
      const run = store.latestRunForTask(task.id);
      if (run && run.status !== 'succeeded') { run.status = 'succeeded'; this.saveRun(run); }
      this.setTaskStatus(task, 'merged');
      return { method: m, via, restacked: re.moved, notes };
    });
  }

  /** Open a pull request for a finished task that has none (auto pipeline, or PR phase skipped). */
  async createPrForTask(taskId: string, o: { title?: string; draft?: boolean } = {}): Promise<Task> {
    return this.withLock(taskId, async () => {
      const { store, events } = this.d;
      const task = this.mustTask(taskId);
      if (task.prNumber) throw new HttpError(409, `task already has PR #${task.prNumber}`);
      if (task.status !== 'succeeded') throw new HttpError(409, `task is ${task.status}; a pull request can be opened for a finished (succeeded) task`);
      const remote = task.baseRemote ?? (await defaultRemote(task.repoPath));
      if (!remote) throw new HttpError(409, 'the repository has no remote to open a pull request on');
      const auth = await this.d.accounts.forRepo(task.repoPath);
      // catch up with commits merged into the branch on GitHub (stacked PRs); refuse when it diverged
      await syncBranchWithRemote({ repo: task.repoPath, remote, branch: task.branch, auth, push: false }).catch((e) => { throw new HttpError(409, msg(e)); });
      if (!task.baseRemote && !(await remoteHasBranch(task.repoPath, remote, task.baseBranch, auth))) {
        await pushBranch(task.repoPath, remote, task.baseBranch, auth);
        events.emit('git.pushed', { taskId, branch: task.baseBranch }, { taskId });
      }
      await push(task.repoPath, remote, task.branch, auth);
      events.emit('git.pushed', { taskId, branch: task.branch }, { taskId });
      const title = o.title?.trim() || task.title;
      const created = await this.d.github.prCreate({ cwd: task.repoPath, head: task.branch, base: task.baseBranch, title, body: this.prBody(task), draft: !!o.draft }, auth);
      const fresh = this.mustTask(taskId);
      fresh.prUrl = created.url; fresh.prNumber = created.number; fresh.title = title; fresh.updatedAt = nowIso(); store.updateTask(fresh);
      events.emit('git.pr_created', { taskId, url: created.url, number: created.number }, { taskId });
      this.setTaskStatus(fresh, 'pr_open');
      return this.mustTask(taskId);
    });
  }

  /** Drop a task without merging: worktree removed, PR closed (optional), branch deleted (optional). */
  async closeTask(taskId: string, o: { deleteBranch?: boolean; closePr?: boolean } = {}): Promise<Task> {
    return this.withLock(taskId, async () => {
      const task = this.mustTask(taskId);
      if (!['succeeded', 'failed', 'pr_open'].includes(task.status)) throw new HttpError(409, `task is ${task.status}; only finished tasks (succeeded, failed, pr_open) can be closed; use Abort for a running one`);
      const children = this.childTasks(task);
      if (o.deleteBranch && children.length) throw new HttpError(409, `tasks are stacked on ${task.branch}: ${children.map(taskLabel).join(', ')}. Close without deleting the branch, or deal with them first.`);
      const auth = await this.d.accounts.forRepo(task.repoPath);
      if (task.prNumber && task.status === 'pr_open' && o.closePr !== false) await this.d.github.prClose(task.repoPath, task.prNumber, auth);
      const wt = await removeWorktree(task.repoPath, task.worktreePath, task.branch).catch(() => ({ removed: false }));
      let branchDeleted = false;
      if (o.deleteBranch) {
        branchDeleted = await deleteLocalBranch(task.repoPath, task.branch);
        if (isSdlcBranch(task.branch, task.id)) branchDeleted = (await deleteRemoteBranch(task.repoPath, task.baseRemote ?? (await defaultRemote(task.repoPath)), task.branch, auth)) || branchDeleted;
      }
      if (wt.removed || branchDeleted) this.d.events.emit('task.worktree', { taskId, action: 'removed', branchDeleted }, { taskId });
      this.setTaskStatus(task, 'closed');
      return this.mustTask(taskId);
    });
  }

  /**
   * Background reconciliation with GitHub (every `pr_sync_interval`, and on demand): merged PRs → merged (with cleanup),
   * closed PRs → closed, base changed on GitHub → followed; tasks without a PR whose commits reached the base → merged.
   */
  async syncTasks(): Promise<{ checked: number; changes: { taskId: string; title: string; change: string }[]; errors: string[] }> {
    const tasks = this.d.store.listTasks(['pr_open', 'succeeded']);
    const changes: { taskId: string; title: string; change: string }[] = [];
    const errors: string[] = [];
    for (const t of tasks) {
      try { const change = await this.withLock(t.id, () => this.syncOne(t.id)); if (change) changes.push({ taskId: t.id, title: t.title, change }); }
      catch (e) { errors.push(`${t.id}: ${msg(e)}`); }
    }
    // merged tasks never keep their worktree or branch (e.g. merged before this cleanup existed)
    for (const t of this.d.store.listTasks(['merged'])) {
      try { const change = await this.withLock(t.id, () => this.sweepMerged(t.id)); if (change) changes.push({ taskId: t.id, title: t.title, change }); }
      catch (e) { errors.push(`${t.id}: ${msg(e)}`); }
    }
    return { checked: tasks.length, changes, errors };
  }

  private async sweepMerged(taskId: string): Promise<string | null> {
    const t = this.d.store.getTask(taskId);
    if (!t || t.status !== 'merged' || !fs.existsSync(t.repoPath)) return null;
    const remote = t.baseRemote ?? (await defaultRemote(t.repoPath));
    const local = await refExists(t.repoPath, `refs/heads/${t.branch}`);
    const tracked = remote ? await refExists(t.repoPath, `refs/remotes/${remote}/${t.branch}`) : false;
    if (!local && !tracked && !fs.existsSync(t.worktreePath)) return null;
    const auth = await this.d.accounts.forRepo(t.repoPath);
    const re = await this.restack(t, this.childTasks(t), auth);
    await this.cleanupDelivered(t, auth, { remote, deleteRemote: re.ok && tracked && isSdlcBranch(t.branch, t.id) });
    return 'leftover worktree/branch removed';
  }

  private async syncOne(taskId: string): Promise<string | null> {
    const t = this.d.store.getTask(taskId);
    if (!t || !['pr_open', 'succeeded'].includes(t.status)) return null;
    const auth = await this.d.accounts.forRepo(t.repoPath);
    if (t.prNumber) {
      if (t.status !== 'pr_open') return null;
      const pr = await this.d.github.prView(t.repoPath, t.prNumber, auth);
      if (pr.state === 'MERGED') { await this.markMerged(t, auth); return 'merged (on GitHub)'; }
      if (pr.state === 'CLOSED') { this.setTaskStatus(t, 'closed'); return 'closed (on GitHub)'; }
      if (pr.baseRefName && pr.baseRefName !== t.baseBranch) {
        const from = t.baseBranch;
        t.baseBranch = pr.baseRefName; t.updatedAt = nowIso(); this.d.store.updateTask(t);
        this.d.events.emit('task.updated', { task: t, change: `base ${from} → ${pr.baseRefName} (changed on GitHub)` }, { taskId });
        return `base → ${pr.baseRefName}`;
      }
      return null;
    }
    // no PR: did the branch reach its base some other way (merged by hand, another tool)?
    if (!(await refExists(t.repoPath, `refs/heads/${t.branch}`))) return null;
    if ((await taskCommitCount(t.repoPath, t.branch, t.id)) === 0) return null;
    if (t.baseRemote && !(await fetchBranch(t.repoPath, t.baseRemote, t.baseBranch, auth).catch(() => false))) return null;
    const baseRef = t.baseRemote ? `refs/remotes/${t.baseRemote}/${t.baseBranch}` : `refs/heads/${t.baseBranch}`;
    if (!(await refExists(t.repoPath, baseRef)) || !(await isAncestor(t.repoPath, `refs/heads/${t.branch}`, baseRef))) return null;
    await this.markMerged(t, auth);
    return 'merged (branch found in its base)';
  }

  /** The task's work reached its base outside sdlc: restack children, clean up, status merged. */
  private async markMerged(task: Task, auth: RepoAuth): Promise<void> {
    const re = await this.restack(task, this.childTasks(task), auth);
    const remote = task.baseRemote ?? (await defaultRemote(task.repoPath));
    await this.cleanupDelivered(task, auth, { remote, deleteRemote: re.ok && isSdlcBranch(task.branch, task.id) });
    this.d.events.emit('git.merged', { taskId: task.id, method: 'unknown', into: task.baseRemote ? `${task.baseRemote}/${task.baseBranch}` : task.baseBranch, via: 'external' }, { taskId: task.id });
    const run = this.d.store.latestRunForTask(task.id);
    if (run && run.status !== 'succeeded') { run.status = 'succeeded'; this.saveRun(run); }
    this.setTaskStatus(task, 'merged');
  }

  /** Tasks stacked on this one move onto its base: their PRs are retargeted on GitHub, their base updated in sdlc. */
  private async restack(parent: Task, children: Task[], auth: RepoAuth): Promise<{ ok: boolean; moved: string[]; notes: string[] }> {
    let ok = true; const moved: string[] = []; const notes: string[] = [];
    for (const c of children) {
      if (c.prNumber) {
        try { await this.d.github.prEditBase(c.repoPath, c.prNumber, parent.baseBranch, auth); }
        catch (e) { ok = false; notes.push(`PR #${c.prNumber} of ${taskLabel(c)} was not retargeted: ${msg(e)}`); continue; }
      }
      const fresh = this.d.store.getTask(c.id);
      if (!fresh) continue;
      const from = fresh.baseBranch;
      fresh.baseBranch = parent.baseBranch; fresh.baseRemote = parent.baseRemote; fresh.updatedAt = nowIso(); this.d.store.updateTask(fresh);
      this.d.events.emit('task.updated', { task: fresh, change: `base ${from} → ${parent.baseBranch} (${taskLabel(parent)} was merged)` }, { taskId: c.id });
      moved.push(c.id);
      notes.push(`${taskLabel(c)} now builds on ${parent.baseBranch}${c.prNumber ? ` (PR #${c.prNumber} retargeted)` : ''}`);
    }
    return { ok, moved, notes };
  }

  private async cleanupDelivered(task: Task, auth: RepoAuth, o: { remote: string | null; deleteRemote: boolean }): Promise<void> {
    const wt = await removeWorktree(task.repoPath, task.worktreePath, task.branch).catch(() => ({ removed: false }));
    await syncLocalBase(task.repoPath, task.baseRemote, task.baseBranch, auth).catch(() => {});
    const local = await deleteLocalBranch(task.repoPath, task.branch);
    const remote = o.deleteRemote ? await deleteRemoteBranch(task.repoPath, o.remote, task.branch, auth) : false;
    if (wt.removed || local || remote) this.d.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: local || remote }, { taskId: task.id });
  }

  /** Tasks whose base is this task's branch (stacked on it); finished ones only on request. */
  childTasks(task: Task, includeFinished = false): Task[] {
    return this.d.store.listTasks().filter((t) => t.id !== task.id && t.repoPath === task.repoPath && t.baseBranch === task.branch && (includeFinished || !FINISHED_STATUSES.includes(t.status)));
  }

  private prBody(task: Task): string {
    const { store } = this.d;
    const run = store.latestRunForTask(task.id);
    let body = `Task: ${task.id}`;
    if (run) {
      try {
        const { spec, loaded } = snapshot(run);
        const tpl = buildTemplateContext({ task, run, spec, repoConfig: loadRepoConfig(task.repoPath), store });
        body = renderTemplate(fs.readFileSync(resolvePipelineFile(loaded, 'prompts/pr_body.md'), 'utf8'), tpl);
      } catch { /* keep the minimal body */ }
    }
    const stacked = this.childTasks(task, true).filter((c) => c.status === 'merged');
    if (!stacked.length) return body;
    const section = `### Stacked tasks already merged into this branch\n\n${stacked.map((c) => `- ${c.title}${c.prUrl ? ` (${c.prUrl})` : ''}`).join('\n')}\n\n`;
    const footer = body.lastIndexOf('\n---\n');
    return footer >= 0 ? `${body.slice(0, footer + 1)}\n${section}${body.slice(footer + 1)}` : `${body}\n\n${section}`;
  }

  private registerRepo(repoPath: string, slug: string | null): void {
    const { config } = this.d;
    if (config.repos.some((r) => path.resolve(r.path) === path.resolve(repoPath))) return;
    const base = slug ?? path.basename(repoPath);
    config.repos.push({ name: config.repos.some((r) => r.name === base) ? `${base} (${repoPath})` : base, path: repoPath });
    this.d.persistConfig();
  }

  /** Title and branch slug from one cheap model call, applied only if nobody (refine) changed them meanwhile. */
  private async nameTask(taskId: string, want: { title: boolean; branch: boolean }): Promise<void> {
    if (!this.d.runner.brief) return;
    const before = this.d.store.getTask(taskId);
    if (!before) return;
    let raw = '';
    try { raw = await this.d.runner.brief(namingPrompt(before.initialPrompt)); } catch { return; }
    const named = parseNaming(raw);
    const task = this.d.store.getTask(taskId);
    if (!task) return;
    if (want.title && named.title && !task.refinedPrompt && task.title === before.title && named.title !== task.title) {
      task.title = named.title; task.updatedAt = nowIso(); this.d.store.updateTask(task);
      this.d.events.emit('task.updated', { task, change: 'title' }, { taskId });
    }
    if (want.branch && named.branch && task.branch === `sdlc/${task.id}`) await this.renameBranchTo(task, named.branch);
  }

  private bg = new Map<string, Promise<void>>();
  private background(taskId: string, p: Promise<void>): void {
    const q: Promise<void> = p.catch((e) => { this.d.events.emit('engine.warning', { taskId, message: `background: ${msg(e)}` }, { taskId }); }).finally(() => { if (this.bg.get(taskId) === q) this.bg.delete(taskId); });
    this.bg.set(taskId, q);
  }
  /** Wait for a task's background work (naming). Used by tests and the CLI. */
  async settled(taskId: string): Promise<void> { await this.bg.get(taskId); }

  private locks = new Map<string, Promise<unknown>>();
  /** Serialize delivery operations (land, create PR, close, sync, PR feedback) per task. */
  private withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(taskId, tail);
    void tail.finally(() => { if (this.locks.get(taskId) === tail) this.locks.delete(taskId); });
    return run;
  }

  private mustTask(id: string): Task { const t = this.d.store.getTask(id); if (!t) throw new HttpError(404, 'task not found'); return t; }

  /** Rename the task branch while it is still local (no PR, sdlc-created, worktree present). */
  private async renameBranchTo(task: Task, summary: string): Promise<void> {
    if (task.prNumber || !isSdlcBranch(task.branch, task.id) || !fs.existsSync(path.join(task.worktreePath, '.git'))) return;
    if (await refExists(task.repoPath, `refs/remotes/${task.baseRemote ?? 'origin'}/${task.branch}`)) return;   // already pushed
    const to = branchNameFor(summary, task.id);
    if (to === task.branch) return;
    const from = task.branch;
    try { await renameBranch(task.worktreePath, to); }
    catch (e) { this.d.events.emit('engine.warning', { taskId: task.id, message: `branch rename failed: ${e instanceof Error ? e.message : String(e)}` }, { taskId: task.id }); return; }
    task.branch = to;
    const fresh = this.d.store.getTask(task.id);
    if (fresh) { fresh.branch = to; fresh.updatedAt = nowIso(); this.d.store.updateTask(fresh); }
    this.d.events.emit('task.branch', { taskId: task.id, from, to }, { taskId: task.id });
  }

  setModelOverrides(taskId: string, overrides: ModelOverrides | null): Task {
    const task = this.d.store.getTask(taskId);
    if (!task) throw new HttpError(404, 'task not found');
    task.modelOverrides = overrides && Object.keys(overrides).length ? overrides : null;
    task.updatedAt = nowIso(); this.d.store.updateTask(task);
    return task;
  }

  /** Kick the state machine for a task. Serialized per task; safe to call from anywhere. */
  advance(taskId: string): Promise<void> {
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(() => this.advanceInner(taskId)).catch((e) => {
      this.d.events.emit('engine.error', { taskId, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, { taskId });
      const t = this.d.store.getTask(taskId);
      if (t && !['succeeded', 'merged', 'closed', 'failed', 'aborted'].includes(t.status)) this.setTaskStatus(t, 'failed');
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
      if (phase.type === 'claude' && this.d.config.task_budget_usd !== 'off' && task.totalCostUsd >= this.d.config.task_budget_usd) {
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
        task, run, spec, loaded, repoConfig, config: this.d.config, store, events, runner: this.d.runner, github: this.d.github, accounts: this.d.accounts, tpl,
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
          if (policy?.then === 'continue') { run.cursor++; this.saveRun(run); continue; }   // best-effort phase: go on without it
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
        if (p.suggestedBranch) await this.renameBranchTo(task, p.suggestedBranch);
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
          await this.ensureWorktree(task);
          const p = hil.payload as Extract<typeof hil.payload, { kind: 'pr_feedback' }>;
          const text = p.comments.map((c) => `- ${c.author}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : ''}: ${c.body}`).join('\n');
          task.prFeedbackCursor = p.comments.at(-1)?.id ?? task.prFeedbackCursor;
          goBack(backTarget(['implement']), `Reviewers left comments on the pull request. Address each one, keep changes minimal, then stop.\n\n${text}${response.comment ? `\n\nAdditional guidance: ${response.comment}` : ''}`);
        } else { // skip: stay idle with the PR open
          closePhase('skipped', 'skipped');
          run.status = 'succeeded'; this.saveRun(run);
          this.setTaskStatus(task, 'pr_open');
          return hil;
        }
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
    return this.withLock(taskId, () => this.pollPrFeedbackInner(taskId));
  }
  private async pollPrFeedbackInner(taskId: string): Promise<{ new: number; hilId?: string; state?: string }> {
    const { store, events } = this.d;
    const task = store.getTask(taskId);
    if (!task) throw new HttpError(404, 'task not found');
    if (!task.prNumber) throw new HttpError(409, 'task has no pull request');
    if (task.status !== 'pr_open') throw new HttpError(409, `task is ${task.status}; PR feedback can be pulled only while the PR is open and the task idle`);
    if (store.openHilForTask(taskId).some((h) => h.kind === 'pr_feedback')) throw new HttpError(409, 'a pr_feedback request is already open');
    const auth = await this.d.accounts.forRepo(task.repoPath);
    const fb = await this.d.github.prFeedback(task.repoPath, task.prNumber, auth);
    if (fb.state === 'MERGED') { await this.markMerged(task, auth); return { new: 0, state: fb.state }; }
    if (fb.state === 'CLOSED') { this.setTaskStatus(task, 'closed'); return { new: 0, state: fb.state }; }
    const cursorIdx = task.prFeedbackCursor ? fb.comments.findIndex((c) => c.id === task.prFeedbackCursor) : -1;
    const all = fb.comments.slice(cursorIdx + 1).filter((c) => c.body.trim());
    const me = auth.user;   // the account sdlc posts with for this repo: its own comments (QA report, "addressed" notes) are never feedback
    const others = me ? all.filter((c) => c.author !== me) : all;
    const fresh = this.d.config.pr_feedback_from === 'anyone' ? others : others.filter((c) => !c.association || TRUSTED_ASSOCIATIONS.has(c.association));
    if (others.length !== fresh.length) events.emit('engine.warning', { taskId, message: `pr feedback: ignored ${others.length - fresh.length} comment(s) from non-collaborators (pr_feedback_from: collaborators)` }, { taskId });
    if (!fresh.length && all.length) { task.prFeedbackCursor = all.at(-1)!.id; task.updatedAt = nowIso(); store.updateTask(task); }
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
    if (['succeeded', 'merged', 'closed', 'failed', 'aborted'].includes(task.status)) throw new HttpError(409, `task already ${task.status}`);
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

  /** Worktrees are removed by the cleanup policy; a PR feedback round needs it back. */
  private async ensureWorktree(task: Task): Promise<void> {
    if (fs.existsSync(path.join(task.worktreePath, '.git'))) return;
    await recreateWorktree({ repo: task.repoPath, worktreePath: task.worktreePath, branch: task.branch, remote: task.baseRemote ?? (await defaultRemote(task.repoPath)), auth: await this.d.accounts.forRepo(task.repoPath) });
    await runSetup(loadRepoConfig(task.repoPath), task.worktreePath);
    this.d.events.emit('task.worktree', { taskId: task.id, action: 'recreated' }, { taskId: task.id });
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
  /** Automatic cleanup runs only with `cleanup: on_pr|on_approve`; the default (`never`) leaves worktrees for an explicit `removeTaskWorktree`. */
  private async cleanup(task: Task, status: 'succeeded' | 'failed' | 'aborted') {
    const policy = this.d.config.cleanup;
    if (policy === 'never') return;
    if (status === 'failed') return;
    try { await this.dropWorktree(task, status === 'aborted'); }
    catch (e) { this.d.events.emit('engine.warning', { taskId: task.id, message: `cleanup failed: ${e instanceof Error ? e.message : String(e)}` }, { taskId: task.id }); }
  }

  /** Explicit worktree removal (UI button / `sdlc cleanup`). The branch is kept; a PR feedback round re-creates the worktree. */
  async removeTaskWorktree(taskId: string): Promise<{ removed: boolean }> {
    const task = this.d.store.getTask(taskId);
    if (!task) throw new HttpError(404, 'task not found');
    if (!['succeeded', 'merged', 'closed', 'failed', 'aborted', 'pr_open'].includes(task.status)) throw new HttpError(409, `task is ${task.status}; the worktree can be removed only when the task is idle`);
    return this.dropWorktree(task, task.status === 'aborted');
  }

  private async dropWorktree(task: Task, deleteEmptyBranch: boolean): Promise<{ removed: boolean }> {
    const baseRef = task.baseRemote ? `${task.baseRemote}/${task.baseBranch}` : task.baseBranch;
    const r = await removeWorktree(task.repoPath, task.worktreePath, task.branch, { deleteBranchIfEmpty: deleteEmptyBranch ? baseRef : undefined });
    if (r.removed) this.d.events.emit('task.worktree', { taskId: task.id, action: 'removed', branchDeleted: r.branchDeleted }, { taskId: task.id });
    return { removed: r.removed };
  }
}

async function runSetup(repoConfig: RepoConfig, cwd: string): Promise<void> {
  if (!repoConfig.setup_command) return;
  try {
    await execFileP('sh', ['-c', repoConfig.setup_command], { cwd, timeout: repoConfig.setup_timeout_sec * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new HttpError(500, `setup_command failed in worktree: ${(err.stderr || err.message).slice(0, 2000)}`);
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const taskLabel = (t: Task) => `"${t.title}" (${t.id})`;
async function defaultRemote(repo: string): Promise<string | null> { const rs = await remotes(repo).catch(() => [] as string[]); return rs.includes('origin') ? 'origin' : rs[0] ?? null; }

export function namingPrompt(text: string): string {
  // small models drift to English; name the language explicitly when the script tells it
  const lang = /[\u0400-\u04FF]/.test(text) ? 'Russian (the task is written in Russian)' : 'the same language as the task text';
  return `Name this development task. Reply with one line of JSON and nothing else: {"title": "...", "branch": "..."}
- title: at most 60 characters, imperative mood, written in ${lang}, no trailing period.
- branch: 2 to 5 English words, lowercase, hyphen-separated, no ids or punctuation.

Task:
${text.slice(0, 3000)}`;
}

export function parseNaming(raw: string): { title?: string; branch?: string } {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { title?: unknown; branch?: unknown };
      let title = typeof j.title === 'string' ? j.title.trim().replace(/[.。]+$/, '') : undefined;
      if (title && title.length > 60) title = title.slice(0, 59).replace(/\s+\S*$/, '') + '…';
      return { title: title || undefined, branch: typeof j.branch === 'string' && j.branch.trim() ? j.branch.trim() : undefined };
    } catch { /* fall through */ }
  }
  const line = raw.trim().split('\n').pop()?.trim();
  return line && /^[a-z0-9-]+$/.test(line) ? { branch: line } : {};
}

export function titleFrom(prompt: string): string {
  const first = (prompt.trim().split('\n').find((l) => l.trim()) ?? 'task').replace(/^#+\s*/, '');
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.length > 60 ? sentence.slice(0, 57).replace(/\s+\S*$/, '') + '…' : sentence;
}

export type { RepoConfig };
