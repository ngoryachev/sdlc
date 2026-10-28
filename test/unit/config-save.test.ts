import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CONFIG_VERSION, loadConfig, saveConfig } from '../../server/src/config/config.js';
import { createApp } from '../../server/src/app.js';
import { createHttpApp } from '../../server/src/http/app.js';
import { FakeRunner } from '../fakes/fake-runner.js';
import { testApp, tmpDir } from '../helpers.js';

/** SDLC_TELEGRAM_TOKEN and SDLC_TOKEN live in the env file: saving the config must not copy them into config.yaml. */
describe('saveConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  const setup = (file: Record<string, unknown>) => {
    const dir = tmpDir('sdlc-config-save-');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, YAML.stringify({ data_dir: path.join(dir, 'data'), ...file }));
    return configPath;
  };
  const read = (p: string) => YAML.parse(fs.readFileSync(p, 'utf8'));

  it('leaves secrets taken from the environment out of the file', () => {
    vi.stubEnv('SDLC_TELEGRAM_TOKEN', 'env-bot'); vi.stubEnv('SDLC_TOKEN', 'env-server');
    const configPath = setup({ telegram: { enabled: true, chat_id: '1' } });
    const cfg = loadConfig(configPath);
    expect([cfg.telegram.bot_token, cfg.server.token]).toEqual(['env-bot', 'env-server']);
    cfg.max_loops = 3;
    saveConfig(cfg, configPath);
    const saved = read(configPath);
    expect(saved.max_loops).toBe(3);
    expect(saved.telegram).toEqual({ enabled: true, chat_id: '1' });
    expect(saved.server?.token).toBeUndefined();
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('env-');
  });

  it('keeps what the file had when the environment overrides it', () => {
    vi.stubEnv('SDLC_TELEGRAM_TOKEN', 'env-bot');
    const configPath = setup({ telegram: { enabled: true, bot_token: 'file-bot' } });
    saveConfig(loadConfig(configPath), configPath);
    expect(read(configPath).telegram.bot_token).toBe('file-bot');
  });

  it('still writes secrets that did not come from the environment', () => {
    vi.stubEnv('SDLC_TELEGRAM_TOKEN', ''); vi.stubEnv('SDLC_TOKEN', '');
    const configPath = setup({});
    const cfg = loadConfig(configPath);
    cfg.server.token = 'generated'; cfg.telegram.bot_token = 'typed';
    saveConfig(cfg, configPath);
    expect(read(configPath).server.token).toBe('generated');
    expect(read(configPath).telegram.bot_token).toBe('typed');
  });

  /** A default frozen into the file is a default that never changes again: only what differs from the schema is written. */
  it('writes only what differs from the defaults', () => {
    vi.stubEnv('SDLC_TELEGRAM_TOKEN', ''); vi.stubEnv('SDLC_TOKEN', '');
    const configPath = setup({ max_loops: 15, max_parallel_tasks: 10, limits: { phases: 'off' }, server: { host: '127.0.0.1', port: 7337, token_in_url: true }, models: { phases: {} }, repos: [] });
    const cfg = loadConfig(configPath);
    cfg.server.port = 7400;
    saveConfig(cfg, configPath);
    const saved = read(configPath);
    expect(Object.keys(saved).sort()).toEqual(['config_version', 'data_dir', 'server']);
    expect(saved.config_version).toBe(CONFIG_VERSION);
    expect(saved.server).toEqual({ port: 7400 });
  });

  it('does not put defaults back when the UI saves the settings', async () => {
    vi.stubEnv('SDLC_TELEGRAM_TOKEN', ''); vi.stubEnv('SDLC_TOKEN', '');
    const dir = tmpDir('sdlc-config-put-');
    const configPath = path.join(dir, 'config.yaml');
    const runner = () => new FakeRunner(() => ({ act: () => ({}) }));
    const app = createApp({ config: testApp(dir, runner()).config, runner: runner(), dbFile: ':memory:', configPath });
    const hono = createHttpApp(app);   // generates and persists the access token
    const token = app.config.server.token!;
    const body = { default_pipeline: 'standard', max_parallel_tasks: 10, max_loops: 15, recheck_scope: 'delta', pr_feedback_from: 'collaborators', pr_sync_interval: 'off', task_budget_usd: 100, limits: { phases: 'off' }, merge_method: 'merge', cleanup: 'never', models: { phases: {} } };
    const res = await hono.request('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const saved = read(configPath);
    expect(saved.limits).toBeUndefined();
    expect(saved.max_loops).toBeUndefined();
    expect(saved.task_budget_usd).toBeUndefined();
    expect(saved.config_version).toBe(CONFIG_VERSION);
    expect(saved.server.token).toBe(token);
    expect(saved.pipelines_dirs).toBeUndefined();   // sdlc's own pipelines/ never lands in the file
  });
});
