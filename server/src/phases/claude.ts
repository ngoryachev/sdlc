import fs from 'node:fs';
import path from 'node:path';
import type { EffortLevel, ModelOverrides, PhaseRun } from '@sdlc/shared';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudePhaseSpec } from '../pipeline/schema.js';
import { renderTemplate } from '../pipeline/template.js';
import { evalExpr } from '../pipeline/expr.js';
import { resolvePipelineFile } from '../pipeline/loader.js';
import { TranscriptWriter } from '../claude/transcript.js';
import { toolSummary } from '../claude/render.js';
import type { ClaudeRunSpec } from '../claude/runner.js';
import { nowIso } from '../store/ids.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export class ClaudePhaseExecutor implements PhaseExecutor<ClaudePhaseSpec> {
  async run(phase: ClaudePhaseSpec, pr: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome> {
    const { task, run, spec, loaded, repoConfig, config, store, events } = ctx;

    // prompt: file, templated; review mode picks a variant file if present
    let promptFile = phase.prompt;
    if (phase.mode) {
      const mode = renderTemplate(phase.mode, ctx.tpl);
      const variant = promptFile.replace(/\.md$/, `_${mode}.md`);
      try { resolvePipelineFile(loaded, variant); promptFile = variant; } catch { /* keep base prompt */ }
    }
    const basePrompt = renderTemplate(fs.readFileSync(resolvePipelineFile(loaded, promptFile), 'utf8'), ctx.tpl);
    const common = fs.readFileSync(resolvePipelineFile(loaded, 'prompts/system/common.md'), 'utf8');
    const extra = phase.system_append ? renderTemplate(fs.readFileSync(resolvePipelineFile(loaded, phase.system_append), 'utf8'), ctx.tpl) : '';
    const systemAppend = [common, extra].filter(Boolean).join('\n\n');

    // session resolution
    let resume: string | undefined;
    let prompt = basePrompt;
    if (ctx.resumeFeedback) {
      const prev = store.latestPhaseRun(run.id, phase.name, ['succeeded', 'failed', 'paused', 'aborted']);
      if (prev?.sessionId) { resume = prev.sessionId; prompt = ctx.resumeFeedback; }
      else prompt = `${basePrompt}\n\n---\nAdditional feedback from a previous attempt:\n${ctx.resumeFeedback}`;
    } else if (typeof phase.session === 'object') {
      const src = store.latestPhaseRun(run.id, phase.session.resume, ['succeeded', 'paused']);
      if (!src?.sessionId) return { kind: 'failed', error: `phase ${phase.name}: cannot resume session of phase ${phase.session.resume} (no session)` };
      resume = src.sessionId;
    }

    const allowed = [...phase.allowed_tools, ...repoConfig.allow];
    if (repoConfig.test_command) allowed.push(`Bash(${repoConfig.test_command.split(' ')[0]} *)`);
    const outputSchema = phase.output_schema ? JSON.parse(fs.readFileSync(resolvePipelineFile(loaded, phase.output_schema), 'utf8')) as Record<string, unknown> : undefined;

    const transcriptPath = path.join(config.data_dir, 'tasks', task.id, 'phases', `${pr.id}.jsonl`);
    const tw = new TranscriptWriter(transcriptPath);
    tw.write({ type: 'sdlc.meta', phaseRunId: pr.id, phaseName: phase.name, attempt: pr.attempt, resume: resume ?? null, prompt, permissionMode: phase.permission_mode, ts: nowIso() });
    pr.transcriptPath = transcriptPath;
    pr.resumedFromSessionId = resume ?? null;
    ctx.persistPhase(pr);

    // model/effort: task override (phase, then '*') → config for this phase → config default → pipeline. Read at phase start, so config edits apply to the next phase.
    const chosen = resolveModel(phase.name, { phaseModel: phase.model ?? spec.defaults.model, phaseEffort: phase.effort ?? spec.defaults.effort }, config.models, task.modelOverrides);
    tw.write({ type: 'sdlc.model', phaseRunId: pr.id, model: chosen.model ?? '(default)', effort: chosen.effort ?? '(default)', ts: nowIso() });
    const runSpec: ClaudeRunSpec = {
      cwd: task.worktreePath,
      prompt,
      resume,
      permissionMode: phase.permission_mode,
      allowedTools: allowed.length ? allowed : undefined,
      disallowedTools: phase.disallowed_tools.length ? phase.disallowed_tools : undefined,
      systemAppend,
      outputSchema,
      maxTurns: config.limits.phases === 'off' ? undefined : phase.max_turns ?? spec.defaults.max_turns ?? 40,
      maxBudgetUsd: config.limits.phases === 'off' ? undefined : phase.max_budget_usd ?? spec.defaults.max_budget_usd ?? 5,
      model: chosen.model,
      effort: chosen.effort,
      settingSources: spec.defaults.setting_sources,
      writeScope: phase.write_scope,
      readAllow: repoConfig.read_allow.map((d) => path.resolve(task.repoPath, d)),
      canUseTool: ctx.canUseTool?.(pr),
      env: {},
      onToolUse: ({ toolName, toolInput }) => events.emit('phase.progress', { phaseRunId: pr.id, toolName, summary: toolSummary(toolName, (toolInput ?? {}) as Record<string, unknown>) }, { taskId: task.id, phaseRunId: pr.id }),
      onStderr: (l) => { if (l.trim()) events.emit('engine.warning', { taskId: task.id, message: `[claude stderr] ${l.trim().slice(0, 500)}` }, { taskId: task.id, phaseRunId: pr.id }); },
    };

    const handle = ctx.runner.start(runSpec);
    ctx.registerHandle(handle);
    let result: SDKResultMessage | null = null;
    let line = 0;
    try {
      for await (const m of handle.messages) {
        line = tw.write(m);
        events.message({ taskId: task.id, phaseRunId: pr.id, line, sdk: m });
        if (m.type === 'system' && m.subtype === 'init' && !pr.sessionId) { pr.sessionId = m.session_id; ctx.persistPhase(pr); }
        if (m.type === 'result') result = m;
      }
    } finally {
      ctx.registerHandle(null);
      await tw.close();
    }
    if (!result) return { kind: 'failed', error: 'no result message from SDK' };

    // total_cost_usd covers this query() call only (docs), also when resuming a session
    pr.costUsd = result.total_cost_usd;
    pr.numTurns = result.num_turns;
    pr.resultSubtype = result.subtype;
    pr.endedAt = nowIso();
    if (result.subtype === 'success') {
      pr.resultText = result.result;
      pr.structuredOutput = normalizeStrings(result.structured_output ?? null);
      if (result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted_tools') {
        return ctx.abortRequested ? { kind: 'aborted' } : { kind: 'paused', reason: 'interrupted' };
      }
    } else {
      pr.error = result.errors?.join('; ') || result.subtype;
      return { kind: 'failed', error: pr.error };
    }

    // artifacts
    for (const [name, rel] of Object.entries(phase.artifacts)) {
      const abs = path.join(task.worktreePath, rel);
      if (!fs.existsSync(abs)) { pr.error = `expected artifact ${name} at ${rel} was not produced`; return { kind: 'failed', error: pr.error }; }
      pr.artifacts[name] = abs;
    }
    if (phase.fail_if) {
      const failed = evalExpr(phase.fail_if, { ...ctx.tpl, structured: pr.structuredOutput, output: pr.resultText });
      if (failed) { pr.error = `fail_if matched: ${phase.fail_if}`; return { kind: 'failed', error: pr.error }; }
    }
    return { kind: 'ok' };
  }
}

export function resolveModel(phaseName: string, pipeline: { phaseModel?: string; phaseEffort?: EffortLevel }, cfg: { default?: string; effort?: EffortLevel; phases: Record<string, { model?: string; effort?: EffortLevel }> }, overrides: ModelOverrides | null | undefined): { model?: string; effort?: EffortLevel } {
  const o = overrides?.[phaseName] ?? {}; const oAll = overrides?.['*'] ?? {};
  const c = cfg.phases[phaseName] ?? {};
  return {
    model: o.model ?? oAll.model ?? c.model ?? cfg.default ?? pipeline.phaseModel,
    effort: o.effort ?? oAll.effort ?? c.effort ?? cfg.effort ?? pipeline.phaseEffort,
  };
}

/** Models sometimes emit literal "\\n" inside JSON strings; turn them into real newlines when the string has none. */
export function normalizeStrings<T>(v: T): T {
  if (typeof v === 'string') return (/\\[nt]/.test(v) && !v.includes('\n') ? v.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t') : v) as T;
  if (Array.isArray(v)) return v.map(normalizeStrings) as T;
  if (v && typeof v === 'object') { const out: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) out[k] = normalizeStrings(x); return out as T; }
  return v;
}
