import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import type { HilDecision, HilPayload, HilResponse } from '@sdlc/shared';
import { api, ApiError, type HilRow } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { requestNotifyPermission } from '../lib/notify.js';
import { Markdown } from '../components/Markdown.js';
import { DiffView } from '../components/DiffView.js';
import { Tabs, ago } from '../components/Common.js';

export function HilQueue() {
  const open = useStore((s) => s.hil);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [all, setAll] = useState<HilRow[]>([]);
  useEffect(() => { requestNotifyPermission(); }, []);
  useEffect(() => { if (status === 'all') void api.hil('all').then((r) => setAll(r.requests)); }, [status, open.length]);
  const list = status === 'open' ? open : all;
  const [, nav] = useLocation();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.target as HTMLElement).tagName === 'INPUT') return; if (e.key === 'j' || e.key === 'k') { /* handled in detail */ } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <div className="card">
      <div className="row"><h3 className="grow" style={{ margin: 0 }}>Human in the loop</h3><Tabs tabs={[{ id: 'open', label: `open (${open.length})` }, { id: 'all', label: 'history' }]} value={status} onChange={setStatus} /></div>
      {list.length === 0 && <div className="muted">nothing waiting for you 🎉</div>}
      {list.map((h) => (
        <a key={h.id} href={`/hil/${h.id}`} className="list-item" onClick={(e) => { e.preventDefault(); nav(`/hil/${h.id}`); }}>
          <div className="row"><span className="kind">{h.kind}</span><span className="grow" style={{ fontWeight: 600 }}>{h.task.title}</span><span className="small muted">{ago(h.createdAt)} ago{h.status !== 'open' ? ` · ${h.status}${h.response ? ` (${h.response.decision} via ${h.answeredVia})` : ''}` : ''}</span></div>
          <div className="small muted">{h.summary}</div>
        </a>
      ))}
    </div>
  );
}

export function HilPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useStore((s) => s.toast);
  const openList = useStore((s) => s.hil);
  const [, nav] = useLocation();
  const [h, setH] = useState<HilRow | null>(null);
  const [comment, setComment] = useState('');
  const [edited, setEdited] = useState<{ prompt?: string; planMd?: string; title?: string }>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.hilOne(id).then((r) => { setH(r); setEdited({}); setComment(''); setAnswers({}); }).catch((e) => toast(e.message, 'error')); }, [id]);
  useEffect(() => { if (h && h.status === 'open' && !openList.some((x) => x.id === h.id)) void api.hilOne(id).then(setH); }, [openList, h?.id]);

  const respond = async (decision: HilDecision) => {
    if (!h) return;
    if (decision === 'request_changes' && !comment.trim()) { toast('a comment is required for request changes', 'error'); return; }
    setBusy(true);
    const body: HilResponse = { decision, comment: comment.trim() || undefined, edited: Object.keys(edited).length ? edited : undefined, answers: Object.keys(answers).length ? answers : undefined };
    try {
      const r = await api.respond(h.id, body);
      setH({ ...h, ...r });
      toast(`${h.kind}: ${decision} → ${h.next[decision] ?? 'ok'}`);
      const next = openList.find((x) => x.id !== h.id);
      nav(next ? `/hil/${next.id}` : '/hil');
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { toast(`already answered${(e.body as { answeredVia?: string }).answeredVia ? ` via ${(e.body as { answeredVia?: string }).answeredVia}` : ''}`, 'error'); void api.hilOne(id).then(setH); }
      else toast((e as Error).message, 'error');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { const d = h?.allowedDecisions.find((x) => ['approve', 'answer', 'allow', 'retry'].includes(x)); if (d) void respond(d); return; }
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (!h || h.status !== 'open') return;
      if (e.key === 'a' && h.allowedDecisions.includes('approve')) void respond('approve');
      if (e.key === 'r' && h.allowedDecisions.includes('request_changes')) document.getElementById('hil-comment')?.focus();
      if (e.key === 'j' || e.key === 'k') { const i = openList.findIndex((x) => x.id === h.id); const n = openList[i + (e.key === 'j' ? 1 : -1)]; if (n) nav(`/hil/${n.id}`); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [h, comment, edited, answers, openList]);

  if (!h) return <div className="muted">loading…</div>;
  const p = h.payload;
  return (
    <div className="card">
      <div className="row"><span className="kind">{h.kind}</span><h2 className="grow" style={{ margin: 0 }}><Link href={`/tasks/${h.taskId}`}>{h.task.title}</Link></h2><span className="small muted">{ago(h.createdAt)} ago</span></div>
      <div className="muted" style={{ marginBottom: 10 }}>{h.summary}</div>
      {h.status !== 'open' && <div className="chip" style={{ marginBottom: 10 }}>{h.status}{h.response ? ` · ${h.response.decision} via ${h.answeredVia}` : ''}</div>}
      <Payload p={p} edited={edited} setEdited={setEdited} answers={answers} setAnswers={setAnswers} readOnly={h.status !== 'open'} />
      {h.status === 'open' && (
        <>
          {h.allowedDecisions.some((d) => ['request_changes', 'resume', 'deny', 'approve'].includes(d)) && h.kind !== 'question' && (
            <div style={{ marginTop: 10 }}><label className="small muted">Comment {h.allowedDecisions.includes('request_changes') ? '(required for request changes)' : '(optional)'}</label><textarea id="hil-comment" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 64 }} /></div>
          )}
          <div className="actions">
            {h.allowedDecisions.filter((d) => d !== 'abort').map((d) => (
              <div className="act" key={d}><button className={['approve', 'answer', 'allow', 'retry'].includes(d) ? 'primary' : ''} disabled={busy} onClick={() => respond(d)}>{label(d)}</button><small>{h.next[d]}</small></div>
            ))}
            <div className="act" style={{ marginLeft: 'auto' }}><ArmedAbort onClick={() => respond('abort')} disabled={busy} /><small>{h.next.abort}</small></div>
          </div>
          <div className="small muted" style={{ marginTop: 6 }}><span className="kbd">a</span> approve · <span className="kbd">r</span> comment · <span className="kbd">Ctrl+Enter</span> submit · <span className="kbd">j</span>/<span className="kbd">k</span> next/prev</div>
        </>
      )}
    </div>
  );
}

function label(d: HilDecision): string { return ({ approve: 'Approve', request_changes: 'Request changes', abort: 'Abort', allow: 'Allow', allow_session: 'Allow for session', deny: 'Deny', answer: 'Send answers', retry: 'Retry', resume: 'Resume with comment', skip: 'Skip' } as Record<HilDecision, string>)[d]; }

function ArmedAbort({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(t); }, [armed]);
  return <button className={`danger ${armed ? 'confirm' : ''}`} disabled={disabled} onClick={() => { if (armed) onClick(); else setArmed(true); }}>{armed ? 'Confirm abort?' : 'Abort task'}</button>;
}

function Payload({ p, edited, setEdited, answers, setAnswers, readOnly }: { p: HilPayload; edited: { prompt?: string; planMd?: string; title?: string }; setEdited: (e: { prompt?: string; planMd?: string; title?: string }) => void; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void; readOnly: boolean }) {
  const [tab, setTab] = useState<'review' | 'diff' | 'tests' | 'findings' | 'qa'>('review');
  const [editPlan, setEditPlan] = useState(false);
  switch (p.kind) {
    case 'refine_prompt': {
      const value = edited.prompt ?? p.suggestedPrompt ?? p.prompt;
      return (
        <div>
          {p.questions.length > 0 && <div className="card" style={{ background: 'var(--bg)' }}><b>Claude asks:</b><ol>{p.questions.map((q, i) => <li key={i}><b>{q.header}:</b> {q.question}{q.options?.length ? <div className="small muted">options: {q.options.join(' · ')}</div> : null}</li>)}</ol><div className="small muted">Answer by editing the prompt below.</div></div>}
          {p.assumptions.length > 0 && <div className="small muted" style={{ marginBottom: 6 }}><b>Assumptions:</b> {p.assumptions.join(' · ')}</div>}
          <label className="small muted">Task title</label>
          <input value={edited.title ?? p.suggestedTitle ?? ''} placeholder="short title" readOnly={readOnly} onChange={(e) => setEdited({ ...edited, title: e.target.value })} style={{ marginBottom: 8 }} />
          <label className="small muted">Prompt for the pipeline {p.suggestedPrompt ? '(rewritten by Claude; original below)' : ''}</label>
          <textarea style={{ minHeight: 180 }} value={value} readOnly={readOnly} onChange={(e) => setEdited({ ...edited, prompt: e.target.value })} />
          {p.suggestedPrompt && <details><summary className="small muted">original prompt</summary><pre className="small">{p.prompt}</pre></details>}
        </div>
      );
    }
    case 'approve_plan':
      return (
        <div>
          <div className="row"><span className="grow" />{!readOnly && <button onClick={() => setEditPlan(!editPlan)}>{editPlan ? 'Preview' : 'Edit plan'}</button>}</div>
          {editPlan ? <textarea style={{ minHeight: 360 }} value={edited.planMd ?? p.planMd} onChange={(e) => setEdited({ ...edited, planMd: e.target.value })} /> : <Markdown text={edited.planMd ?? p.planMd} />}
          {edited.planMd !== undefined && edited.planMd !== p.planMd && <div className="small" style={{ color: 'var(--warn)' }}>plan edited — the edited version will be used for implementation</div>}
        </div>
      );
    case 'approve_result':
      return (
        <div>
          <Tabs tabs={[{ id: 'review', label: `review${p.review ? ` · ${p.review.verdict}` : ''}` }, { id: 'diff', label: `diff · ${p.commits.length} commits` }, { id: 'tests', label: 'tests' }, { id: 'findings', label: `findings${p.review ? ` (${p.review.findings.length})` : ''}` }, ...(p.qa ? [{ id: 'qa', label: `qa · ${p.qa.verdict}${p.qa.issues.length ? ` (${p.qa.issues.length})` : ''}` }] : [])]} value={tab} onChange={(t) => setTab(t as typeof tab)} />
          {tab === 'review' && (p.review ? <Markdown text={p.review.summary} /> : <div className="muted">no review</div>)}
          {tab === 'diff' && <><pre className="small muted">{p.diffStat}</pre><DiffView patch={p.diff} /></>}
          {tab === 'tests' && (p.test ? <div><div><span className={`chip ${p.test.verdict === 'fail' ? 'failed' : ''}`}>{p.test.verdict}</span></div><Markdown text={p.test.summary} />{p.test.commands.length > 0 && <pre className="small muted">{p.test.commands.map((c) => `$ ${c}`).join('\n')}</pre>}{p.test.failures.length > 0 && <ul>{p.test.failures.map((f, i) => <li key={i}><b>{f.title}</b>{f.file ? <span className="mono small"> {f.file}{f.line ? `:${f.line}` : ''}</span> : null}<div className="small">{f.description}</div></li>)}</ul>}{p.test.tests_added.length > 0 && <div className="small muted">tests: {p.test.tests_added.join(', ')}</div>}{p.test.notes && <div className="small muted">{p.test.notes}</div>}</div> : <pre className="log">{p.testOutput ?? '(tests were not run)'}</pre>)}
          {tab === 'qa' && p.qa && <div><Markdown text={p.qa.summary} /><ul>{p.qa.checks.map((c, i) => <li key={i}><span className={`chip ${c.result === 'failed' ? 'failed' : ''}`}>{c.result}</span> {c.name} <span className="small muted">{c.method}</span></li>)}</ul>{p.qa.issues.length > 0 && <ul>{p.qa.issues.map((f, i) => <li key={i}><span className={`chip ${f.severity === 'blocking' ? 'failed' : ''}`}>{f.severity}</span> <b>{f.title}</b><div className="small">{f.description}</div></li>)}</ul>}</div>}
          {tab === 'findings' && <ul>{(p.review?.findings ?? []).map((f, i) => <li key={i}><span className={`chip ${f.severity === 'blocking' ? 'failed' : ''}`}>{f.severity}</span> <b>{f.title}</b>{f.file ? <span className="mono small"> {f.file}{f.line ? `:${f.line}` : ''}</span> : null}<div className="small">{f.description}</div>{f.suggestion && <div className="small muted">→ {f.suggestion}</div>}</li>)}{!p.review?.findings.length && <li className="muted">none</li>}</ul>}
        </div>
      );
    case 'pr_feedback':
      return <div><a href={p.prUrl} target="_blank" rel="noreferrer">{p.prUrl}</a><ul>{p.comments.map((c) => <li key={c.id}><b>{c.author}</b>{c.reviewState ? <span className="chip">{c.reviewState}</span> : null}{c.path ? <span className="mono small"> {c.path}{c.line ? `:${c.line}` : ''}</span> : null}<Markdown text={c.body} /><a className="small" href={c.url} target="_blank" rel="noreferrer">view</a></li>)}</ul></div>;
    case 'question':
      return (
        <div>{p.questions.map((q) => (
          <div key={q.question} className="card" style={{ background: 'var(--bg)' }}>
            <b>{q.header}</b><div>{q.question}</div>
            <div style={{ marginTop: 6 }}>{q.options.map((o) => <label key={o.label} style={{ display: 'block' }}><input type={q.multiSelect ? 'checkbox' : 'radio'} style={{ width: 'auto' }} name={q.question} disabled={readOnly} checked={(answers[q.question] ?? '').split(', ').includes(o.label)} onChange={(e) => { if (q.multiSelect) { const cur = (answers[q.question] ?? '').split(', ').filter(Boolean); const next = e.target.checked ? [...cur, o.label] : cur.filter((x) => x !== o.label); setAnswers({ ...answers, [q.question]: next.join(', ') }); } else setAnswers({ ...answers, [q.question]: o.label }); }} /> <b>{o.label}</b> <span className="muted small">{o.description}</span></label>)}</div>
            <input style={{ marginTop: 6 }} placeholder="or type your own answer" disabled={readOnly} value={q.options.some((o) => o.label === answers[q.question]) ? '' : answers[q.question] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })} />
          </div>))}</div>
      );
    case 'escalation':
      return <div><div><b>{p.phaseName}</b> failed{p.resultSubtype ? ` (${p.resultSubtype})` : ''}:</div><pre className="log">{p.error}</pre></div>;
  }
}
