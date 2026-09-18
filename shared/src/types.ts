export type PhaseType = 'claude' | 'shell' | 'hil' | 'git';

export type TaskStatus =
  | 'created' | 'running' | 'waiting_hil' | 'paused' | 'pr_open' | 'succeeded' | 'failed' | 'aborted';

export type ReviewMode = 'conceptual' | 'line';

export interface Task {
  id: string;
  title: string;
  initialPrompt: string;
  refinedPrompt: string | null;
  repoPath: string;
  repoSlug: string | null;
  baseRemote: string | null;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  pipelineName: string;
  reviewMode: ReviewMode;
  postReview: boolean;
  status: TaskStatus;
  totalCostUsd: number;
  prUrl: string | null;
  prNumber: number | null;
  prFeedbackCursor: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'running' | 'waiting_hil' | 'paused' | 'succeeded' | 'failed' | 'aborted';

export interface PendingResume { phase: string; feedback: string }

export interface PipelineRun {
  id: string;
  taskId: string;
  pipelineName: string;
  pipelineSnapshot: unknown; // PipelineSpec, typed on the server
  cursor: number;
  loopCounts: Record<string, number>;
  pendingResume: PendingResume | null;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export type PhaseRunStatus =
  | 'pending' | 'running' | 'waiting_hil' | 'paused' | 'succeeded' | 'failed' | 'skipped' | 'aborted';

export interface PhaseRun {
  id: string;
  runId: string;
  taskId: string;
  phaseName: string;
  phaseType: PhaseType;
  attempt: number;
  status: PhaseRunStatus;
  sessionId: string | null;
  resumedFromSessionId: string | null;
  costUsd: number;
  numTurns: number;
  resultText: string | null;
  structuredOutput: unknown | null;
  resultSubtype: string | null;
  error: string | null;
  transcriptPath: string | null;
  artifacts: Record<string, string>;
  startedAt: string | null;
  endedAt: string | null;
}

export type HilKind = 'refine_prompt' | 'approve_plan' | 'approve_result' | 'pr_feedback' | 'question' | 'escalation';

export type HilDecision =
  | 'approve' | 'request_changes' | 'abort'
  | 'allow' | 'allow_session' | 'deny'
  | 'answer'
  | 'retry' | 'resume' | 'skip';

export interface ReviewFinding {
  severity: 'blocking' | 'should_fix' | 'nit';
  file?: string;
  line?: number;
  title: string;
  description: string;
  suggestion?: string;
}
export interface ReviewOutput { verdict: 'approve' | 'request_changes'; summary: string; findings: ReviewFinding[] }

export interface TestOutput { verdict: 'pass' | 'fail' | 'skipped'; summary: string; commands: string[]; tests_added: string[]; failures: { title: string; description: string; file?: string; line?: number }[]; notes: string }
export interface QaOutput { verdict: 'pass' | 'issues' | 'skipped'; summary: string; checks: { name: string; method: string; result: 'ok' | 'failed' | 'not_run' }[]; issues: { severity: 'blocking' | 'should_fix' | 'nit'; title: string; description: string }[] }

export interface ClarifyQuestion { question: string; header: string; options?: string[] }
export interface ClarifyOutput { title?: string; questions: ClarifyQuestion[]; suggestedPrompt: string; assumptions: string[] }

export interface AskUserQuestionItem {
  question: string; header: string; multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type HilPayload =
  | { kind: 'refine_prompt'; prompt: string; questions: ClarifyQuestion[]; suggestedPrompt: string | null; assumptions: string[]; suggestedTitle: string | null }
  | { kind: 'approve_plan'; planMd: string; summary: string; costUsd: number }
  | { kind: 'approve_result'; diffStat: string; diff: string; testOutput: string | null; test: TestOutput | null; review: ReviewOutput | null; qa: QaOutput | null; commits: string[]; branch: string }
  | { kind: 'pr_feedback'; prUrl: string; comments: { id: string; author: string; body: string; path?: string; line?: number; url: string; reviewState?: string }[] }
  | { kind: 'question'; questions: AskUserQuestionItem[] }
  | { kind: 'escalation'; phaseName: string; error: string; resultSubtype: string | null };

export interface HilResponse {
  decision: HilDecision;
  comment?: string;
  edited?: { prompt?: string; planMd?: string; title?: string };
  answers?: Record<string, string>;
}

export type HilStatus = 'open' | 'answered' | 'expired' | 'cancelled';

export interface HilRequest {
  id: string;
  taskId: string;
  phaseRunId: string | null;
  kind: HilKind;
  title: string;
  summary: string;
  payload: HilPayload;
  allowedDecisions: HilDecision[];
  next: Partial<Record<HilDecision, string>>;
  status: HilStatus;
  response: HilResponse | null;
  answeredVia: 'web' | 'telegram' | 'cli' | 'timeout' | null;
  expiresAt: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export const HIL_DECISIONS: Record<HilKind, HilDecision[]> = {
  refine_prompt: ['approve', 'abort'],
  approve_plan: ['approve', 'request_changes', 'abort'],
  approve_result: ['approve', 'request_changes', 'abort'],
  pr_feedback: ['approve', 'skip', 'abort'],
  question: ['answer', 'abort'],
  escalation: ['retry', 'resume', 'skip', 'abort'],
};
