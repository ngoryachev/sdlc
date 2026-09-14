import { z } from 'zod';

const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']);
const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const OnFailSchema = z.object({
  retry: z.number().int().min(0).optional(),
  back_to: z.string().optional(),
  feedback: z.string().optional(),
  max_loops: z.number().int().min(0).default(2),
  then: z.enum(['hil', 'fail']).default('hil'),
}).strict();

const Common = {
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  when: z.string().optional(),
  on_fail: OnFailSchema.optional(),
  on_success: z.object({ goto: z.string() }).strict().optional(),
};

export const ClaudePhaseSchema = z.object({
  ...Common,
  type: z.literal('claude'),
  prompt: z.string(),
  system_append: z.string().optional(),
  session: z.union([z.literal('fresh'), z.object({ resume: z.string() }).strict()]).default('fresh'),
  permission_mode: PermissionModeSchema.default('default'),
  allowed_tools: z.array(z.string()).default([]),
  disallowed_tools: z.array(z.string()).default([]),
  write_scope: z.array(z.string()).optional(),
  output_schema: z.string().optional(),
  artifacts: z.record(z.string(), z.string()).default({}),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  mode: z.string().optional(), // review: conceptual|line (templated)
  fail_if: z.string().optional(),
}).strict();

export const ShellPhaseSchema = z.object({
  ...Common,
  type: z.literal('shell'),
  command: z.string(),
  timeout_sec: z.number().int().positive().default(900),
  capture_as: z.string().optional(),
  tail_lines: z.number().int().positive().default(200),
}).strict();

export const HilPhaseSchema = z.object({
  ...Common,
  type: z.literal('hil'),
  hil: z.enum(['refine_prompt', 'approve_plan', 'approve_result']),
  show: z.array(z.string()).default([]),
  timeout: z.string().regex(/^\d+(m|h|d)$/).optional(),
  back_to: z.string().optional(), // where request_changes resumes; defaults by kind
  then_goto: z.string().optional(), // after back_to completes, jump here (default: phase after back_to)
}).strict();

export const GitPhaseSchema = z.object({
  ...Common,
  type: z.literal('git'),
  git: z.enum(['commit', 'push', 'pr']),
  message: z.string().optional(),
  pr: z.object({
    draft: z.union([z.boolean(), z.string()]).default(true),
    title: z.string().optional(),
    body: z.string().optional(),
    post_review: z.union([z.boolean(), z.string()]).default(false),
  }).strict().optional(),
}).strict();

export const PhaseSchema = z.discriminatedUnion('type', [ClaudePhaseSchema, ShellPhaseSchema, HilPhaseSchema, GitPhaseSchema]);

export const PipelineSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  defaults: z.object({
    model: z.string().optional(),
    effort: EffortSchema.optional(),
    max_turns: z.number().int().positive().optional(),
    max_budget_usd: z.number().positive().optional(),
    setting_sources: z.array(z.enum(['user', 'project', 'local'])).default(['project']),
  }).strict().default({ setting_sources: ['project'] }),
  phases: z.array(PhaseSchema).min(1),
}).strict().superRefine((p, ctx) => {
  const names = new Set<string>();
  for (const ph of p.phases) {
    if (names.has(ph.name)) ctx.addIssue({ code: 'custom', message: `duplicate phase name: ${ph.name}`, path: ['phases'] });
    names.add(ph.name);
  }
  for (const ph of p.phases) {
    const refs = [ph.on_fail?.back_to, ph.on_success?.goto, ph.type === 'claude' && typeof ph.session === 'object' ? ph.session.resume : undefined,
      ph.type === 'hil' ? ph.back_to : undefined, ph.type === 'hil' ? ph.then_goto : undefined].filter(Boolean) as string[];
    for (const r of refs) if (!names.has(r)) ctx.addIssue({ code: 'custom', message: `phase ${ph.name} references unknown phase: ${r}`, path: ['phases'] });
  }
});

export type PipelineSpec = z.infer<typeof PipelineSchema>;
export type PhaseSpec = z.infer<typeof PhaseSchema>;
export type ClaudePhaseSpec = z.infer<typeof ClaudePhaseSchema>;
export type ShellPhaseSpec = z.infer<typeof ShellPhaseSchema>;
export type HilPhaseSpec = z.infer<typeof HilPhaseSchema>;
export type GitPhaseSpec = z.infer<typeof GitPhaseSchema>;
export type OnFailSpec = z.infer<typeof OnFailSchema>;

export const RepoConfigSchema = z.object({
  test_command: z.string().optional(),
  setup_command: z.string().optional(),   // run once in a new worktree (e.g. npm ci)
  setup_timeout_sec: z.number().int().positive().default(600),
  lint_command: z.string().optional(),
  base_branch: z.string().optional(),
  base_remote: z.string().optional(),
  allow: z.array(z.string()).default([]),
  copy_untracked: z.array(z.string()).default([]),
  review_mode: z.enum(['conceptual', 'line']).optional(),
  post_review: z.boolean().optional(),
  pr: z.object({ draft: z.boolean().optional() }).strict().optional(),
}).strict();
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
