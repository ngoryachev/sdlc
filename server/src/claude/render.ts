import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** One-line, human-readable summary of an SDK message for console output. Returns null for noise. */
export function summarize(m: SDKMessage): string | null {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') return `▶ session ${m.session_id} model=${m.model} mode=${m.permissionMode} tools=${m.tools.length}`;
      return null;
    case 'assistant': {
      const out: string[] = [];
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) out.push(`💬 ${block.text.trim()}`);
        else if (block.type === 'tool_use') out.push(`🔧 ${block.name} ${toolSummary(block.name, block.input as Record<string, unknown>)}`);
      }
      return out.length ? out.join('\n') : null;
    }
    case 'user': {
      if (typeof m.message.content === 'string') return null;
      const out: string[] = [];
      for (const block of m.message.content) {
        if (block.type === 'tool_result') {
          const txt = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ') : '';
          const first = txt.split('\n')[0] ?? '';
          out.push(`   ↳ ${block.is_error ? '✗ ' : ''}${first.slice(0, 160)}${txt.length > 160 ? '…' : ''}`);
        }
      }
      return out.length ? out.join('\n') : null;
    }
    case 'result':
      return `■ ${m.subtype} turns=${m.num_turns} cost=$${m.total_cost_usd.toFixed(4)} ${m.is_error ? 'ERROR ' + ('errors' in m ? m.errors.join('; ') : '') : ''}`;
    default:
      return null;
  }
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return `$ ${String(input.command ?? '').split('\n')[0]?.slice(0, 120)}`;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return String(input.file_path ?? input.notebook_path ?? '');
    case 'Glob': case 'Grep': return `${String(input.pattern ?? '')} ${String(input.path ?? '')}`.trim();
    case 'Agent': return String(input.description ?? '');
    case 'WebFetch': return String(input.url ?? '');
    default: { const s = JSON.stringify(input); return s.length > 100 ? s.slice(0, 100) + '…' : s; }
  }
}
