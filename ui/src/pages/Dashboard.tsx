import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { ModelOverrides } from '@sdlc/shared';
import { api, type Config, type ModelChoice, type PipelineInfo } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Chip, Money, ago } from '../components/Common.js';
import { ModelPicker } from '../components/ModelPicker.js';

export function Dashboard() {
  const tasks = useStore((s) => s.tasks);
  const [showDone, setShowDone] = useState(false);
  const visible = tasks.filter((t) => showDone || !['succeeded', 'merged', 'failed', 'aborted'].includes(t.status));
  return (
    <>
      <NewTaskForm />
      <ImportPrForm />
      <div className="card">
        <div className="row"><h3 className="grow" style={{ margin: 0 }}>Tasks</h3><label className="small muted"><input type="checkbox" style={{ width: 'auto' }} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show finished</label></div>
        <table><thead><tr><th>Task</th><th>Status</th><th className="hide-sm">Phase</th><th>Cost</th><th className="hide-sm">Age</th></tr></thead>
          <tbody>{visible.map((t) => (
            <tr key={t.id}>
              <td><Link href={`/tasks/${t.id}`}>{t.title}</Link><div className="small muted">{t.pipelineName} · {t.branch}{t.prUrl ? <> · <a href={t.prUrl} target="_blank" rel="noreferrer">PR</a></> : null}</div></td>
              <td><Chip s={t.status} />{t.openHil ? <Link href={`/hil?task=${t.id}`} className="badge">{t.openHil}</Link> : null}</td>
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

function NewTaskForm() {
  const toast = useStore((s) => s.toast);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [repos, setRepos] = useState<{ name: string; path: string }[]>([]);
  const [repo, setRepo] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [branches, setBranches] = useState<{ remote: string | null; branch: string }[]>([]);
  const [base, setBase] = useState('');
  const [pipeline, setPipeline] = useState('');
  const [reviewMode, setReviewMode] = useState<'conceptual' | 'line'>('conceptual');
  const [postReview, setPostReview] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [startAt, setStartAt] = useState('');
  const [existingBranch, setExistingBranch] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [overrides, setOverrides] = useState<ModelOverrides>({});
  const [busy, setBusy] = useState(false);
  const [gh, setGh] = useState<{ q: string; list: { slug: string; description: string; isFork: boolean }[]; open: boolean }>({ q: '', list: [], open: false });

  useEffect(() => { void api.config().then((c) => { setCfg(c); setRepos(c.repos); setPipeline(c.defaultPipeline); }); void api.pipelines().then((p) => setPipelines(p.pipelines)); void api.models().then((r) => setModels(r.models)).catch(() => {}); }, []);
  useEffect(() => {
    if (!repo || repo === '__custom') { setBranches([]); return; }
    void api.branches(repo).then((b) => { setBranches(b.branches); setBase(b.default.remote ? `${b.default.remote}/${b.default.branch}` : b.default.branch); }).catch((e) => toast(String(e.message), 'error'));
  }, [repo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const repoPath = repo === '__custom' ? customPath : repos.find((r) => r.name === repo)?.path;
      if (!repoPath) throw new Error('choose a repository');
      let baseRemote: string | null | undefined; let baseBranch: string | undefined;
      if (base) { const found = branches.find((b) => (b.remote ? `${b.remote}/${b.branch}` : b.branch) === base); if (found) { baseRemote = found.remote; baseBranch = found.branch; } else { const [r, ...rest] = base.split('/'); if (rest.length) { baseRemote = r; baseBranch = rest.join('/'); } else { baseRemote = null; baseBranch = r; } } }
      const t = await api.createTask({ prompt, repoPath, pipeline, baseRemote, baseBranch, reviewMode, postReview, branch: existingBranch || undefined, startAt: startAt || undefined, modelOverrides: Object.keys(overrides).length ? overrides : undefined });
      toast(`task ${t.id} created`); setPrompt(''); setOverrides({}); setStartAt(''); setExistingBranch('');
    } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const addGithub = async (slug: string) => {
    setBusy(true);
    try { const r = await api.addRepo({ slug }); setRepos((rs) => [...rs.filter((x) => x.path !== r.path), r]); setRepo(r.name); setGh({ q: '', list: [], open: false }); toast(`cloned ${slug}`); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const searchGithub = async () => { try { const r = await api.githubRepos(gh.q || undefined); setGh((g) => ({ ...g, list: r.repos })); } catch (err) { toast((err as Error).message, 'error'); } };

  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ marginTop: 0 }}>New task</h3>
      <textarea placeholder="What should be done? Be concrete about the outcome; Claude will ask if something is ambiguous." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <div className="grid2" style={{ marginTop: 8 }}>
        <div>
          <label className="small muted">Repository</label>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">— choose —</option>
            {repos.map((r) => <option key={r.path} value={r.name}>{r.name} <span className="muted">({r.path})</span></option>)}
            <option value="__custom">local path…</option>
          </select>
          {repo === '__custom' && <input style={{ marginTop: 6 }} placeholder="/abs/path/to/repo" value={customPath} onChange={(e) => setCustomPath(e.target.value)} />}
          <div className="small" style={{ marginTop: 4 }}><a href="#" onClick={(e) => { e.preventDefault(); setGh((g) => ({ ...g, open: !g.open })); if (!gh.list.length) void searchGithub(); }}>{gh.open ? 'hide GitHub' : 'add from GitHub…'}</a>{cfg ? <span className="muted"> · clones into {cfg.reposDir}</span> : null}</div>
          {gh.open && (
            <div style={{ marginTop: 6 }}>
              <div className="row"><input placeholder="search repos (empty = mine)" value={gh.q} onChange={(e) => setGh((g) => ({ ...g, q: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void searchGithub(); } }} /><button type="button" onClick={searchGithub}>Search</button></div>
              <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 6 }}>{gh.list.map((r) => <div key={r.slug} className="row small" style={{ padding: '3px 0' }}><a href="#" onClick={(e) => { e.preventDefault(); void addGithub(r.slug); }}>{r.slug}</a>{r.isFork ? <span className="chip">fork</span> : null}<span className="muted grow">{r.description}</span></div>)}</div>
            </div>
          )}
        </div>
        <div>
          <label className="small muted">Base (remote/branch)</label>
          <input list="branches" value={base} onChange={(e) => setBase(e.target.value)} placeholder="origin/main" />
          <datalist id="branches">{branches.map((b) => { const v = b.remote ? `${b.remote}/${b.branch}` : b.branch; return <option key={v} value={v} />; })}</datalist>
          <div className="row" style={{ marginTop: 6 }}>
            <div className="grow"><label className="small muted">Pipeline</label><select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>{pipelines.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></div>
            <div><label className="small muted">Review</label><select value={reviewMode} onChange={(e) => setReviewMode(e.target.value as 'conceptual' | 'line')}><option value="conceptual">conceptual</option><option value="line">line-level</option></select></div>
          </div>
          <label className="small muted" style={{ display: 'block', marginTop: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={postReview} onChange={(e) => setPostReview(e.target.checked)} /> post review to GitHub PR</label>
          {pipelines.find((p) => p.name === pipeline) && <div className="small muted" style={{ marginTop: 4 }}>{pipelines.find((p) => p.name === pipeline)!.phases.map((p) => p.type === 'hil' ? `[${p.name}]` : p.name).join(' → ')}</div>}
        </div>
      </div>
      <div className="small" style={{ marginTop: 8 }}><a href="#" onClick={(e) => { e.preventDefault(); setAdvanced(!advanced); }}>{advanced ? 'hide advanced' : 'advanced: start phase, existing branch, models for this task…'}</a></div>
      {advanced && (
        <div className="grid2" style={{ marginTop: 6 }}>
          <div>
            <label className="small muted">Start at phase</label>
            <select value={startAt} onChange={(e) => setStartAt(e.target.value)}><option value="">first phase</option>{(pipelines.find((p) => p.name === pipeline)?.phases ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}{p.type === 'hil' ? ' (checkpoint)' : ''}</option>)}</select>
            <label className="small muted" style={{ marginTop: 6, display: 'block' }}>Existing branch (instead of a new one)</label>
            <input list="local-branches" value={existingBranch} onChange={(e) => setExistingBranch(e.target.value)} placeholder="feature/x — leave empty to create sdlc/<id>" />
            <datalist id="local-branches">{branches.filter((b) => !b.remote).map((b) => <option key={b.branch} value={b.branch} />)}</datalist>
            <div className="small muted" style={{ marginTop: 4 }}>Phases before the start phase are recorded as skipped. With an existing branch the base is still used for diffs and the PR.</div>
          </div>
          <div>
            <label className="small muted">Models for this task only (empty = global settings)</label>
            <ModelPicker phases={(pipelines.find((p) => p.name === pipeline)?.phases ?? []).filter((p) => p.type === 'claude').map((p) => p.name)} models={models} value={overrides} onChange={setOverrides} inheritLabel="global" />
          </div>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={busy || !prompt.trim()}>Create task</button><span className="small muted">Human checkpoints are shown in [brackets].</span></div>
    </form>
  );
}

function ImportPrForm() {
  const toast = useStore((s) => s.toast);
  const [repos, setRepos] = useState<{ name: string; path: string }[]>([]);
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [repo, setRepo] = useState('');
  const [pipeline, setPipeline] = useState('');
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.config().then((c) => { setRepos(c.repos); setPipeline(c.defaultPipeline); }); void api.pipelines().then((p) => setPipelines(p.pipelines)); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const repoPath = repos.find((r) => r.name === repo)?.path;
    const n = Number(/(\d+)\s*$/.exec(number.trim())?.[1]);
    if (!repoPath || !n) { toast('choose a repository and a PR number', 'error'); return; }
    setBusy(true);
    try { const t = await api.importPr({ repoPath, number: n, pipeline }); toast(`task ${t.id} attached to PR #${n}; use "Poll PR comments"`); setNumber(''); }
    catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="card" onSubmit={submit}>
      <div className="row">
        <b>Import PR</b>
        <select value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">— repository —</option>{repos.map((r) => <option key={r.path} value={r.name}>{r.name}</option>)}</select>
        <input style={{ maxWidth: 220 }} placeholder="PR number or URL" value={number} onChange={(e) => setNumber(e.target.value)} />
        <select value={pipeline} onChange={(e) => setPipeline(e.target.value)}>{pipelines.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select>
        <button disabled={busy}>Import</button>
        <span className="small muted">The PR branch becomes the task branch; the task waits for review comments.</span>
      </div>
    </form>
  );
}
