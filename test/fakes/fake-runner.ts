import type { SDKMessage, SDKResultMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRunHandle, ClaudeRunner, ClaudeRunSpec } from '../../server/src/claude/runner.js';

export interface FakeTurn {
  /** Called when the phase starts; may write files. Returns the final text and optional structured output. */
  act: (spec: ClaudeRunSpec, api: { injected: string[] }) => Promise<{ text?: string; structured?: unknown; subtype?: SDKResultMessage['subtype']; cost?: number; toolCalls?: { name: string; input: Record<string, unknown> }[] }> | { text?: string; structured?: unknown; subtype?: SDKResultMessage['subtype']; cost?: number; toolCalls?: { name: string; input: Record<string, unknown> }[] };
}

let sessionCounter = 0;

/** Scripted runner: `match(spec)` picks a turn; every run yields init → (tool calls) → assistant → result. */
export class FakeRunner implements ClaudeRunner {
  public specs: ClaudeRunSpec[] = [];
  constructor(private script: (spec: ClaudeRunSpec) => FakeTurn) {}

  start(spec: ClaudeRunSpec): ClaudeRunHandle {
    this.specs.push(spec);
    const injected: string[] = [];
    const sessionId = spec.resume ?? `fake-session-${++sessionCounter}`;
    const turn = this.script(spec);
    async function* gen(): AsyncGenerator<SDKMessage> {
      const init = { type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', permissionMode: spec.permissionMode, tools: [], cwd: spec.cwd, apiKeySource: 'none', mcp_servers: [], claude_code_version: '0', uuid: 'u', slash_commands: [], output_style: 'default', skills: [], plugins: [] } as unknown as SDKSystemMessage;
      yield init;
      const r = await turn.act(spec, { injected });
      for (const tc of r.toolCalls ?? []) {
        yield { type: 'assistant', uuid: 'a', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: tc.name, input: tc.input }] } } as unknown as SDKMessage;
        yield { type: 'user', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }] } } as unknown as SDKMessage;
      }
      yield { type: 'assistant', uuid: 'a2', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: r.text ?? 'done' }] } } as unknown as SDKMessage;
      const subtype = r.subtype ?? 'success';
      const base = { type: 'result', uuid: 'r', session_id: sessionId, duration_ms: 1, duration_api_ms: 1, is_error: subtype !== 'success', num_turns: 1, stop_reason: null, total_cost_usd: r.cost ?? 0.01, usage: {}, modelUsage: {}, permission_denials: [] };
      yield (subtype === 'success'
        ? { ...base, subtype, result: r.text ?? 'done', structured_output: r.structured }
        : { ...base, subtype, errors: ['fake failure'] }) as unknown as SDKResultMessage;
    }
    return { messages: gen(), inject: (t) => injected.push(t), interrupt: async () => {}, abort: () => {} };
  }
}
