import type { PhaseRun, PipelineRun, Task } from '@sdlc/shared';
import type { PhaseSpec, PipelineSpec, RepoConfig } from '../pipeline/schema.js';
import type { LoadedPipeline } from '../pipeline/loader.js';
import type { SdlcConfig } from '../config/config.js';
import type { Store } from '../store/repo.js';
import type { EventBus } from '../store/events.js';
import type { ClaudeRunner } from '../claude/runner.js';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { TemplateContext } from '../pipeline/template.js';

export type PhaseOutcome =
  | { kind: 'ok' }
  | { kind: 'skipped' }
  | { kind: 'failed'; error: string }
  | { kind: 'wait_hil'; hilId: string }
  | { kind: 'paused'; reason: string }
  | { kind: 'aborted' };

export interface PhaseContext {
  task: Task;
  run: PipelineRun;
  spec: PipelineSpec;
  loaded: LoadedPipeline;
  repoConfig: RepoConfig;
  config: SdlcConfig;
  store: Store;
  events: EventBus;
  runner: ClaudeRunner;
  /** Template context (task.*, phases.*, artifacts.*, repo.*, loop.*, hil.*). */
  tpl: TemplateContext;
  /** Feedback to deliver by resuming this phase's previous session (set when re-entering via back_to / request_changes). */
  resumeFeedback: string | null;
  /** True when abort() was requested for this task; executors use it to classify an interrupted run. */
  abortRequested: boolean;
  /** Builds the canUseTool bridge (AskUserQuestion → HIL) for a phase run. */
  canUseTool?: (pr: PhaseRun) => CanUseTool | undefined;
  /** Register a live handle so the engine can pause/abort/inject. */
  registerHandle(h: LiveHandle | null): void;
  /** Update task/phaseRun in the store and emit status events. */
  persistPhase(p: PhaseRun): void;
}

export interface LiveHandle {
  inject(text: string): void;
  interrupt(): Promise<void>;
  abort(): void;
}

export interface PhaseExecutor<S extends PhaseSpec = PhaseSpec> {
  run(phase: S, phaseRun: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome>;
}
