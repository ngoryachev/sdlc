import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type GhAccount, type GhRepoRow, type RegisteredRepo } from '../lib/api.js';
import { ago } from './Common.js';

/** What the user picked: a cloned repository, a GitHub repository to clone, or a local path. */
export interface RepoChoice { kind: 'registered' | 'github' | 'path'; name: string; path?: string; slug?: string; account?: string | null; defaultBranch?: string }

/** Resolve a choice to a local path; GitHub repositories are cloned (with the chosen account) on the way. */
export async function resolveRepoPath(c: RepoChoice): Promise<string> {
  if (c.kind === 'github') return (await api.addRepo({ slug: c.slug!, gh_user: c.account ?? null })).path;
  if (!c.path) throw new Error('choose a repository');
  return c.path;
}

/** One searchable list: cloned repositories first, then every repository the chosen GitHub account can see. */
export function RepoPicker({ value, onChange }: { value: RepoChoice | null; onChange: (c: RepoChoice | null) => void }) {
  const [accounts, setAccounts] = useState<GhAccount[]>([]);
  const [account, setAccount] = useState('');
  const [registered, setRegistered] = useState<RegisteredRepo[]>([]);
  const [remote, setRemote] = useState<GhRepoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    void api.ghAccounts().then((r) => { setAccounts(r.accounts); setAccount((a) => a || r.accounts.find((x) => x.active)?.login || r.accounts[0]?.login || ''); if (r.error) setErr(r.error); }).catch((e) => setErr(String(e.message)));
    void api.repos().then((r) => setRegistered(r.repos)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!account) return;
    setLoading(true); setErr(null);
    void api.githubRepos(account).then((r) => setRemote(r.repos)).catch((e) => { setRemote([]); setErr(String(e.message)); }).finally(() => setLoading(false));
  }, [account]);

  const needle = q.trim().toLowerCase();
  const match = (...xs: (string | null | undefined)[]) => !needle || xs.some((x) => x?.toLowerCase().includes(needle));
  const regNames = useMemo(() => new Set(registered.map((r) => r.name)), [registered]);
  const regItems = registered.filter((r) => match(r.name, r.path));
  const ghItems = remote.filter((r) => !r.cloned && !regNames.has(r.slug) && match(r.slug, r.description));
  const pick = (c: RepoChoice) => { onChange(c); setOpen(false); setQ(''); };
  const label = (c: RepoChoice) => (c.kind === 'github' ? `${c.slug} (GitHub, will be cloned)` : c.kind === 'path' ? c.path ?? '' : c.name);

  return (
    <div className="repo-picker">
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input
          value={open ? q : value ? label(value) : q}
          placeholder="search your repositories…"
          onFocus={() => { if (closeTimer.current) window.clearTimeout(closeTimer.current); setOpen(true); setQ(''); }}
          onBlur={() => { closeTimer.current = window.setTimeout(() => setOpen(false), 150); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        />
        <select style={{ width: 'auto' }} value={account} onChange={(e) => setAccount(e.target.value)} title="GitHub account whose repositories are listed (and used to clone a new one)">
          {accounts.map((a) => <option key={a.login} value={a.login}>{a.login}{a.active ? ' · gh default' : ''}</option>)}
          {accounts.length === 0 && <option value="">no gh accounts</option>}
        </select>
      </div>
      {open && (
        <div className="dropdown" onMouseDown={(e) => e.preventDefault()}>
          {regItems.length > 0 && <div className="group">cloned</div>}
          {regItems.map((r) => (
            <div key={r.path} className="opt" onClick={() => pick({ kind: 'registered', name: r.name, path: r.path, account: r.ghUser })}>
              <b>{r.name}</b>{r.ghUser && <span className="chip">{r.ghUser}</span>}{!r.exists && <span className="chip failed">missing</span>}<span className="small muted mono">{r.path}</span>
            </div>
          ))}
          <div className="group">{account || 'GitHub'} · {loading ? 'loading…' : `${ghItems.length} repositories`}</div>
          {err && <div className="opt small" style={{ color: 'var(--err)' }}>{err}</div>}
          {ghItems.slice(0, 300).map((r) => (
            <div key={r.slug} className="opt" onClick={() => pick({ kind: 'github', name: r.slug, slug: r.slug, account, defaultBranch: r.defaultBranch })}>
              <span>{r.slug}</span>
              {r.isPrivate && <span className="chip">private</span>}{r.isFork && <span className="chip">fork</span>}{!r.canPush && <span className="chip" title="this account cannot push here">read-only</span>}
              <span className="small muted grow">{r.description}</span><span className="small muted">{r.pushedAt ? `${ago(r.pushedAt)} ago` : ''}</span>
            </div>
          ))}
          <div className="opt small" onClick={() => pick({ kind: 'path', name: customPath, path: customPath })}>local path…</div>
        </div>
      )}
      {value?.kind === 'path' && <input style={{ marginTop: 6 }} placeholder="/abs/path/to/repo" value={value.path ?? ''} onChange={(e) => { setCustomPath(e.target.value); onChange({ kind: 'path', name: e.target.value, path: e.target.value }); }} />}
      {value?.kind === 'github' && <div className="small muted" style={{ marginTop: 4 }}>cloned on create, as {value.account}</div>}
      {value?.kind === 'registered' && value.account && <div className="small muted" style={{ marginTop: 4 }}>GitHub account: {value.account}</div>}
    </div>
  );
}
