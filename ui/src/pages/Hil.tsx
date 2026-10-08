import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import type { FindingAction, HilDecision, HilPayload, HilResponse, ReviewEvent, TranslateLang } from '@sdlc/shared';
import { TRANSLATE_LANGS, TRANSLATE_LANG_NAMES } from '@sdlc/shared';
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
  const [actions, setActions] = useState<Record<string, FindingAction>>({});
  const [commentActions, setCommentActions] = useState<Record<string, 'fix' | 'skip'>>({});
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>('comment');
  const [busy, setBusy] = useState(false);
  const readingLang = useStore((s) => s.readingLang);
  const setReadingLang = useStore((s) => s.setReadingLang);
  // translation of this checkpoint: screen only, never saved and never part of the response
  const [tr, setTr] = useState<Record<string, string> | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);
  useEffect(() => { void api.hilOne(id).then((r) => { setH(r); setEdited({}); setComment(''); setAnswers({}); setActions(defaultActions(r.payload, r.response)); setCommentActions(r.payload.kind === 'pr_feedback' ? Object.fromEntries(r.payload.comments.map((c) => [c.id, r.response?.comments?.[c.id] ?? 'fix'])) : {}); setReviewEvent(r.response?.reviewEvent ?? 'comment'); setTr(null); setShowOriginal(false); setTranslating(false); }).catch((e) => toast(e.message, 'error')); }, [id]);
  useEffect(() => { if (h && h.status === 'open' && !openList.some((x) => x.id === h.id)) void api.hilOne(id).then(setH); }, [openList, h?.id]);
  useEffect(() => { setTr(null); setShowOriginal(false); setTranslating(false); }, [readingLang]);
  // j/k can move to the next checkpoint while a translation is in flight: that answer belongs to the old one
  const shownRef = useRef({ id, lang: readingLang });
  useEffect(() => { shownRef.current = { id, lang: readingLang }; }, [id, readingLang]);

  const translate = async () => {
    if (!h) return;
    const texts = translatable(h.payload, h.summary);
    if (!texts.length) return;
    const asked = { id, lang: readingLang };
    setTranslating(true);
    try {
      const r = await api.translate(texts, readingLang);
      if (shownRef.current.id !== asked.id || shownRef.current.lang !== asked.lang) return;
      setTr(Object.fromEntries(texts.map((x, i) => [x, r.texts[i] ?? x])));
      setShowOriginal(false);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setTranslating(false); }
  };
  /** Translated text where there is one, the English original otherwise; identity before Translate is pressed. */
  const t = (s: string) => (tr && !showOriginal ? tr[s] ?? s : s);

  const unanswered = h?.payload.kind === 'refine_prompt' ? h.payload.questions.filter((q) => !answers[q.question]?.trim()).map((q) => q.header) : [];
  const counts = { fix: 0, post: 0, skip: 0 };
  for (const a of Object.values(actions)) counts[a]++;
  const granular = h?.payload.kind === 'approve_result';
  const respond = async (decision: HilDecision) => {
    if (!h) return;
    if (decision === 'approve' && unanswered.length) { toast(`answer first: ${unanswered.join(', ')}`, 'error'); return; }
    // at a result checkpoint the items decide: anything marked fix sends the run back, otherwise it goes on
    if (granular && decision !== 'abort') decision = counts.fix ? 'request_changes' : 'approve';
    if (decision === 'request_changes' && !comment.trim() && !counts.fix) { toast('a comment is required for request changes', 'error'); return; }
    setBusy(true);
    const body: HilResponse = { decision, comment: comment.trim() || undefined, edited: Object.keys(edited).length ? edited : undefined, answers: Object.keys(answers).length ? answers : undefined,
      findings: granular ? actions : undefined, comments: h.payload.kind === 'pr_feedback' ? commentActions : undefined, reviewEvent: h.payload.kind === 'approve_result' && h.payload.role === 'reviewer' ? reviewEvent : undefined };
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
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
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
      <div className="muted" style={{ marginBottom: 10 }}>{t(h.summary)}</div>
      <div className="row small" style={{ marginBottom: 10, gap: 6, flexWrap: 'wrap' }}>
        <select style={{ width: 'auto' }} value={readingLang} disabled={translating} onChange={(e) => setReadingLang(e.target.value as TranslateLang)}>{TRANSLATE_LANGS.map((l) => <option key={l} value={l}>{TRANSLATE_LANG_NAMES[l]}</option>)}</select>
        {tr
          ? <button onClick={() => setShowOriginal(!showOriginal)}>{showOriginal ? `Show ${TRANSLATE_LANG_NAMES[readingLang].toLowerCase()}` : 'Show original'}</button>
          : <button disabled={translating} onClick={() => void translate()}>{translating ? 'translating… this can take a few minutes, the English text stays' : 'Translate'}</button>}
        <span className="muted">for reading only: diff, logs, commands and editable fields stay in English, nothing is saved or sent</span>
      </div>
      {h.status !== 'open' && <div className="chip" style={{ marginBottom: 10 }}>{h.status}{h.response ? ` · ${h.response.decision} via ${h.answeredVia}` : ''}</div>}
      <Payload p={p} edited={edited} setEdited={setEdited} answers={answers} setAnswers={setAnswers} actions={actions} setActions={setActions} commentActions={commentActions} setCommentActions={setCommentActions} reviewEvent={reviewEvent} setReviewEvent={setReviewEvent} readOnly={h.status !== 'open'} t={t} />
      {h.status === 'open' && (
        <>
          {h.allowedDecisions.some((d) => ['request_changes', 'resume', 'deny', 'approve'].includes(d)) && h.kind !== 'question' && (
            <div style={{ marginTop: 10 }}><label className="small muted">{granular && p.kind === 'approve_result' ? (p.canPost && p.role === 'reviewer' ? 'Review text (posted to the PR together with the findings marked post; optional)' : counts.fix ? 'Comment for the implementer (optional; the items marked fix are sent anyway)' : p.canPost ? 'Comment (optional; with items marked post it is posted to the PR as the review text)' : 'Comment (optional)') : `Comment ${h.allowedDecisions.includes('request_changes') ? '(required for request changes)' : '(optional)'}`}</label><textarea id="hil-comment" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 64 }} /></div>
          )}
          <div className="actions">
            {granular && p.kind === 'approve_result' && (
              <div className="act"><button className="primary" disabled={busy} onClick={() => respond('approve')}>{counts.fix ? `Send ${counts.fix} to fix${counts.post ? `, post ${counts.post} later` : ''}${counts.skip ? `, skip ${counts.skip}` : ''}` : counts.post ? `Continue, post ${counts.post}${counts.skip ? `, skip ${counts.skip}` : ''}` : `Continue${counts.skip ? `, skip ${counts.skip}` : ''}`}</button><small>{counts.fix ? h.next.request_changes : h.next.approve}</small></div>
            )}
            {h.allowedDecisions.filter((d) => d !== 'abort' && !(granular && (d === 'approve' || d === 'request_changes'))).map((d) => (
              <div className="act" key={d}><button className={['approve', 'answer', 'allow', 'retry'].includes(d) ? 'primary' : ''} disabled={busy || (d === 'approve' && unanswered.length > 0)} title={d === 'approve' && unanswered.length ? `answer first: ${unanswered.join(', ')}` : undefined} onClick={() => respond(d)}>{label(d)}</button><small>{h.next[d]}</small></div>
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

function Payload({ p, edited, setEdited, answers, setAnswers, actions, setActions, commentActions, setCommentActions, reviewEvent, setReviewEvent, readOnly, t }: {
  p: HilPayload; edited: { prompt?: string; planMd?: string; title?: string }; setEdited: (e: { prompt?: string; planMd?: string; title?: string }) => void; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void;
  actions: Record<string, FindingAction>; setActions: (a: Record<string, FindingAction>) => void; commentActions: Record<string, 'fix' | 'skip'>; setCommentActions: (a: Record<string, 'fix' | 'skip'>) => void;
  reviewEvent: ReviewEvent; setReviewEvent: (e: ReviewEvent) => void; readOnly: boolean;
  /** Applied on display only: every value the human sends back is taken from the untranslated payload. */
  t: (s: string) => string;
}) {
  const [tab, setTab] = useState<'review' | 'diff' | 'tests' | 'findings' | 'qa'>(p.kind === 'approve_result' ? (p.focus === 'qa' ? 'qa' : p.review?.findings.length ? 'findings' : 'review') : 'review');
  /** fix / post / skip for one item; an action the task cannot perform is not offered. */
  const Pick = ({ k, canFix, canPost }: { k: string; canFix: boolean; canPost: boolean }) => (
    <span className="row" style={{ display: 'inline-flex', gap: 2, marginLeft: 6, verticalAlign: 'middle' }}>
      {(['fix', 'post', 'skip'] as FindingAction[]).filter((a) => (a === 'fix' ? canFix : a === 'post' ? canPost : true)).map((a) => (
        <button key={a} type="button" className={`small ${actions[k] === a ? 'primary' : ''}`} style={{ padding: '0 8px' }} disabled={readOnly} onClick={() => setActions({ ...actions, [k]: a })} title={a === 'fix' ? 'send back to the implementer' : a === 'post' ? 'publish on the pull request' : 'leave it'}>{a}</button>
      ))}
    </span>
  );
  const [editPlan, setEditPlan] = useState(false);
  switch (p.kind) {
    case 'refine_prompt': {
      const value = edited.prompt ?? p.suggestedPrompt ?? p.prompt;
      return (
        <div>
          {p.questions.length > 0 && (
            <div className="card" style={{ background: 'var(--bg)' }}>
              <b>Claude asks</b> <span className="small muted">— every question needs an answer; they are appended to the prompt</span>
              {p.questions.map((q, i) => (
                <div key={i} style={{ marginTop: 8 }}>
                  <div><b>{t(q.header)}:</b> {t(q.question)}</div>
                  {q.options?.length ? <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4 }}>{q.options.map((o) => <button key={o} type="button" className={answers[q.question] === o ? 'primary' : ''} disabled={readOnly} onClick={() => setAnswers({ ...answers, [q.question]: o })}>{t(o)}</button>)}</div> : null}
                  <input style={{ marginTop: 4 }} placeholder="your answer" readOnly={readOnly} value={answers[q.question] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })} />
                </div>
              ))}
            </div>
          )}
          {p.assumptions.length > 0 && <div className="small muted" style={{ marginBottom: 6 }}><b>Assumptions:</b> {p.assumptions.map(t).join(' · ')}</div>}
          <label className="small muted">Task title</label>
          <input value={edited.title ?? p.suggestedTitle ?? ''} placeholder="short title" readOnly={readOnly} onChange={(e) => setEdited({ ...edited, title: e.target.value })} style={{ marginBottom: 8 }} />
          <label className="small muted">Prompt for the pipeline {p.suggestedPrompt ? '(rewritten by Claude; original below)' : ''}</label>
          <textarea style={{ minHeight: 180 }} value={value} readOnly={readOnly} onChange={(e) => setEdited({ ...edited, prompt: e.target.value })} />
          {p.suggestedPrompt && <details><summary className="small muted">original prompt</summary><pre className="small">{t(p.prompt)}</pre></details>}
        </div>
      );
    }
    case 'approve_plan':
      return (
        <div>
          <div className="row"><span className="grow" />{!readOnly && <button onClick={() => setEditPlan(!editPlan)}>{editPlan ? 'Preview' : 'Edit plan'}</button>}</div>
          {editPlan ? <textarea style={{ minHeight: 360 }} value={edited.planMd ?? p.planMd} onChange={(e) => setEdited({ ...edited, planMd: e.target.value })} /> : <Markdown text={t(edited.planMd ?? p.planMd)} />}
          {edited.planMd !== undefined && edited.planMd !== p.planMd && <div className="small" style={{ color: 'var(--warn)' }}>plan edited — the edited version will be used for implementation</div>}
        </div>
      );
    case 'approve_result':
      return (
        <div>
          <Tabs tabs={[{ id: 'review', label: `review${p.review ? ` · ${p.review.verdict}` : ''}` }, { id: 'diff', label: `diff · ${p.commits.length} commits` }, { id: 'tests', label: 'tests' }, { id: 'findings', label: `findings${p.review ? ` (${p.review.findings.length})` : ''}` }, ...(p.qa ? [{ id: 'qa', label: `qa · ${p.qa.verdict}${p.qa.issues.length ? ` (${p.qa.issues.length})` : ''}` }] : [])]} value={tab} onChange={(id) => setTab(id as typeof tab)} />
          {tab === 'review' && (p.review ? <Markdown text={t(p.review.summary)} /> : <div className="muted">no review</div>)}
          {tab === 'diff' && <><pre className="small muted">{p.diffStat}</pre><DiffView patch={p.diff} /></>}
          {tab === 'tests' && (p.test ? <div><div><span className={`chip ${p.test.verdict === 'fail' ? 'failed' : ''}`}>{p.test.verdict}</span></div><Markdown text={t(p.test.summary)} />{p.test.commands.length > 0 && <pre className="small muted">{p.test.commands.map((c) => `$ ${c}`).join('\n')}</pre>}{p.test.failures.length > 0 && <ul>{p.test.failures.map((f, i) => <li key={i}><b>{t(f.title)}</b>{f.file ? <span className="mono small"> {f.file}{f.line ? `:${f.line}` : ''}</span> : null}<div className="small">{t(f.description)}</div></li>)}</ul>}{p.test.tests_added.length > 0 && <div className="small muted">tests: {p.test.tests_added.join(', ')}</div>}{p.test.notes && <div className="small muted">{t(p.test.notes)}</div>}</div> : <pre className="log">{p.testOutput ?? '(tests were not run)'}</pre>)}
          {tab === 'qa' && p.qa && <div><Markdown text={t(p.qa.summary)} /><ul>{p.qa.checks.map((c, i) => <li key={i}><span className={`chip ${c.result === 'failed' ? 'failed' : ''}`}>{c.result}</span> {t(c.name)} <span className="small muted">{t(c.method)}</span></li>)}</ul>{p.qa.issues.length > 0 && <ul>{p.qa.issues.map((f, i) => <li key={i}><span className={`chip ${f.severity === 'blocking' ? 'failed' : ''}`}>{f.severity}</span> <b>{t(f.title)}</b>{p.focus === 'qa' && <Pick k={`qa:${i}`} canFix={p.canFix} canPost={false} />}<div className="small">{t(f.description)}</div></li>)}</ul>}</div>}
          {tab === 'findings' && (
            <div>
              {p.focus === 'review' && (p.review?.findings.length ?? 0) > 0 && <div className="small muted" style={{ marginBottom: 6 }}>{p.canFix ? 'fix: goes back to the implementer · ' : ''}{p.canPost ? 'post: published on the pull request · ' : ''}skip: nothing happens{p.canPost && p.role === 'reviewer' && <> · published as <select style={{ width: 'auto', display: 'inline-block' }} value={reviewEvent} disabled={readOnly} onChange={(e) => setReviewEvent(e.target.value as ReviewEvent)}><option value="comment">comment</option><option value="approve">approve</option><option value="request_changes">request changes</option></select></>}</div>}
              <ul>{(p.review?.findings ?? []).map((f, i) => <li key={i}><span className={`chip ${f.severity === 'blocking' ? 'failed' : ''}`}>{f.severity}</span> <b>{t(f.title)}</b>{f.file ? <span className="mono small"> {f.file}{f.line ? `:${f.line}` : ''}</span> : null}{p.focus === 'review' && <Pick k={`review:${i}`} canFix={p.canFix} canPost={p.canPost} />}<div className="small">{t(f.description)}</div>{f.suggestion && <div className="small muted">→ {t(f.suggestion)}</div>}</li>)}{!p.review?.findings.length && <li className="muted">none</li>}</ul>
            </div>
          )}
        </div>
      );
    case 'pr_feedback':
      return <div><a href={p.prUrl} target="_blank" rel="noreferrer">{p.prUrl}</a><div className="small muted">fix: goes to the implementer · skip: marked read, never shown again</div><ul>{p.comments.map((c) => <li key={c.id}><b>{c.author}</b>{c.reviewState ? <span className="chip">{c.reviewState}</span> : null}{c.path ? <span className="mono small"> {c.path}{c.line ? `:${c.line}` : ''}</span> : null}<span className="row" style={{ display: 'inline-flex', gap: 2, marginLeft: 6, verticalAlign: 'middle' }}>{(['fix', 'skip'] as const).map((a) => <button key={a} type="button" className={`small ${(commentActions[c.id] ?? 'fix') === a ? 'primary' : ''}`} style={{ padding: '0 8px' }} disabled={readOnly} onClick={() => setCommentActions({ ...commentActions, [c.id]: a })}>{a}</button>)}</span><Markdown text={t(c.body)} /><a className="small" href={c.url} target="_blank" rel="noreferrer">view</a></li>)}</ul></div>;
    case 'question':
      return (
        <div>{p.questions.map((q) => (
          <div key={q.question} className="card" style={{ background: 'var(--bg)' }}>
            <b>{t(q.header)}</b><div>{t(q.question)}</div>
            <div style={{ marginTop: 6 }}>{q.options.map((o) => <label key={o.label} style={{ display: 'block' }}><input type={q.multiSelect ? 'checkbox' : 'radio'} style={{ width: 'auto' }} name={q.question} disabled={readOnly} checked={(answers[q.question] ?? '').split(', ').includes(o.label)} onChange={(e) => { if (q.multiSelect) { const cur = (answers[q.question] ?? '').split(', ').filter(Boolean); const next = e.target.checked ? [...cur, o.label] : cur.filter((x) => x !== o.label); setAnswers({ ...answers, [q.question]: next.join(', ') }); } else setAnswers({ ...answers, [q.question]: o.label }); }} /> <b>{t(o.label)}</b> <span className="muted small">{o.description ? t(o.description) : ''}</span></label>)}</div>
            <input style={{ marginTop: 6 }} placeholder="or type your own answer" disabled={readOnly} value={q.options.some((o) => o.label === answers[q.question]) ? '' : answers[q.question] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })} />
          </div>))}</div>
      );
    case 'escalation':
      return <div><div><b>{p.phaseName}</b> failed{p.resultSubtype ? ` (${p.resultSubtype})` : ''}:</div><pre className="log">{t(p.error)}</pre></div>;
  }
}

/** What the checkpoint proposes before the human touches anything: the implementer fixes real defects, a reviewer posts everything. */
function defaultActions(p: HilPayload, saved: HilResponse | null): Record<string, FindingAction> {
  if (p.kind !== 'approve_result') return {};
  if (saved?.findings) return saved.findings;
  const out: Record<string, FindingAction> = {};
  if (p.focus === 'qa') { (p.qa?.issues ?? []).forEach((f, i) => { out[`qa:${i}`] = p.canFix && f.severity !== 'nit' ? 'fix' : 'skip'; }); return out; }
  (p.review?.findings ?? []).forEach((f, i) => { out[`review:${i}`] = p.role === 'reviewer' ? (p.canPost ? 'post' : 'skip') : p.canFix && f.severity !== 'nit' ? 'fix' : 'skip'; });
  return out;
}

/**
 * The prose of one checkpoint, deduplicated, in display order.
 * Left out on purpose: the diff, test logs and commands, severity / verdict / result names, file paths and line numbers,
 * PR links and authors, the phase name and every editable field (title, prompt textarea, plan in Edit mode) — translating
 * those would either break the markup or put a translated value into the response.
 */
function translatable(p: HilPayload, summary: string): string[] {
  const out: string[] = [summary];
  switch (p.kind) {
    case 'refine_prompt':
      if (p.suggestedPrompt) out.push(p.prompt);   // shown under "original prompt"; without it the prompt is the editable textarea
      out.push(...p.assumptions);
      for (const q of p.questions) out.push(q.header, q.question, ...(q.options ?? []));
      break;
    case 'approve_plan':
      out.push(p.planMd);
      break;
    case 'approve_result':
      if (p.review) out.push(p.review.summary, ...p.review.findings.flatMap((f) => [f.title, f.description, ...(f.suggestion ? [f.suggestion] : [])]));
      if (p.test) out.push(p.test.summary, p.test.notes, ...p.test.failures.flatMap((f) => [f.title, f.description]));
      if (p.qa) out.push(p.qa.summary, ...p.qa.checks.flatMap((c) => [c.name, c.method]), ...p.qa.issues.flatMap((i) => [i.title, i.description]));
      break;
    case 'pr_feedback':
      out.push(...p.comments.map((c) => c.body));
      break;
    case 'question':
      for (const q of p.questions) out.push(q.header, q.question, ...q.options.flatMap((o) => [o.label, ...(o.description ? [o.description] : [])]));
      break;
    case 'escalation':
      out.push(p.error);
      break;
  }
  return [...new Set(out.filter((s) => s && s.trim()))];
}
