import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { api, type Config, type PipelineInfo } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { Chip, Money, ago } from '../components/Common.js';

export function Dashboard() {
  const tasks = useStore((s) => s.tasks);
  const [showDone, setShowDone] = useState(false);
  const visible = tasks.filter((t) => showDone || !['succeeded', 'failed', 'aborted'].includes(t.status));
  return (
    <>
      <NewTaskForm />
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
  const [busy, setBusy] = useState(false);
  const [gh, setGh] = useState<{ q: string; list: { slug: string; description: string; isFork: boolean }[]; open: boolean }>({ q: '', list: [], open: false });

  useEffect(() => { void api.config().then((c) => { setCfg(c); setRepos(c.repos); setPipeline(c.defaultPipeline); }); void api.pipelines().then((p) => setPipelines(p.pipelines)); }, []);
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
      const t = await api.createTask({ prompt, repoPath, pipeline, baseRemote, baseBranch, reviewMode, postReview });
      toast(`task ${t.id} created`); setPrompt('');
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
      <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={busy || !prompt.trim()}>Create task</button><span className="small muted">Human checkpoints are shown in [brackets].</span></div>
    </form>
  );
}
