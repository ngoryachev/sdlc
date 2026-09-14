/** Normalizes raw SDK messages into renderable log items; merges tool_result into its tool_use. */
export type LogItem =
  | { kind: 'meta'; id: string; prompt: string; resume: string | null; ts?: string }
  | { kind: 'text'; id: string; role: 'assistant' | 'user'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; result?: { text: string; isError: boolean }; parent: string | null; children: LogItem[] }
  | { kind: 'result'; id: string; subtype: string; costUsd: number; numTurns: number; durationMs: number; isError: boolean; errors?: string[] }
  | { kind: 'system'; id: string; text: string };

export class LogBuilder {
  items: LogItem[] = [];
  private tools = new Map<string, Extract<LogItem, { kind: 'tool' }>>();
  private n = 0;

  push(sdk: unknown): void {
    const m = sdk as Record<string, unknown>;
    const id = () => `i${this.n++}`;
    switch (m.type) {
      case 'sdlc.meta': this.items.push({ kind: 'meta', id: id(), prompt: String(m.prompt ?? ''), resume: (m.resume as string) ?? null, ts: m.ts as string }); return;
      case 'system': if (m.subtype === 'init') this.items.push({ kind: 'system', id: id(), text: `session ${m.session_id} · ${m.model} · ${m.permissionMode}` }); return;
      case 'assistant': {
        const msg = m.message as { content: Array<Record<string, unknown>> };
        const parent = (m.parent_tool_use_id as string) ?? null;
        for (const b of msg.content ?? []) {
          if (b.type === 'text' && String(b.text).trim()) this.add({ kind: 'text', id: id(), role: 'assistant', text: String(b.text) }, parent);
          else if (b.type === 'tool_use') { const t: Extract<LogItem, { kind: 'tool' }> = { kind: 'tool', id: String(b.id), name: String(b.name), input: (b.input ?? {}) as Record<string, unknown>, parent, children: [] }; this.tools.set(t.id, t); this.add(t, parent); }
        }
        return;
      }
      case 'user': {
        const msg = m.message as { content: string | Array<Record<string, unknown>> };
        if (typeof msg.content === 'string') { this.items.push({ kind: 'text', id: id(), role: 'user', text: msg.content }); return; }
        for (const b of msg.content ?? []) {
          if (b.type === 'tool_result') {
            const t = this.tools.get(String(b.tool_use_id));
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<Record<string, unknown>>).map((c) => (c.type === 'text' ? String(c.text) : `[${c.type}]`)).join('\n') : '';
            if (t) t.result = { text, isError: !!b.is_error };
          } else if (b.type === 'text' && String(b.text).trim()) this.items.push({ kind: 'text', id: id(), role: 'user', text: String(b.text) });
        }
        return;
      }
      case 'result': this.items.push({ kind: 'result', id: id(), subtype: String(m.subtype), costUsd: Number(m.total_cost_usd ?? 0), numTurns: Number(m.num_turns ?? 0), durationMs: Number(m.duration_ms ?? 0), isError: !!m.is_error, errors: m.errors as string[] | undefined }); return;
      default: return;
    }
  }

  private add(item: LogItem, parent: string | null) {
    if (parent) { const p = this.tools.get(parent); if (p) { p.children.push(item); return; } }
    this.items.push(item);
  }
}

export function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash': return `$ ${String(input.command ?? '').split('\n')[0]?.slice(0, 140)}`;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return short(String(input.file_path ?? input.notebook_path ?? ''));
    case 'Glob': case 'Grep': return `${String(input.pattern ?? '')} ${short(String(input.path ?? ''))}`.trim();
    case 'Agent': return String(input.description ?? '');
    case 'WebFetch': return String(input.url ?? '');
    case 'TodoWrite': return `${(input.todos as unknown[] | undefined)?.length ?? 0} todos`;
    default: { const s = JSON.stringify(input); return s.length > 120 ? s.slice(0, 120) + '…' : s; }
  }
}
export function short(p: string): string { const i = p.indexOf('/.sdlc-worktrees/'); if (i >= 0) { const rest = p.slice(i + '/.sdlc-worktrees/'.length).split('/'); return rest.slice(2).join('/') || p; } return p.length > 80 ? '…' + p.slice(-78) : p; }
