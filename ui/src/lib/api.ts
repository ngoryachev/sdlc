import type { HilRequest, HilResponse, PhaseRun, PipelineRun, Task } from '@sdlc/shared';

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
export interface TaskDetail { task: Task; run: PipelineRun | null; phaseRuns: PhaseRun[]; openHil: HilRequest[]; worktreeExists: boolean }
export interface Config { publicUrl: string; repos: { name: string; path: string }[]; reposDir: string; defaultPipeline: string; maxParallelTasks: number; taskBudgetUsd: number; cleanup: string; telegram: { enabled: boolean; configured: boolean; chatId: string | null } }
export interface PipelineInfo { name: string; description?: string; phases: { name: string; type: string; hil?: string }[] }

export const api = {
  config: () => req<Config>('GET', '/config'),
  pipelines: () => req<{ pipelines: PipelineInfo[] }>('GET', '/pipelines'),
  tasks: (status?: string) => req<{ tasks: TaskRow[] }>('GET', `/tasks${status ? `?status=${status}` : ''}`),
  task: (id: string) => req<TaskDetail>('GET', `/tasks/${id}`),
  createTask: (b: { prompt: string; repoPath: string; pipeline?: string; baseRemote?: string | null; baseBranch?: string; reviewMode?: string; postReview?: boolean }) => req<Task>('POST', '/tasks', b),
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
  repos: () => req<{ repos: { name: string; path: string; exists: boolean }[] }>('GET', '/repos'),
  githubRepos: (q?: string) => req<{ repos: { slug: string; description: string; isFork: boolean }[] }>('GET', `/repos/github${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  addRepo: (b: { path?: string; slug?: string }) => req<{ name: string; path: string }>('POST', '/repos', b),
  branches: (name: string) => req<{ branches: { remote: string | null; branch: string }[]; default: { remote: string | null; branch: string } }>('GET', `/repos/${encodeURIComponent(name)}/branches`),
  telegramTest: () => req<{ ok: boolean; error?: string }>('POST', '/config/telegram/test'),
};
