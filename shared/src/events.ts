import type { HilRequest, PhaseRun, Task } from './types.js';

export type EventType =
  | 'task.created' | 'task.status' | 'task.updated' | 'task.cost' | 'task.worktree' | 'task.branch'
  | 'phase.started' | 'phase.progress' | 'phase.finished' | 'phase.paused' | 'phase.resumed'
  | 'hil.requested' | 'hil.answered' | 'hil.expired' | 'hil.reminder'
  | 'git.committed' | 'git.pushed' | 'git.pr_created' | 'git.merged'
  | 'notifier.sent' | 'notifier.error'
  | 'engine.warning' | 'engine.error';

export interface EventPayloads {
  'task.created': { task: Task };
  'task.status': { task: Task; from: string; to: string };
  'task.updated': { task: Task; change: string };
  'task.cost': { taskId: string; totalCostUsd: number };
  'task.worktree': { taskId: string; action: 'removed' | 'recreated'; branchDeleted?: boolean };
  'task.branch': { taskId: string; from: string; to: string };
  'phase.started': { phaseRun: PhaseRun };
  'phase.progress': { phaseRunId: string; toolName: string; summary: string };
  'phase.finished': { phaseRun: PhaseRun };
  'phase.paused': { phaseRun: PhaseRun; reason: string };
  'phase.resumed': { phaseRun: PhaseRun };
  'hil.requested': { hil: HilRequest };
  'hil.answered': { hil: HilRequest };
  'hil.expired': { hil: HilRequest };
  'hil.reminder': { hil: HilRequest };
  'git.committed': { taskId: string; sha: string; message: string };
  'git.pushed': { taskId: string; branch: string };
  'git.pr_created': { taskId: string; url: string; number: number };
  'git.merged': { taskId: string; method: string; into: string; via: 'pr' | 'local' | 'external' };
  'notifier.sent': { channel: string; hilId?: string };
  'notifier.error': { channel: string; message: string };
  'engine.warning': { taskId?: string; message: string };
  'engine.error': { taskId?: string; phaseRunId?: string; message: string; stack?: string };
}

export interface SdlcEvent<T extends EventType = EventType> {
  id: number;
  ts: string;
  type: T;
  taskId: string | null;
  phaseRunId: string | null;
  payload: EventPayloads[T];
}

/** Live SDK message frame (not persisted in the events table). */
export interface MessageFrame {
  taskId: string;
  phaseRunId: string;
  line: number;
  sdk: unknown;
}
