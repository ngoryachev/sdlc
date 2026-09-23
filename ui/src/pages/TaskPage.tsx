import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import type { ModelOverrides, PhaseRun } from '@sdlc/shared';
import type { Task } from '@sdlc/shared';
import { api, type ModelChoice, type TaskDetail } from '../lib/api.js';
import { StatusChip } from './Dashboard.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { useStore } from '../lib/store.js';
import { onMessageFrame } from '../lib/eventStream.js';
import { LogBuilder, type LogItem } from '../lib/logItems.js';
import { LogView } from '../components/LogView.js';
import { ConfirmButton, Money, Tabs, ago } from '../components/Common.js';
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
  const { task, phaseRuns, openHil, worktreeExists, baseChain, children } = d;
  const done = ['succeeded', 'merged', 'closed', 'failed', 'aborted'].includes(task.status);
  const idle = done || task.status === 'pr_open';
  const landable = ['succeeded', 'pr_open'].includes(task.status);
  const openChildren = (children ?? []).filter((c) => !['merged', 'closed', 'aborted'].includes(c.status));
  const running = phaseRuns.find((p) => p.status === 'running' || p.status === 'waiting_hil');
  const selected = phaseRuns.find((p) => p.id === phaseRunId) ?? running ?? phaseRuns.at(-1) ?? null;
  const act = async (a: 'pause' | 'resume' | 'abort', body?: unknown) => { try { await api.control(task.id, a, body); toast(`${a} ok`); void reload(); } catch (e) { toast((e as Error).message, 'error'); } };
  return (
    <>
      <div className="card">
        <div className="row"><h2 className="grow" style={{ margin: 0 }}>{task.title}</h2><StatusChip t={task} /><Money v={task.totalCostUsd} /></div>
        <div className="small muted" style={{ marginTop: 4 }}>{task.id} · {task.pipelineName} · <span className="mono">{task.branch}</span>{(baseChain ?? []).map((b) => <span key={b.branch}> ← <span className="mono">{b.branch}</span>{b.taskId ? <> (<Link href={`/tasks/${b.taskId}`}>{b.title}</Link>{b.status ? <> · {b.status}</> : null})</> : null}</span>)} · review {task.reviewMode}{task.prUrl ? <> · <a href={task.prUrl} target="_blank" rel="noreferrer">PR #{task.prNumber}</a></> : null} · {ago(task.createdAt)} ago</div>
        {(children ?? []).length > 0 && (
          <div className="stack small">
            <div className="muted">stacked on <span className="mono">{task.branch}</span>:</div>
            {children.map((c) => <div key={c.id}><Link href={`/tasks/${c.id}`}>{c.title}</Link> <StatusChip t={c} /> <span className="mono muted">{c.branch}</span>{c.prUrl ? <> · <a href={c.prUrl} target="_blank" rel="noreferrer">PR #{c.prNumber}</a></> : null}</div>)}
          </div>
        )}
        <details style={{ marginTop: 8 }}><summary className="small muted">prompt</summary><pre className="small">{task.refinedPrompt ?? task.initialPrompt}</pre></details>
        {openHil.length > 0 && <div style={{ marginTop: 8 }}>{openHil.map((h) => <Link key={h.id} href={`/hil/${h.id}`} className="badge" style={{ padding: '3px 10px', display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>⚑ {h.kind}: {h.summary}</Link>)}</div>}
        <div className="row" style={{ marginTop: 10 }}>
          {(task.status === 'running' || task.status === 'waiting_hil') && <button onClick={() => act('pause')}>Pause</button>}
          {task.status === 'paused' && <ResumeButton onResume={(g) => act('resume', g ? { guidance: g } : undefined)} />}
          {!done && task.status !== 'pr_open' && <ConfirmButton label="Abort" onClick={() => act('abort')} />}
          {task.status === 'succeeded' && !task.prNumber && <CreatePrButton task={task} onDone={reload} />}
          {landable && <LandButton taskId={task.id} hasPr={!!task.prNumber} stacked={openChildren.length} base={task.baseBranch} onDone={reload} />}
          {['succeeded', 'failed', 'pr_open'].includes(task.status) && <CloseButton task={task} stacked={openChildren.length} onDone={reload} />}
          {task.status === 'pr_open' && <button onClick={async () => { try { const r = await api.prPoll(task.id); toast(r.new ? `${r.new} new comment(s) → HIL` : `no new comments (PR ${r.state})`); void reload(); } catch (e) { toast((e as Error).message, 'error'); } }}>Poll PR comments</button>}
          <Inject taskId={task.id} disabled={done} />
          {idle && worktreeExists && <ConfirmButton label="Remove worktree" className="" onClick={async () => { try { await api.worktreeRemove(task.id); toast('worktree removed'); void reload(); } catch (e) { toast((e as Error).message, 'error'); } }} />}
          {idle && !worktreeExists && <span className="small muted">worktree removed</span>}
        </div>
        {!done && <ModelsPanel taskId={task.id} value={task.modelOverrides ?? {}} phases={((d.run?.pipelineSnapshot as { spec?: { phases: { name: string; type: string }[] } } | null)?.spec?.phases ?? []).filter((p) => p.type === 'claude').map((p) => p.name)} onSaved={reload} />}
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

function LandButton({ taskId, hasPr, stacked, base, onDone }: { taskId: string; hasPr: boolean; stacked: number; base: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [method, setMethod] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api.land(taskId, method || undefined); toast([`merged (${r.method}, via ${r.via}); worktree and branch removed`, ...(r.notes ?? [])].join(' · ')); onDone(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); setArmed(false); }
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      {armed && <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 'auto' }}><option value="">config method</option><option value="merge">merge</option><option value="squash">squash</option><option value="rebase">rebase</option></select>}
      <button className={armed ? 'primary' : ''} disabled={busy} onClick={() => (armed ? void go() : setArmed(true))} title={hasPr ? 'merge the PR, delete branch and worktree' : 'merge the branch into its base locally, push, delete branch and worktree'}>{armed ? `Confirm land${hasPr ? ' (PR)' : ''}` : 'Land'}</button>
      {armed && <button disabled={busy} onClick={() => setArmed(false)}>cancel</button>}
      {armed && stacked > 0 && <span className="small muted">{stacked} stacked task(s) will move onto {base}; only "merge" keeps their commits valid</span>}
    </span>
  );
}

function CreatePrButton({ task, onDone }: { task: Task; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [armed, setArmed] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const t = await api.createPr(task.id, { title, draft }); toast(`PR #${t.prNumber} opened`); setArmed(false); onDone(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (!armed) return <button onClick={() => { setTitle(task.title); setArmed(true); }} title="push the branch and open a pull request into its base">Create PR</button>;
  return (
    <span className="row" style={{ gap: 4 }}>
      <input style={{ width: 360 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PR title" />
      <label className="small muted"><input type="checkbox" style={{ width: 'auto' }} checked={draft} onChange={(e) => setDraft(e.target.checked)} /> draft</label>
      <button className="primary" disabled={busy || !title.trim()} onClick={() => void go()}>{busy ? 'opening…' : `Open PR → ${task.baseBranch}`}</button>
      <button disabled={busy} onClick={() => setArmed(false)}>cancel</button>
    </span>
  );
}

function CloseButton({ task, stacked, onDone }: { task: Task; stacked: number; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [armed, setArmed] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [closePr, setClosePr] = useState(true);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.closeTask(task.id, { deleteBranch, closePr }); toast('task closed'); setArmed(false); onDone(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (!armed) return <button onClick={() => setArmed(true)} title="drop the task without merging">Close</button>;
  return (
    <span className="row" style={{ gap: 6 }}>
      {task.prNumber && task.status === 'pr_open' && <label className="small"><input type="checkbox" style={{ width: 'auto' }} checked={closePr} onChange={(e) => setClosePr(e.target.checked)} /> close PR #{task.prNumber}</label>}
      <label className="small" title={stacked ? 'other tasks are stacked on this branch' : ''}><input type="checkbox" style={{ width: 'auto' }} disabled={stacked > 0} checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} /> delete branch</label>
      <button className="danger confirm" disabled={busy} onClick={() => void go()}>Close task</button>
      <button disabled={busy} onClick={() => setArmed(false)}>cancel</button>
    </span>
  );
}

function ModelsPanel({ taskId, value, phases, onSaved }: { taskId: string; value: ModelOverrides; phases: string[]; onSaved: () => void }) {
  const toast = useStore((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [v, setV] = useState<ModelOverrides>(value);
  useEffect(() => { if (open && !models.length) void api.models().then((r) => setModels(r.models)).catch(() => {}); }, [open]);
  useEffect(() => { setV(value); }, [JSON.stringify(value)]);
  const n = Object.keys(value).length;
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 8 }}>
      <summary className="small muted">models for this task{n ? ` (${n} override${n > 1 ? 's' : ''})` : ' (global settings)'} · applies to phases that have not started yet</summary>
      <ModelPicker phases={phases} models={models} value={v} onChange={setV} inheritLabel="global" />
      <div className="row" style={{ marginTop: 6 }}><button onClick={async () => { try { await api.taskModels(taskId, Object.keys(v).length ? v : null); toast('saved'); onSaved(); } catch (e) { toast((e as Error).message, 'error'); } }}>Save</button></div>
    </details>
  );
}
