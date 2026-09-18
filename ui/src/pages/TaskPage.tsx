import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import type { PhaseRun } from '@sdlc/shared';
import { api, type TaskDetail } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { onMessageFrame } from '../lib/eventStream.js';
import { LogBuilder, type LogItem } from '../lib/logItems.js';
import { LogView } from '../components/LogView.js';
import { Chip, ConfirmButton, Money, Tabs, ago } from '../components/Common.js';
import { DiffView } from '../components/DiffView.js';
import { Markdown } from '../components/Markdown.js';

export function TaskPage() {
  const { id, phaseRunId } = useParams<{ id: string; phaseRunId?: string }>();
  const toast = useStore((s) => s.toast);
  const tasksVersion = useStore((s) => s.tasks.find((t) => t.id === id)?.updatedAt);
  const [d, setD] = useState<TaskDetail | null>(null);
  const [tab, setTab] = useState<'log' | 'diff' | 'artifacts'>('log');
  const reload = () => api.task(id).then(setD).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void reload(); }, [id, tasksVersion]);
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, [id]);
  if (!d) return <div className="muted">loading…</div>;
  const { task, phaseRuns, openHil, worktreeExists } = d;
  const idle = ['succeeded', 'failed', 'aborted', 'pr_open'].includes(task.status);
  const running = phaseRuns.find((p) => p.status === 'running' || p.status === 'waiting_hil');
  const selected = phaseRuns.find((p) => p.id === phaseRunId) ?? running ?? phaseRuns.at(-1) ?? null;
  const act = async (a: 'pause' | 'resume' | 'abort', body?: unknown) => { try { await api.control(task.id, a, body); toast(`${a} ok`); void reload(); } catch (e) { toast((e as Error).message, 'error'); } };
  return (
    <>
      <div className="card">
        <div className="row"><h2 className="grow" style={{ margin: 0 }}>{task.title}</h2><Chip s={task.status} /><Money v={task.totalCostUsd} /></div>
        <div className="small muted" style={{ marginTop: 4 }}>{task.id} · {task.pipelineName} · {task.branch} ← {task.baseRemote ? `${task.baseRemote}/` : ''}{task.baseBranch} · review {task.reviewMode}{task.prUrl ? <> · <a href={task.prUrl} target="_blank" rel="noreferrer">PR #{task.prNumber}</a></> : null} · {ago(task.createdAt)} ago</div>
        <details style={{ marginTop: 8 }}><summary className="small muted">prompt</summary><pre className="small">{task.refinedPrompt ?? task.initialPrompt}</pre></details>
        {openHil.length > 0 && <div style={{ marginTop: 8 }}>{openHil.map((h) => <Link key={h.id} href={`/hil/${h.id}`} className="badge" style={{ padding: '3px 10px', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⚑ {h.kind}: {h.summary}</Link>)}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          {(task.status === 'running' || task.status === 'waiting_hil') && <button onClick={() => act('pause')}>Pause</button>}
          {task.status === 'paused' && <ResumeButton onResume={(g) => act('resume', g ? { guidance: g } : undefined)} />}
          {!['succeeded', 'failed', 'aborted'].includes(task.status) && <ConfirmButton label="Abort" onClick={() => act('abort')} />}
          {task.status === 'pr_open' && <button onClick={async () => { try { const r = await api.prPoll(task.id); toast(r.new ? `${r.new} new comment(s) → HIL` : `no new comments (PR ${r.state})`); void reload(); } catch (e) { toast((e as Error).message, 'error'); } }}>Poll PR comments</button>}
          <Inject taskId={task.id} disabled={['succeeded', 'failed', 'aborted'].includes(task.status)} />
          {idle && worktreeExists && <ConfirmButton label="Remove worktree" className="" onClick={async () => { try { await api.worktreeRemove(task.id); toast('worktree removed'); void reload(); } catch (e) { toast((e as Error).message, 'error'); } }} />}
          {idle && !worktreeExists && <span className="small muted">worktree removed</span>}
        </div>
      </div>
      <div className="card">
        <Stepper phaseRuns={phaseRuns} pipeline={d.run?.pipelineSnapshot as { spec?: { phases: { name: string; type: string }[] } } | null} selected={selected?.id ?? null} taskId={task.id} />
      </div>
      <div className="card">
        <Tabs tabs={[{ id: 'log', label: selected ? `log: ${selected.phaseName} #${selected.attempt}` : 'log' }, { id: 'diff', label: 'diff' }, { id: 'artifacts', label: 'artifacts' }]} value={tab} onChange={setTab} />
        {tab === 'log' && (selected ? <PhaseLog key={selected.id} pr={selected} live={selected.status === 'running' || selected.status === 'waiting_hil'} /> : <div className="muted">no phases yet</div>)}
        {tab === 'diff' && <DiffTab taskId={task.id} />}
        {tab === 'artifacts' && <Artifacts taskId={task.id} />}
      </div>
    </>
  );
}

function Stepper({ phaseRuns, pipeline, selected, taskId }: { phaseRuns: PhaseRun[]; pipeline: { spec?: { phases: { name: string; type: string }[] } } | null; selected: string | null; taskId: string }) {
  const names = pipeline?.spec?.phases.map((p) => p.name) ?? [...new Set(phaseRuns.map((p) => p.phaseName))];
  return (
    <div className="stepper">
      {names.map((n) => {
        const runs = phaseRuns.filter((p) => p.phaseName === n);
        const last = runs.at(-1);
        const type = pipeline?.spec?.phases.find((p) => p.name === n)?.type;
        const label = `${type === 'hil' ? '⚑ ' : ''}${n}${runs.length > 1 ? ` ×${runs.length}` : ''}${last?.costUsd ? ` $${last.costUsd.toFixed(2)}` : ''}`;
        return last
          ? <Link key={n} href={`/tasks/${taskId}/phases/${last.id}`} className={`step ${last.status} ${last.id === selected ? 'active' : ''}`} title={last.error ?? ''}>{label}</Link>
          : <span key={n} className="step pending muted">{label}</span>;
      })}
    </div>
  );
}

function PhaseLog({ pr, live }: { pr: PhaseRun; live: boolean }) {
  const builder = useRef(new LogBuilder());
  const [items, setItems] = useState<LogItem[]>([]);
  const nextLine = useRef(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let from = 0;
      for (;;) { const r = await api.transcript(pr.id, from, 500); if (cancelled) return; for (const l of r.lines) builder.current.push(l); from = r.next; nextLine.current = from; if (r.eof) break; }
      setItems([...builder.current.items]);
    })().catch(() => {});
    const off = live ? onMessageFrame((m) => { if (m.phaseRunId !== pr.id) return; if (m.line < nextLine.current) return; nextLine.current = m.line + 1; builder.current.push(m.sdk); setItems([...builder.current.items]); }) : () => {};
    return () => { cancelled = true; off(); };
  }, [pr.id, live]);
  return (
    <>
      <div className="small muted" style={{ marginBottom: 6 }}>{pr.status} · {pr.numTurns} turns · <Money v={pr.costUsd} />{pr.sessionId ? ` · session ${pr.sessionId.slice(0, 8)}` : ''}{pr.error ? <span className="err"> · {pr.error}</span> : null}</div>
      {pr.phaseType === 'claude' ? <LogView items={items} follow={live} /> : <pre className="log">{pr.resultText ?? pr.error ?? '(no output)'}</pre>}
    </>
  );
}

function DiffTab({ taskId }: { taskId: string }) {
  const [d, setD] = useState<{ stat: string; patch: string; commits: string[]; missing?: boolean } | null>(null);
  useEffect(() => { void api.diff(taskId).then(setD); }, [taskId]);
  if (!d) return <div className="muted">loading…</div>;
  if (d.missing) return <div className="muted">worktree removed</div>;
  return <><pre className="small muted">{d.commits.join('\n')}</pre><DiffView patch={d.patch} /></>;
}

function Artifacts({ taskId }: { taskId: string }) {
  const [list, setList] = useState<{ name: string; size: number }[]>([]);
  const [open, setOpen] = useState<{ name: string; text: string } | null>(null);
  useEffect(() => { void api.artifacts(taskId).then((a) => setList(a.artifacts)).catch(() => setList([])); }, [taskId]);
  return (
    <div>
      <div className="row">{list.map((a) => <button key={a.name} onClick={() => api.artifact(taskId, a.name).then((t) => setOpen({ name: a.name, text: t }))}>{a.name} <span className="muted small">{a.size}b</span></button>)}{list.length === 0 && <span className="muted">no artifacts</span>}</div>
      {open && <div style={{ marginTop: 10 }}>{open.name.endsWith('.md') ? <Markdown text={open.text} /> : <pre>{open.text}</pre>}</div>}
    </div>
  );
}

function Inject({ taskId, disabled }: { taskId: string; disabled: boolean }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false); const [text, setText] = useState('');
  if (disabled) return null;
  return open ? (
    <form className="row grow" onSubmit={async (e) => { e.preventDefault(); try { const r = await api.inject(taskId, text); toast(`message ${r.deliveredTo === 'session' ? 'sent to the running session' : 'queued for the next phase'}`); setText(''); setOpen(false); } catch (err) { toast((err as Error).message, 'error'); } }}>
      <input className="grow" autoFocus placeholder="guidance for Claude (delivered after the current turn, or with the next resume)" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="primary" disabled={!text.trim()}>Send</button><button type="button" onClick={() => setOpen(false)}>✕</button>
    </form>
  ) : <button onClick={() => setOpen(true)}>Inject message…</button>;
}

function ResumeButton({ onResume }: { onResume: (guidance?: string) => void }) {
  const [g, setG] = useState(''); const [open, setOpen] = useState(false);
  return open ? <form className="row grow" onSubmit={(e) => { e.preventDefault(); onResume(g.trim() || undefined); }}><input className="grow" autoFocus placeholder="optional guidance" value={g} onChange={(e) => setG(e.target.value)} /><button className="primary">Resume</button></form>
    : <button className="primary" onClick={() => setOpen(true)}>Resume…</button>;
}

export function useMemoDeps<T>(f: () => T, deps: unknown[]): T { return useMemo(f, deps); }
