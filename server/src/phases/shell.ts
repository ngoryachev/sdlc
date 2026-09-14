import { spawn } from 'node:child_process';
import type { PhaseRun } from '@sdlc/shared';
import type { ShellPhaseSpec } from '../pipeline/schema.js';
import { renderTemplate } from '../pipeline/template.js';
import { filteredEnv } from '../claude/runner.js';
import { nowIso } from '../store/ids.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export class ShellPhaseExecutor implements PhaseExecutor<ShellPhaseSpec> {
  async run(phase: ShellPhaseSpec, pr: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome> {
    const command = renderTemplate(phase.command, ctx.tpl);
    const { task, events } = ctx;
    events.emit('phase.progress', { phaseRunId: pr.id, toolName: 'shell', summary: `$ ${command}` }, { taskId: task.id, phaseRunId: pr.id });

    const chunks: string[] = [];
    let killedBy: 'timeout' | 'abort' | null = null;
    const child = spawn('sh', ['-c', command], { cwd: task.worktreePath, env: filteredEnv({}, ctx.config.env_allow) as NodeJS.ProcessEnv, detached: true });
    const kill = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); } };
    ctx.registerHandle({ inject: () => {}, interrupt: async () => { killedBy = 'abort'; kill(); }, abort: () => { killedBy = 'abort'; kill(); } });
    const timer = setTimeout(() => { killedBy = 'timeout'; kill(); }, phase.timeout_sec * 1000);
    child.stdout.on('data', (d) => chunks.push(String(d)));
    child.stderr.on('data', (d) => chunks.push(String(d)));
    const code: number | null = await new Promise((res) => child.on('close', (c) => res(c)));
    clearTimeout(timer);
    ctx.registerHandle(null);

    const full = chunks.join('');
    const lines = full.split('\n');
    const tail = lines.length > phase.tail_lines ? `[... ${lines.length - phase.tail_lines} lines omitted ...]\n` + lines.slice(-phase.tail_lines).join('\n') : full;
    pr.resultText = tail;
    pr.structuredOutput = { exitCode: code, killedBy };
    pr.endedAt = nowIso();
    if (killedBy === 'abort') return ctx.abortRequested ? { kind: 'aborted' } : { kind: 'paused', reason: 'interrupted' };
    if (killedBy === 'timeout') { pr.error = `timed out after ${phase.timeout_sec}s`; return { kind: 'failed', error: pr.error }; }
    if (code !== 0) { pr.error = `exit code ${code}`; return { kind: 'failed', error: pr.error }; }
    return { kind: 'ok' };
  }
}
