import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig, saveConfig } from '../../server/src/config/config.js';
import { tmpDir } from '../helpers.js';

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
    expect(saved.server.token).toBeUndefined();
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
});
