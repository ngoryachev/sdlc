import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

/** A generated token is persisted only where the app persists its config: an injected config must never overwrite <SDLC_HOME>/config.yaml. */
describe('ensureToken', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  // CONFIG_PATH is read at module load: point SDLC_HOME at a temp dir first, so even a regression writes nowhere real
  const load = async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-token-home-'));
    vi.stubEnv('SDLC_HOME', home); vi.resetModules();
    const { createHttpApp } = await import('../../server/src/http/app.js');
    const { createApp } = await import('../../server/src/app.js');
    const { testApp } = await import('../helpers.js');
    const { FakeRunner } = await import('../fakes/fake-runner.js');
    return { home, createHttpApp, createApp, testApp, runner: () => new FakeRunner(() => ({ act: () => ({}) })) };
  };

  it('keeps an injected config without configPath in memory only', async () => {
    const { home, createHttpApp, testApp, runner } = await load();
    const app = testApp(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-token-')), runner());
    createHttpApp(app);
    expect(app.config.server.token).toBeTruthy();
    expect(fs.existsSync(path.join(home, 'config.yaml'))).toBe(false);
  });

  it('writes the token to the app config path when there is one', async () => {
    const { home, createHttpApp, createApp, testApp, runner } = await load();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-token-'));
    const configPath = path.join(dir, 'config.yaml');
    const app = createApp({ config: testApp(dir, runner()).config, runner: runner(), dbFile: ':memory:', configPath });
    createHttpApp(app);
    expect(fs.readFileSync(configPath, 'utf8')).toContain(app.config.server.token!);
    expect(fs.existsSync(path.join(home, 'config.yaml'))).toBe(false);
  });
});
