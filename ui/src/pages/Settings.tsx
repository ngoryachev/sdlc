import { useEffect, useState } from 'react';
import { api, type Config } from '../lib/api.js';
import { useStore } from '../lib/store.js';

export function SettingsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const toast = useStore((s) => s.toast);
  useEffect(() => { void api.config().then(setCfg); }, []);
  if (!cfg) return <div className="muted">loading…</div>;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Settings <span className="small muted">(read-only; edit ~/.sdlc/config.yaml)</span></h3>
      <table><tbody>
        <tr><th>public URL</th><td className="mono">{cfg.publicUrl}</td></tr>
        <tr><th>default pipeline</th><td>{cfg.defaultPipeline}</td></tr>
        <tr><th>parallel tasks</th><td>{cfg.maxParallelTasks}</td></tr>
        <tr><th>task budget</th><td>${cfg.taskBudgetUsd}</td></tr>
        <tr><th>worktree cleanup</th><td>{cfg.cleanup}</td></tr>
        <tr><th>repos dir</th><td className="mono">{cfg.reposDir}</td></tr>
        <tr><th>repos</th><td>{cfg.repos.map((r) => <div key={r.path}><b>{r.name}</b> <span className="mono small muted">{r.path}</span></div>)}{cfg.repos.length === 0 && <span className="muted">none registered</span>}</td></tr>
        <tr><th>telegram</th><td>{cfg.telegram.enabled ? (cfg.telegram.configured ? `enabled · chat ${cfg.telegram.chatId ?? '(unset: message the bot, see server log)'}` : 'enabled but no bot_token') : 'disabled'} {cfg.telegram.configured && <button onClick={() => api.telegramTest().then((r) => toast(r.ok ? 'sent' : r.error ?? 'failed', r.ok ? 'info' : 'error')).catch((e) => toast(e.message, 'error'))}>send test</button>}</td></tr>
      </tbody></table>
    </div>
  );
}
