import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Hono } from 'hono';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONFIG_VERSION, loadConfig, saveConfig } from '../../server/src/config/config.js';
import { createApp } from '../../server/src/app.js';
import { configRoutes } from '../../server/src/http/routes/config.js';
import { createHttpApp } from '../../server/src/http/app.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, tmpDir } from '../helpers.js';

/**
 * Files written by the old saveConfig froze every default in, so the pre-f2a0126 phase limits and task budget are
 * still in them. They are migrated once on load; a value chosen after the migration has to survive.
 */
describe('config migration', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  const setup = (file: Record<string, unknown>) => {
    const dir = tmpDir('sdlc-config-migrate-');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, YAML.stringify({ data_dir: path.join(dir, 'data'), ...file }));
    return configPath;
  };
  const read = (p: string) => YAML.parse(fs.readFileSync(p, 'utf8'));

  it('turns the frozen phase limits and task budget of an unversioned file into the current defaults', () => {
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20, max_loops: 15, default_pipeline: 'quick' });
    const cfg = loadConfig(configPath);
    expect([cfg.limits.phases, cfg.task_budget_usd]).toEqual(['off', 100]);

    const saved = read(configPath);
    expect(saved.config_version).toBe(CONFIG_VERSION);
    expect(saved.limits).toBeUndefined();
    expect(saved.task_budget_usd).toBeUndefined();
    expect(saved.max_loops).toBeUndefined();        // a default-valued key the file had is dropped too
    expect(saved.default_pipeline).toBe('quick');   // a real choice stays

    const again = loadConfig(configPath);
    expect([again.limits.phases, again.task_budget_usd]).toEqual(['off', 100]);
  });

  it('keeps pipeline limits and a budget that were chosen after the migration', () => {
    const configPath = setup({ config_version: CONFIG_VERSION, limits: { phases: 'pipeline' }, task_budget_usd: 20 });
    const cfg = loadConfig(configPath);
    expect([cfg.limits.phases, cfg.task_budget_usd]).toEqual(['pipeline', 20]);

    saveConfig(cfg, configPath);
    expect(read(configPath).limits).toEqual({ phases: 'pipeline' });
    expect(read(configPath).task_budget_usd).toBe(20);

    const again = loadConfig(configPath);
    expect([again.limits.phases, again.task_budget_usd]).toEqual(['pipeline', 20]);
  });

  it('loads an old file with unknown keys and keeps loading it after the rewrite', () => {
    const configPath = setup({ legacy_key: 'x', server: { host: '0.0.0.0', port: 7337, nested_unknown: true } });
    expect(loadConfig(configPath).server.host).toBe('0.0.0.0');
    expect(read(configPath).config_version).toBe(CONFIG_VERSION);
    expect(loadConfig(configPath).server.host).toBe('0.0.0.0');
  });

  /** Settings reads the select and the budget field from GET /config, so they must show the migrated values. */
  it('serves the migrated values to the settings page', async () => {
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20 });
    const app = createApp({ config: loadConfig(configPath), runner: new FakeRunner(() => ({ act: () => ({}) })), dbFile: ':memory:', configPath });
    const res = await new Hono().route('/api', configRoutes(app)).request('/api/config');
    const body = await res.json() as { limits: { phases: string }; taskBudgetUsd: number };
    expect([body.limits.phases, body.taskBudgetUsd]).toEqual(['off', 100]);
  });

  /** The rewrite is a write the user never asked for: a value they really chose must come through it unharmed. */
  it('leaves a budget that is not the frozen 20 and an explicit off alone', () => {
    const configPath = setup({ limits: { phases: 'off' }, task_budget_usd: 50 });
    const cfg = loadConfig(configPath);
    expect([cfg.limits.phases, cfg.task_budget_usd]).toEqual(['off', 50]);
    expect(read(configPath).task_budget_usd).toBe(50);
  });

  /** loadConfig writes the file now, so the env-secret guarantee of saveConfig has to hold on that path too. */
  it('keeps secrets that came from the environment out of the file it rewrites', () => {
    vi.stubEnv('SDLC_TOKEN', 'env-server'); vi.stubEnv('SDLC_TELEGRAM_TOKEN', 'env-bot');
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20, telegram: { enabled: true } });
    const cfg = loadConfig(configPath);
    expect([cfg.server.token, cfg.telegram.bot_token]).toEqual(['env-server', 'env-bot']);
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('env-');
    expect(read(configPath).telegram).toEqual({ enabled: true });
  });

  it('rewrites the file once and leaves it alone on every later load', () => {
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20 });
    loadConfig(configPath);
    const after = fs.readFileSync(configPath, 'utf8');
    loadConfig(configPath); loadConfig(configPath);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(after);
  });

  /** A config that cannot be written (read-only deployment) must not stop the server; the safe values are in memory. */
  it('serves the migrated values when the file cannot be rewritten', () => {
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20 });
    fs.chmodSync(configPath, 0o444);
    try {
      const cfg = loadConfig(configPath);
      expect([cfg.limits.phases, cfg.task_budget_usd]).toEqual(['off', 100]);
      expect(read(configPath).limits).toEqual({ phases: 'pipeline' });   // unchanged on disk
    } finally { fs.chmodSync(configPath, 0o644); }
  });

  /** The whole point of the version stamp: turning the phase limits back on in Settings has to survive a restart. */
  it('keeps phase limits turned back on in Settings across a restart', async () => {
    vi.stubEnv('SDLC_TOKEN', ''); vi.stubEnv('SDLC_TELEGRAM_TOKEN', '');
    const configPath = setup({ limits: { phases: 'pipeline' }, task_budget_usd: 20 });
    const app = createApp({ config: loadConfig(configPath), runner: new FakeRunner(() => ({ act: () => ({}) })), dbFile: ':memory:', configPath });
    const hono = createHttpApp(app);
    const body = { task_budget_usd: 20, limits: { phases: 'pipeline' } };
    const res = await hono.request('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${app.config.server.token!}` }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);

    const restarted = loadConfig(configPath);
    expect([restarted.limits.phases, restarted.task_budget_usd]).toEqual(['pipeline', 20]);
  });

  /** What the migration is for: the pipelines' per-phase caps stop reaching the runner. */
  it('stops passing the pipelines per-phase caps to Claude once the file is migrated', async () => {
    const dir = tmpDir('sdlc-migrate-caps-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const root = path.join(dir, 'sdlc');
    fs.mkdirSync(path.join(root, 'pipelines'), { recursive: true }); fs.mkdirSync(path.join(root, 'prompts/system'), { recursive: true });
    fs.writeFileSync(path.join(root, 'prompts/work.md'), '# Phase: work\n');
    fs.writeFileSync(path.join(root, 'prompts/system/common.md'), '');
    fs.writeFileSync(path.join(root, 'pipelines/live.yaml'), 'name: live\nphases:\n  - name: work\n    type: claude\n    prompt: prompts/work.md\n    max_turns: 3\n    max_budget_usd: 3\n');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, YAML.stringify({
      data_dir: path.join(dir, 'data'), worktrees_dir: path.join(dir, 'wt'), pipelines_dirs: [path.join(root, 'pipelines')],
      cleanup: 'never', pr_sync_interval: 'off', limits: { phases: 'pipeline' }, task_budget_usd: 20,
    }));
    const runner = new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));
    const app = createApp({ config: loadConfig(configPath), runner, dbFile: ':memory:', configPath });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'live', baseRemote: null });
    await app.engine.advance(task.id);
    expect([runner.specs[0]!.maxTurns, runner.specs[0]!.maxBudgetUsd]).toEqual([undefined, undefined]);
  });

  it('creates no file when there is none', async () => {
    const home = tmpDir('sdlc-config-home-');
    vi.stubEnv('SDLC_HOME', home); vi.resetModules();   // CONFIG_PATH and the defaults are read at module load
    const { loadConfig: load } = await import('../../server/src/config/config.js');
    const configPath = path.join(home, 'config.yaml');
    expect(load(configPath).limits.phases).toBe('off');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
