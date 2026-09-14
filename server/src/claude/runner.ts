import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool, EffortLevel, Options, PermissionMode, Query, SDKMessage, SDKResultMessage, SDKUserMessage, SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { buildHooks } from './hooks.js';

export interface ClaudeRunSpec {
  cwd: string;
  prompt: string;
  resume?: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemAppend?: string;
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  model?: string;
  effort?: EffortLevel;
  settingSources?: SettingSource[];
  writeScope?: string[];
  readAllow?: string[];
  canUseTool?: CanUseTool;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  onToolUse?: (info: { toolName: string; toolInput: unknown; toolUseId: string }) => void;
  onStderr?: (line: string) => void;
}

export interface ClaudeRunHandle {
  /** Every SDK message including the final `result`. Ends after `result`. */
  messages: AsyncIterable<SDKMessage>;
  /** Queue a user message; it arrives after the current turn. */
  inject(text: string): void;
  /** Graceful stop: current tool finishes, SDK yields a result. */
  interrupt(): Promise<void>;
  /** Hard stop. */
  abort(): void;
}

export interface ClaudeRunner {
  start(spec: ClaudeRunSpec): ClaudeRunHandle;
}

/** Async queue used as the streaming-input prompt so the session stays open for inject()/interrupt(). */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  push(m: SDKUserMessage) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false }); else this.buf.push(m);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as SDKUserMessage, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.buf.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY)/i;
const SECRET_PREFIX = /^(AWS_|GH_|GITHUB_|SDLC_|NPM_TOKEN)/;
const KEEP_ENV = /^(ANTHROPIC_|CLAUDE_)/;

/** Copy of process.env without obvious credentials. Claude Code's own vars are kept. */
export function filteredEnv(extra?: Record<string, string | undefined>, allow: string[] = []): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.includes(k) || KEEP_ENV.test(k)) { out[k] = v; continue; }
    if (SECRET_ENV.test(k) || SECRET_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...(extra ?? {}) };
}

// The SDK warns that canUseTool is shadowed in bypassPermissions mode; AskUserQuestion still reaches it, which is all we use it for.
process.on('warning', (w) => { if ((w as { code?: string }).code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') return; });
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const code = typeof rest[0] === 'object' && rest[0] ? (rest[0] as { code?: string }).code : typeof rest[1] === 'string' ? rest[1] : undefined;
  const msg = typeof warning === 'string' ? warning : warning.message;
  if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' || msg.includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') || msg.includes('SQLite is an experimental feature')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export class SdkClaudeRunner implements ClaudeRunner {
  start(spec: ClaudeRunSpec): ClaudeRunHandle {
    const input = new InputQueue();
    input.push(userMessage(spec.prompt));
    const abortController = new AbortController();

    const options: Options = {
      cwd: spec.cwd,
      permissionMode: spec.permissionMode,
      allowDangerouslySkipPermissions: spec.permissionMode === 'bypassPermissions' ? true : undefined,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      systemPrompt: spec.systemAppend
        ? { type: 'preset', preset: 'claude_code', append: spec.systemAppend }
        : undefined,
      outputFormat: spec.outputSchema ? { type: 'json_schema', schema: spec.outputSchema } : undefined,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      model: spec.model,
      effort: spec.effort,
      settingSources: spec.settingSources ?? ['project'],
      resume: spec.resume,
      canUseTool: spec.canUseTool,
      hooks: buildHooks({ cwd: spec.cwd, writeScope: spec.writeScope, readAllow: spec.readAllow, onToolUse: spec.onToolUse }),
      env: filteredEnv(spec.env),
      includePartialMessages: spec.includePartialMessages ?? false,
      abortController,
      stderr: spec.onStderr,
      strictMcpConfig: true,
    };

    const q: Query = query({ prompt: input, options });

    async function* messages(): AsyncGenerator<SDKMessage> {
      let gotResult = false;
      try {
        for await (const m of q) {
          if (m.type === 'result') {
            gotResult = true;
            input.close();
            yield m;
            break;
          }
          yield m;
        }
      } catch (err) {
        if (!gotResult) {
          const synthetic = {
            type: 'result', subtype: 'error_during_execution', is_error: true,
            session_id: '', uuid: '', duration_ms: 0, duration_api_ms: 0, num_turns: 0, stop_reason: null,
            total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [],
            errors: [err instanceof Error ? err.message : String(err)],
          } as unknown as SDKResultMessage;
          yield synthetic;
        }
        // errors after the result are the SDK re-throwing the error-result; swallow
      } finally {
        input.close();
      }
    }

    return {
      messages: messages(),
      inject: (text) => input.push(userMessage(text)),
      interrupt: async () => { await q.interrupt(); },
      abort: () => { abortController.abort(); input.close(); },
    };
  }
}
