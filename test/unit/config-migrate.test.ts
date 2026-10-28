import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Hono } from 'hono';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONFIG_VERSION, loadConfig, saveConfig } from '../../server/src/config/config.js';
import { createApp } from '../../server/src/app.js';
import { configRoutes } from '../../server/src/http/routes/config.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { tmpDir } from '../helpers.js';

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

  it('creates no file when there is none', async () => {
    const home = tmpDir('sdlc-config-home-');
    vi.stubEnv('SDLC_HOME', home); vi.resetModules();   // CONFIG_PATH and the defaults are read at module load
    const { loadConfig: load } = await import('../../server/src/config/config.js');
    const configPath = path.join(home, 'config.yaml');
    expect(load(configPath).limits.phases).toBe('off');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
