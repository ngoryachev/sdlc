import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { SdkClaudeRunner } from '../claude/runner.js';
import { TranscriptWriter } from '../claude/transcript.js';
import { summarize } from '../claude/render.js';

const collect = (v: string, acc: string[]) => { acc.push(v); return acc; };

export function registerRunPhase(program: Command) {
  program
    .command('run-phase')
    .description('Dev: run a single Claude phase in a directory and print the stream')
    .requiredOption('--repo <path>', 'working directory (worktree)')
    .option('--prompt-file <path>', 'markdown prompt file')
    .option('--prompt <text>', 'inline prompt')
    .option('--mode <mode>', 'permission mode', 'dontAsk')
    .option('--allow <rule>', 'allowed tool rule (repeatable)', collect, [] as string[])
    .option('--deny <rule>', 'disallowed tool rule (repeatable)', collect, [] as string[])
    .option('--write-scope <glob>', 'writable glob relative to repo (repeatable)', collect, [] as string[])
    .option('--system-append <path>', 'markdown appended to system prompt')
    .option('--schema <path>', 'JSON schema for structured output')
    .option('--max-turns <n>', 'max turns', '30')
    .option('--budget <usd>', 'max budget USD', '2')
    .option('--model <id>', 'model id')
    .option('--resume <sessionId>', 'resume a session')
    .option('--transcript <path>', 'JSONL transcript path')
    .action(async (o) => {
      const cwd = path.resolve(o.repo);
      const prompt: string = o.prompt ?? (o.promptFile ? fs.readFileSync(o.promptFile, 'utf8') : '');
      if (!prompt) throw new Error('--prompt or --prompt-file is required');
      const transcriptPath = o.transcript ?? path.join(cwd, '.sdlc', 'transcripts', `run-phase-${Date.now()}.jsonl`);
      const tw = new TranscriptWriter(transcriptPath);
      const runner = new SdkClaudeRunner();
      const handle = runner.start({
        cwd,
        prompt,
        permissionMode: o.mode as PermissionMode,
        allowedTools: o.allow.length ? o.allow : undefined,
        disallowedTools: o.deny.length ? o.deny : undefined,
        writeScope: o.writeScope.length ? o.writeScope : undefined,
        systemAppend: o.systemAppend ? fs.readFileSync(o.systemAppend, 'utf8') : undefined,
        outputSchema: o.schema ? JSON.parse(fs.readFileSync(o.schema, 'utf8')) : undefined,
        maxTurns: Number(o.maxTurns),
        maxBudgetUsd: Number(o.budget),
        model: o.model,
        resume: o.resume,
        onStderr: (l) => process.stderr.write(`[claude] ${l}`),
      });
      process.on('SIGINT', () => { console.error('\n[sdlc] interrupting…'); void handle.interrupt(); });
      for await (const m of handle.messages) {
        tw.write(m);
        const s = summarize(m);
        if (s) console.log(s);
        if (m.type === 'result' && 'structured_output' in m && m.structured_output !== undefined) {
          console.log('structured_output:', JSON.stringify(m.structured_output, null, 2));
        }
      }
      await tw.close();
      console.log(`transcript: ${transcriptPath}`);
    });
}
