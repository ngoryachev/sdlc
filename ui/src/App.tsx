import { useEffect } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { useStore } from './lib/store.js';
import { setBadge } from './lib/notify.js';
import { Dashboard } from './pages/Dashboard.js';
import { TaskPage } from './pages/TaskPage.js';
import { HilQueue, HilPage } from './pages/Hil.js';
import { SettingsPage } from './pages/Settings.js';
import { EventsPage } from './pages/Events.js';

export function App() {
  const conn = useStore((s) => s.conn);
  const hilCount = useStore((s) => s.hil.length);
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);
  const [loc] = useLocation();
  useEffect(() => setBadge(hilCount), [hilCount]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'g') { const once = (e2: KeyboardEvent) => { if (e2.key === 'h') history.pushState(null, '', '/hil'); if (e2.key === 'd') history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); window.removeEventListener('keydown', once); }; window.addEventListener('keydown', once, { once: true }); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  if (conn === 'unauthorized') return <Login />;
  return (
    <>
      <header className="topbar">
        <span className="brand">sdlc</span>
        <nav>
          <Link href="/" className={loc === '/' ? 'on' : ''}>Tasks</Link>
          <Link href="/hil">HIL{hilCount ? <span className="badge">{hilCount}</span> : null}</Link>
          <Link href="/events" className="hide-sm">Events</Link>
          <Link href="/settings" className="hide-sm">Settings</Link>
        </nav>
        <QuotaChip />
        <span className="small muted"><span className={`dot ${conn}`} />{conn}</span>
      </header>
      <main className="page">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/tasks/:id" component={TaskPage} />
          <Route path="/tasks/:id/phases/:phaseRunId" component={TaskPage} />
          <Route path="/hil" component={HilQueue} />
          <Route path="/hil/:id" component={HilPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/events" component={EventsPage} />
          <Route>Not found</Route>
        </Switch>
      </main>
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)} title="click to dismiss">{t.text}</div>)}</div>
    </>
  );
}

function Login() {
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 480, margin: '10vh auto' }}>
        <h2>sdlc</h2>
        <p className="muted">This browser is not authorized. Open the link printed by <code>sdlc serve</code> (it contains <code>?t=…</code>), or paste the token:</p>
        <form onSubmit={async (e) => { e.preventDefault(); const t = (new FormData(e.currentTarget).get('t') as string).trim(); const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) }); if (r.ok) location.href = '/'; else alert('bad token'); }}>
          <input name="t" placeholder="token" autoFocus />
          <div style={{ marginTop: 8 }}><button className="primary">Continue</button></div>
        </form>
      </div>
    </main>
  );
}

/** Plan usage of the Claude subscription: the 5-hour and 7-day windows, as the CLI last reported them. */
function QuotaChip() {
  const quota = useStore((s) => s.quota);
  if (!quota) return null;
  const when = (iso: string | null) => (iso ? `resets ${new Date(iso).toLocaleString()}` : '');
  const cls = (u: number) => (u >= 90 ? 'failed' : u >= 70 ? 'warn' : '');
  const win = (label: string, w: { utilization: number; resetsAt: string | null } | null) => w && <span className={`chip ${cls(w.utilization)}`} title={`${label} window: ${w.utilization}% used${w.resetsAt ? `, ${when(w.resetsAt)}` : ''}`}>{label} {Math.round(w.utilization)}%</span>;
  return <span className="small muted hide-sm" style={{ display: 'inline-flex', gap: 4, marginRight: 10 }} title={`Claude plan usage, updated ${new Date(quota.updatedAt).toLocaleTimeString()}`}>{win('5h', quota.fiveHour)}{win('7d', quota.sevenDay)}</span>;
}
