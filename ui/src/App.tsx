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
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>
    </>
  );
}

function Login() {
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 480, margin: '10vh auto' }}>
        <h2>sdlc</h2>
        <p className="muted">This browser is not authorized. Open the link printed by <code>sdlc serve</code> (it contains <code>?t=…</code>), or paste the token:</p>
        <form onSubmit={(e) => { e.preventDefault(); const t = (new FormData(e.currentTarget).get('t') as string).trim(); location.href = `/?t=${encodeURIComponent(t)}`; }}>
          <input name="t" placeholder="token" autoFocus />
          <div style={{ marginTop: 8 }}><button className="primary">Continue</button></div>
        </form>
      </div>
    </main>
  );
}
