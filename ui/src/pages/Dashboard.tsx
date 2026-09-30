import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { ModelOverrides } from '@sdlc/shared';
import { api, type Config, type ModelChoice, type PipelineInfo, type TaskRow } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Money, ago } from '../components/Common.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { RepoPicker, resolveRepoPath, type RepoChoice } from '../components/RepoPicker.js';

const FINISHED = ['merged', 'closed', 'aborted'];
/** succeeded = the pipeline is done, not that the code is delivered: without a PR the branch still waits to be landed. */
export function statusView(t: { status: string; prNumber: number | null }): { cls: string; label: string; title?: string } {
  if (t.status === 'succeeded' && !t.prNumber) return { cls: 'ready', label: 'ready to land', title: 'pipeline finished; the branch is not merged yet (Create PR or Land)' };
  return { cls: t.status, label: t.status };
}
export const StatusChip = ({ t }: { t: { status: string; prNumber: number | null } }) => { const v = statusView(t); return <span className={`chip ${v.cls}`} title={v.title}>{v.label}</span>; };
const parentOf = (t: TaskRow, all: TaskRow[]) => all.find((p) => p.id !== t.id && p.repoPath === t.repoPath && p.branch === t.baseBranch);

export function Dashboard() {
  const tasks = useStore((s) => s.tasks);
  const toast = useStore((s) => s.toast);
  const [showDone, setShowDone] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const visible = tasks.filter((t) => showDone || !FINISHED.includes(t.status));
  const hidden = tasks.length - visible.length;
  const syncNow = async () => {
    setSyncing(true);
    try { const r = await api.sync(); toast(r.changes.length ? r.changes.map((c) => `${c.title}: ${c.change}`).join('; ') : `checked ${r.checked} task(s), nothing changed`); if (r.errors.length) toast(r.errors.join('; '), 'error'); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setSyncing(false); }
  };
  return (
    <>
      <NewTaskForm />
      <div className="card">
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>Tasks</h3><button disabled={syncing} onClick={syncNow} title="check PR states and merged branches on GitHub now (also runs in the background)">{syncing ? 'syncing…' : 'Sync with GitHub'}</button><label className="small muted"><input type="checkbox" style={{ width: 'auto' }} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show merged / closed{hidden ? ` (${hidden})` : ''}</label></div>
        <table><thead><tr><th>Task</th><th>Status</th><th className="hide-sm">Phase</th><th>Cost</th><th className="hide-sm">Age</th></tr></thead>
          <tbody>{visible.map((t) => (
            <tr key={t.id}>
              <td><Link href={`/tasks/${t.id}`}>{t.title}</Link><div className="small muted">{t.pipelineName} · <span className="mono">{t.branch}</span>{(() => { const p = parentOf(t, tasks); return p ? <> · on <Link href={`/tasks/${p.id}`}>{p.title}</Link></> : null; })()}{t.prUrl ? <> · <a href={t.prUrl} target="_blank" rel="noreferrer">PR #{t.prNumber}</a></> : null}</div></td>
              <td><StatusChip t={t} />{t.openHil ? <Link href={`/hil?task=${t.id}`} className="badge">{t.openHil}</Link> : null}</td>
              <td className="hide-sm mono small">{t.currentPhase ?? ''}</td>
              <td><Money v={t.totalCostUsd} /></td>
              <td className="hide-sm muted small">{ago(t.createdAt)}</td>
            </tr>))}
            {visible.length === 0 && <tr><td colSpan={5} className="muted">no tasks</td></tr>}
          </tbody></table>
      </div>
    </>
  );
}

type Source = 'new' | 'branch' | 'pr';

function NewTaskForm() {
  const toast = useStore((s) => s.toast);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  const [branches, setBranches] = useState<{ remote: string | null; branch: string }[]>([]);
  const [base, setBase] = useState('');
  const [pipeline, setPipeline] = useState('');
  const [reviewMode, setReviewMode] = useState<'conceptual' | 'line'>('conceptual');
  const [prompt, setPrompt] = useState('');
  const [source, setSource] = useState<Source>('new');
  const [existingBranch, setExistingBranch] = useState('');
  const [prNumber, setPrNumber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [overrides, setOverrides] = useState<ModelOverrides>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.config().then((c) => { setCfg(c); setPipeline(c.defaultPipeline); }); void api.pipelines().then((p) => setPipelines(p.pipelines)); void api.models().then((r) => setModels(r.models)).catch(() => {}); }, []);
  useEffect(() => {
    setBranches([]);
    if (!repo || repo.kind === 'path') return;
    if (repo.kind === 'github') {
      setBase(`origin/${repo.defaultBranch ?? 'main'}`);
      void api.githubBranches(repo.slug!, repo.account ?? null).then((b) => setBranches(b.branches)).catch(() => {});
      return;
    }
    void api.branches(repo.name).then((b) => { setBranches(b.branches); setBase(b.default.remote ? `${b.default.remote}/${b.default.branch}` : b.default.branch); }).catch((e) => toast(String(e.message), 'error'));
  }, [repo?.kind, repo?.name]);
  // a pipeline brings its own default segment; one that lives on a pull request needs one
  const pl = pipelines.find((p) => p.name === pipeline);
  useEffect(() => { setFrom(pl?.segment?.from ?? ''); setTo(pl?.segment?.to ?? ''); if (pl?.needsPr) setSource('pr'); }, [pl?.name]);

  const phases = pl?.phases ?? [];
  const idx = (name: string) => phases.findIndex((p) => p.name === name);
  const fromIdx = from ? idx(from) : 0; const toIdx = to ? idx(to) : phases.length - 1;
  const implIdx = idx('implement');
  const promptOptional = source === 'pr' || (source === 'branch' && implIdx >= 0 && fromIdx > implIdx);
  const parsedPr = Number(/(\d+)\s*$/.exec(prNumber.trim())?.[1]);
  const ready = !busy && !!repo && (promptOptional || !!prompt.trim()) && (source !== 'pr' || parsedPr > 0) && (source !== 'branch' || !!existingBranch.trim()) && toIdx >= fromIdx;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      if (!repo) throw new Error('choose a repository');
      const repoPath = await resolveRepoPath(repo);
      if (repo.kind === 'github') { toast(`cloned ${repo.slug}`); setRepo({ kind: 'registered', name: repo.slug!, path: repoPath, account: repo.account }); }
      let baseRemote: string | null | undefined; let baseBranch: string | undefined;
      if (base && source !== 'pr') { const found = branches.find((b) => (b.remote ? `${b.remote}/${b.branch}` : b.branch) === base); if (found) { baseRemote = found.remote; baseBranch = found.branch; } else { const [r, ...rest] = base.split('/'); if (rest.length) { baseRemote = r; baseBranch = rest.join('/'); } else { baseRemote = null; baseBranch = r; } } }
      const t = await api.createTask({
        prompt: prompt.trim() || undefined, repoPath, pipeline, baseRemote, baseBranch, reviewMode,
        branch: source === 'branch' ? existingBranch.trim() : undefined, prNumber: source === 'pr' ? parsedPr : undefined,
        startAt: from || undefined, stopAfter: to || undefined, modelOverrides: Object.keys(overrides).length ? overrides : undefined,
      });
      toast(`task ${t.id} created`); setPrompt(''); setOverrides({}); setExistingBranch(''); setPrNumber('');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };

  const placeholder = source === 'pr' ? 'Optional: the pull request title and body are the task statement unless you write one here.'
    : promptOptional ? 'Optional: a short summary of the branch is generated from its commits unless you write one here.'
    : 'What should be done? Be concrete about the outcome; Claude will ask if something is ambiguous.';

  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ marginTop: 0 }}>New task</h3>
      <textarea placeholder={placeholder} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="grid2" style={{ marginTop: 8 }}>
        <div>
          <label className="small muted">Repository</label>
          <RepoPicker value={repo} onChange={setRepo} />
          {cfg && <div className="small muted" style={{ marginTop: 4 }}>new clones go to {cfg.reposDir}</div>}
          <div className="row" style={{ marginTop: 6 }}>
            <div><label className="small muted">Work on</label>
              <select value={source} onChange={(e) => setSource(e.target.value as Source)} disabled={!!pl?.needsPr}><option value="new">a new branch</option><option value="branch">an existing branch</option><option value="pr">a pull request</option></select></div>
            {source === 'branch' && <div className="grow"><label className="small muted">Branch</label>
              <input list="local-branches" value={existingBranch} onChange={(e) => setExistingBranch(e.target.value)} placeholder="feature/x" />
              <datalist id="local-branches">{branches.filter((b) => !b.remote).map((b) => <option key={b.branch} value={b.branch} />)}</datalist></div>}
            {source === 'pr' && <div className="grow"><label className="small muted">Pull request (number or URL)</label>
              <input value={prNumber} onChange={(e) => setPrNumber(e.target.value)} placeholder="42" /></div>}
            {source !== 'pr' && <div className="grow"><label className="small muted">Base (remote/branch)</label>
              <input list="branches" value={base} onChange={(e) => setBase(e.target.value)} placeholder="origin/main" />
              <datalist id="branches">{branches.map((b) => { const v = b.remote ? `${b.remote}/${b.branch}` : b.branch; return <option key={v} value={v} />; })}</datalist></div>}
          </div>
          {source === 'pr' && <div className="small muted" style={{ marginTop: 4 }}>The PR head branch becomes the task branch, its base the task base. The task re-reviews new commits (review only) or takes review comments into work (with implement).</div>}
        </div>
        <div>
          <div className="row">
            <div className="grow"><label className="small muted">Pipeline</label><select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>{pipelines.map((p) => <option key={p.name} value={p.name} title={p.description}>{p.name}</option>)}</select></div>
            <div><label className="small muted">Review</label><select value={reviewMode} onChange={(e) => setReviewMode(e.target.value as 'conceptual' | 'line')}><option value="conceptual">conceptual</option><option value="line">line-level</option></select></div>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <div className="grow"><label className="small muted">From phase</label>
              <select value={from} onChange={(e) => setFrom(e.target.value)}><option value="">first</option>{phases.map((p) => <option key={p.name} value={p.name}>{p.name}{p.type === 'hil' ? ' (checkpoint)' : ''}</option>)}</select></div>
            <div className="grow"><label className="small muted">To phase</label>
              <select value={to} onChange={(e) => setTo(e.target.value)}><option value="">last</option>{phases.map((p) => <option key={p.name} value={p.name}>{p.name}{p.type === 'hil' ? ' (checkpoint)' : ''}</option>)}</select></div>
          </div>
          {pl && <div className="small muted" style={{ marginTop: 4 }}>{phases.map((p, i) => { const inSeg = i >= fromIdx && i <= toIdx; const label = p.type === 'hil' ? `[${p.name}]` : p.name; return <span key={p.name} style={inSeg ? { color: 'var(--fg)' } : { opacity: 0.45 }}>{i ? ' → ' : ''}{label}</span>; })}{toIdx < fromIdx && <span style={{ color: 'var(--err)' }}> · the end is before the start</span>}</div>}
        </div>
      </div>
      <div className="small" style={{ marginTop: 8 }}><a href="#" onClick={(e) => { e.preventDefault(); setAdvanced(!advanced); }}>{advanced ? 'hide models' : 'models for this task…'}</a></div>
      {advanced && (
        <div style={{ marginTop: 6 }}>
          <label className="small muted">Models for this task only (empty = global settings)</label>
          <ModelPicker phases={phases.filter((p) => p.type === 'claude').map((p) => p.name)} models={models} value={overrides} onChange={setOverrides} inheritLabel="global" />
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={!ready}>Create task</button><span className="small muted">Human checkpoints are shown in [brackets]; the greyed phases are outside the task.</span></div>
    </form>
  );
}
