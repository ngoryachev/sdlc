import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown.js';
import { EditDiff } from './DiffView.js';
import { toolSummary, short, type LogItem } from '../lib/logItems.js';

export function LogView({ items, follow = true }: { items: LogItem[]; follow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => { if (stick && follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [items, stick, follow]);
  return (
    <div className="log" ref={ref} onScroll={(e) => { const el = e.currentTarget; setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 120); }}>
      {items.length === 0 && <div className="muted">no messages yet</div>}
      {items.map((it) => <Item key={it.id} it={it} />)}
      {!stick && <button style={{ position: 'sticky', bottom: 4, left: '50%' }} onClick={() => { setStick(true); if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }}>↓ follow</button>}
    </div>
  );
}

function Item({ it }: { it: LogItem }) {
  switch (it.kind) {
    case 'meta': return <Collapsible head={<><span className="tool-name">prompt</span><span className="tool-sum">{it.resume ? `resume ${it.resume.slice(0, 8)} · ` : ''}{it.prompt.split('\n')[0]}</span></>}><pre>{it.prompt}</pre></Collapsible>;
    case 'system': return <div className="item muted small">{it.text}</div>;
    case 'text': return <div className="item">{it.role === 'user' ? <div className="small muted">user →</div> : null}<Markdown text={it.text} /></div>;
    case 'result': return <div className="item result">■ {it.subtype} · {it.numTurns} turns · ${it.costUsd.toFixed(3)} · {(it.durationMs / 1000).toFixed(0)}s{it.isError ? <span className="err"> · {it.errors?.join('; ')}</span> : null}</div>;
    case 'tool': return <ToolItem it={it} />;
  }
}

function Collapsible({ head, children, defaultOpen = false }: { head: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className="item"><div className="tool-head" onClick={() => setOpen(!open)}><span className="muted small">{open ? '▾' : '▸'}</span>{head}</div>{open ? <div className="tool-body">{children}</div> : null}</div>;
}

function ToolItem({ it }: { it: Extract<LogItem, { kind: 'tool' }> }) {
  const status = it.result ? (it.result.isError ? <span className="err">✗</span> : <span className="muted">✓</span>) : <span className="muted">…</span>;
  const body = () => {
    const i = it.input;
    switch (it.name) {
      case 'Edit': return <EditDiff file={short(String(i.file_path))} oldStr={String(i.old_string ?? '')} newStr={String(i.new_string ?? '')} />;
      case 'Write': return <pre>{String(i.content ?? '').split('\n').slice(0, 40).join('\n')}{String(i.content ?? '').split('\n').length > 40 ? '\n…' : ''}</pre>;
      case 'Bash': return <><pre>$ {String(i.command)}</pre>{it.result && <pre className={it.result.isError ? 'err' : ''} style={{ marginTop: 6 }}>{clip(it.result.text)}</pre>}</>;
      case 'Read': case 'Glob': case 'Grep': case 'LS': return it.result ? <pre>{clip(it.result.text, 30)}</pre> : null;
      case 'TodoWrite': return <ul>{((i.todos as { content: string; status: string }[]) ?? []).map((t, k) => <li key={k}>{t.status === 'completed' ? '☑' : '☐'} {t.content}</li>)}</ul>;
      default: return <><pre>{JSON.stringify(i, null, 2)}</pre>{it.result && <pre style={{ marginTop: 6 }}>{clip(it.result.text)}</pre>}</>;
    }
  };
  return (
    <>
      <Collapsible head={<><span className="tool-name">{it.name}</span><span className="tool-sum">{toolSummary(it.name, it.input)}</span>{status}</>}>{body()}</Collapsible>
      {it.children.length ? <div className="children">{it.children.map((c) => <Item key={c.id} it={c} />)}</div> : null}
    </>
  );
}
function clip(s: string, lines = 40): string { const arr = s.split('\n'); return arr.length > lines ? arr.slice(0, lines).join('\n') + `\n… (${arr.length - lines} more lines)` : s; }
