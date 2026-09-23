import type { EffortLevel, HilRequest, HilResponse, ModelOverrides, PhaseRun, PipelineRun, Task } from '@sdlc/shared';

export class ApiError extends Error { constructor(public status: number, message: string, public body: unknown) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (j as { error?: string }).error ?? r.statusText, j);
  return j as T;
}
const text = async (path: string) => { const r = await fetch(`/api${path}`); if (!r.ok) throw new ApiError(r.status, r.statusText, null); return r.text(); };

export type TaskRow = Task & { openHil: number; currentPhase: string | null };
export type HilRow = HilRequest & { task: { id: string; title: string; status: string } };
export interface BaseChainItem { branch: string; taskId?: string; title?: string; status?: string }
export interface TaskChild { id: string; title: string; status: string; branch: string; prUrl: string | null; prNumber: number | null }
export interface TaskDetail { task: Task; run: PipelineRun | null; phaseRuns: PhaseRun[]; openHil: HilRequest[]; worktreeExists: boolean; baseChain: BaseChainItem[]; children: TaskChild[] }
export interface GhAccount { login: string; active: boolean }
export interface RegisteredRepo { name: string; path: string; ghUser: string | null; exists: boolean }
export interface GhRepoRow { slug: string; description: string; isFork: boolean; isPrivate: boolean; pushedAt: string | null; defaultBranch: string; canPush: boolean; cloned: boolean }
export interface SyncResult { checked: number; changes: { taskId: string; title: string; change: string }[]; errors: string[] }
export interface ModelsConfig { default?: string; effort?: EffortLevel; phases: Record<string, { model?: string; effort?: EffortLevel }> }
export interface Config { publicUrl: string; repos: { name: string; path: string; ghUser: string | null }[]; reposDir: string; prSyncInterval: string; defaultPipeline: string; maxParallelTasks: number; taskBudgetUsd: number | 'off'; limits: { phases: 'pipeline' | 'off' }; mergeMethod: 'merge' | 'squash' | 'rebase'; cleanup: string; models: ModelsConfig; telegram: { enabled: boolean; configured: boolean; chatId: string | null } }
export type ConfigPatch = Partial<Pick<Config, 'limits' | 'mergeMethod' | 'cleanup' | 'models'>> & { default_pipeline?: string; max_parallel_tasks?: number; task_budget_usd?: number | 'off'; merge_method?: string };
export interface ModelChoice { value: string; displayName: string; description?: string }
export interface PipelineInfo { name: string; description?: string; phases: { name: string; type: string; hil?: string }[] }

export const api = {
  config: () => req<Config>('GET', '/config'),
  updateConfig: (b: Record<string, unknown>) => req<Config>('PUT', '/config', b),
  models: () => req<{ models: ModelChoice[]; error?: string }>('GET', '/models'),
  importPr: (b: { repoPath: string; number: number; pipeline?: string; modelOverrides?: ModelOverrides | null }) => req<Task>('POST', '/tasks/import-pr', b),
  land: (id: string, method?: string) => req<{ method: string; via: string; notes: string[] }>('POST', `/tasks/${id}/land`, method ? { method } : {}),
  createPr: (id: string, b: { title?: string; draft?: boolean }) => req<Task>('POST', `/tasks/${id}/pr`, b),
  closeTask: (id: string, b: { deleteBranch?: boolean; closePr?: boolean }) => req<Task>('POST', `/tasks/${id}/close`, b),
  sync: () => req<SyncResult>('POST', '/tasks/sync'),
  ghAccounts: () => req<{ accounts: GhAccount[]; error?: string }>('GET', '/gh/accounts'),
  setRepoAccount: (name: string, ghUser: string | null) => req<{ name: string; path: string; ghUser: string | null }>('PUT', `/repos/${encodeURIComponent(name)}`, { gh_user: ghUser }),
  githubBranches: (slug: string, account: string | null) => req<{ branches: { remote: string | null; branch: string }[] }>('GET', `/repos/github/branches?slug=${encodeURIComponent(slug)}${account ? `&account=${encodeURIComponent(account)}` : ''}`),
  taskModels: (id: string, modelOverrides: ModelOverrides | null) => req<Task>('PUT', `/tasks/${id}/models`, { modelOverrides }),
  pipelines: () => req<{ pipelines: PipelineInfo[] }>('GET', '/pipelines'),
  tasks: (status?: string) => req<{ tasks: TaskRow[] }>('GET', `/tasks${status ? `?status=${status}` : ''}`),
  task: (id: string) => req<TaskDetail>('GET', `/tasks/${id}`),
  createTask: (b: { prompt: string; repoPath: string; pipeline?: string; baseRemote?: string | null; baseBranch?: string; reviewMode?: string; postReview?: boolean; branch?: string; startAt?: string; modelOverrides?: ModelOverrides | null }) => req<Task>('POST', '/tasks', b),
  control: (id: string, action: 'pause' | 'resume' | 'abort', body?: unknown) => req<Task>('POST', `/tasks/${id}/${action}`, body),
  inject: (id: string, t: string) => req<{ deliveredTo: string }>('POST', `/tasks/${id}/inject`, { text: t }),
  worktreeRemove: (id: string) => req<{ removed: boolean }>('POST', `/tasks/${id}/worktree/remove`),
  prPoll: (id: string) => req<{ new: number; hilId?: string; state?: string }>('POST', `/tasks/${id}/pr/poll`),
  diff: (id: string) => req<{ stat: string; patch: string; commits: string[]; missing?: boolean }>('GET', `/tasks/${id}/diff`),
  artifacts: (id: string) => req<{ artifacts: { name: string; size: number }[] }>('GET', `/tasks/${id}/artifacts`),
  artifact: (id: string, name: string) => text(`/tasks/${id}/artifacts/${encodeURIComponent(name)}`),
  transcript: (phaseRunId: string, from = 0, limit = 500) => req<{ lines: unknown[]; next: number; eof: boolean }>('GET', `/phase-runs/${phaseRunId}/transcript?from=${from}&limit=${limit}`),
  hil: (status = 'open') => req<{ requests: HilRow[] }>('GET', `/hil?status=${status}`),
  hilOne: (id: string) => req<HilRow>('GET', `/hil/${id}`),
  respond: (id: string, r: HilResponse) => req<HilRequest>('POST', `/hil/${id}/respond`, r),
  events: (since = 0, limit = 200) => req<{ events: unknown[] }>('GET', `/events/history?since=${since}&limit=${limit}`),
  repos: () => req<{ repos: RegisteredRepo[] }>('GET', '/repos'),
  githubRepos: (account?: string) => req<{ account: string | null; repos: GhRepoRow[] }>('GET', `/repos/github${account ? `?account=${encodeURIComponent(account)}` : ''}`),
  addRepo: (b: { path?: string; slug?: string; gh_user?: string | null }) => req<{ name: string; path: string; ghUser: string | null }>('POST', '/repos', { ...b, gh_user: b.gh_user ?? undefined }),
  branches: (name: string) => req<{ branches: { remote: string | null; branch: string }[]; default: { remote: string | null; branch: string } }>('GET', `/repos/${encodeURIComponent(name)}/branches`),
  telegramTest: () => req<{ ok: boolean; error?: string }>('POST', '/config/telegram/test'),
};
