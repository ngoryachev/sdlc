import { useEffect, useState } from 'react';
import type { ModelOverrides } from '@sdlc/shared';
import { api, type Config, type ModelChoice, type PipelineInfo } from '../lib/api.js';
import { useStore } from '../lib/store.js';
import { EFFORTS, ModelPicker } from '../components/ModelPicker.js';

const PHASE_TYPES = ['clarify', 'plan', 'implement', 'self_check', 'test', 'review', 'qa'];

export function SettingsPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [form, setForm] = useState<{ default_pipeline: string; max_parallel_tasks: number; task_budget_usd: string; limits: 'pipeline' | 'off'; merge_method: string; cleanup: string; model: string; effort: string; phases: ModelOverrides } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const load = () => api.config().then((c) => { setCfg(c); setForm({ default_pipeline: c.defaultPipeline, max_parallel_tasks: c.maxParallelTasks, task_budget_usd: String(c.taskBudgetUsd), limits: c.limits.phases, merge_method: c.mergeMethod, cleanup: c.cleanup, model: c.models.default ?? '', effort: c.models.effort ?? '', phases: c.models.phases as ModelOverrides }); });
  useEffect(() => { void load(); void api.pipelines().then((p) => setPipelines(p.pipelines)); void api.models().then((r) => { setModels(r.models); if (r.error) setModelsErr(r.error); }).catch((e) => setModelsErr(String(e.message))); }, []);
  if (!cfg || !form) return <div className="muted">loading…</div>;
  const save = async () => {
    setBusy(true);
    try {
      const budget = form.task_budget_usd.trim() === 'off' || form.task_budget_usd.trim() === '' ? 'off' : Number(form.task_budget_usd);
      if (budget !== 'off' && !(budget > 0)) throw new Error('task budget must be a positive number or "off"');
      const models = { ...(form.model ? { default: form.model } : {}), ...(form.effort ? { effort: form.effort } : {}), phases: form.phases };
      const c = await api.updateConfig({ default_pipeline: form.default_pipeline, max_parallel_tasks: form.max_parallel_tasks, task_budget_usd: budget, limits: { phases: form.limits }, merge_method: form.merge_method, cleanup: form.cleanup, models });
      setCfg(c); toast('settings saved; they apply from the next phase of every task');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const known = new Set(models.map((m) => m.value));
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Settings <span className="small muted">(saved to ~/.sdlc/config.yaml, picked up at the next phase start)</span></h3>
        <div className="grid2">
          <div>
            <label className="small muted">Default pipeline</label>
            <select value={form.default_pipeline} onChange={(e) => setForm({ ...form, default_pipeline: e.target.value })}>{pipelines.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}{!pipelines.some((p) => p.name === form.default_pipeline) && <option value={form.default_pipeline}>{form.default_pipeline}</option>}</select>
            <label className="small muted" style={{ marginTop: 6, display: 'block' }}>Parallel tasks</label>
            <input type="number" min={1} value={form.max_parallel_tasks} onChange={(e) => setForm({ ...form, max_parallel_tasks: Math.max(1, Number(e.target.value) || 1) })} />
            <label className="small muted" style={{ marginTop: 6, display: 'block' }}>Task budget, $ (or "off")</label>
            <input value={form.task_budget_usd} onChange={(e) => setForm({ ...form, task_budget_usd: e.target.value })} />
            <label className="small muted" style={{ marginTop: 6, display: 'block' }}>Phase limits (max_turns / max_budget_usd from pipelines)</label>
            <select value={form.limits} onChange={(e) => setForm({ ...form, limits: e.target.value as 'pipeline' | 'off' })}><option value="pipeline">enforce (from pipeline yaml)</option><option value="off">off (no per-phase limits)</option></select>
          </div>
          <div>
            <label className="small muted">Merge method (Land)</label>
            <select value={form.merge_method} onChange={(e) => setForm({ ...form, merge_method: e.target.value })}><option value="merge">merge commit</option><option value="squash">squash</option><option value="rebase">rebase</option></select>
            <label className="small muted" style={{ marginTop: 6, display: 'block' }}>Worktree cleanup</label>
            <select value={form.cleanup} onChange={(e) => setForm({ ...form, cleanup: e.target.value })}><option value="never">never (explicit: button / sdlc cleanup / Land)</option><option value="on_pr">on PR</option><option value="on_approve">on approve</option></select>
            <div className="small muted" style={{ marginTop: 10 }}>public URL <span className="mono">{cfg.publicUrl}</span> · repos dir <span className="mono">{cfg.reposDir}</span></div>
            <div className="small muted" style={{ marginTop: 4 }}>telegram: {cfg.telegram.enabled ? (cfg.telegram.configured ? `enabled · chat ${cfg.telegram.chatId ?? '(unset: message the bot, see server log)'}` : 'enabled but no bot_token') : 'disabled'} {cfg.telegram.configured && <button onClick={() => api.telegramTest().then((r) => toast(r.ok ? 'sent' : r.error ?? 'failed', r.ok ? 'info' : 'error')).catch((e) => toast(e.message, 'error'))}>send test</button>}</div>
          </div>
        </div>
        <h4 style={{ marginBottom: 4 }}>Models</h4>
        <div className="small muted" style={{ marginBottom: 6 }}>Resolution at every phase start: task override → per-phase below → default below → pipeline yaml. {modelsErr ? <span className="chip failed">model list unavailable: {modelsErr}</span> : `${models.length} models from the CLI`}</div>
        <div className="row">
          <div className="grow"><label className="small muted">Default model</label>
            <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}><option value="">pipeline default</option>{form.model && !known.has(form.model) && <option value={form.model}>{form.model}</option>}{models.map((m) => <option key={m.value} value={m.value} title={m.description}>{m.displayName} ({m.value})</option>)}</select></div>
          <div><label className="small muted">Default effort</label>
            <select value={form.effort} onChange={(e) => setForm({ ...form, effort: e.target.value })}><option value="">pipeline default</option>{EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
        </div>
        <div style={{ marginTop: 8 }}><ModelPicker phases={PHASE_TYPES} models={models} value={form.phases} onChange={(phases) => setForm({ ...form, phases })} inheritLabel="default" /></div>
        <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={busy} onClick={save}>Save</button><button disabled={busy} onClick={() => void load()}>Reset</button></div>
      </div>
      <div className="card">
        <h4 style={{ marginTop: 0 }}>Repositories</h4>
        {cfg.repos.map((r) => <div key={r.path}><b>{r.name}</b> <span className="mono small muted">{r.path}</span></div>)}{cfg.repos.length === 0 && <span className="muted">none registered</span>}
      </div>
    </>
  );
}
