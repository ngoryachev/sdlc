import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import type { App } from '../../server/src/app.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { reposRoutes } from '../../server/src/http/routes/repos.js';
import { configRoutes } from '../../server/src/http/routes/config.js';
import { ConfigSchema, loadConfig, saveConfig } from '../../server/src/config/config.js';
import { MAX_REPO_FILE_BYTES, repoFilesDir } from '../../server/src/config/repo-files.js';

interface Meta { env: string; filename: string; size: number | null; mtime: string | null; missing: boolean }

const SECRET = 'service-account-key\n';
const REPO = 'owner/name';

function setup(prefix: string) {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  const filesDir = path.join(dir, 'files');
  const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ text: 'ok' }) })), { files_dir: filesDir, repos: [{ name: REPO, path: repo }] });
  const hono = new Hono();
  hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
  hono.route('/api', reposRoutes(app)).route('/api', configRoutes(app));
  // one directory per repository, not per sanitised name: see repoFilesDir
  return { dir, repo, filesDir, repoDir: repoFilesDir(app.config, REPO), app: app as App, hono };
}

const id = encodeURIComponent(REPO);
const upload = (hono: Hono, env: string, filename: string, body: string | Uint8Array) => {
  const fd = new FormData();
  fd.set('env', env);
  fd.set('file', new File([body], filename));
  return hono.request(`/api/repos/${id}/files`, { method: 'POST', body: fd });
};
const list = async (hono: Hono): Promise<Meta[]> => (await (await hono.request(`/api/repos/${id}/files`)).json() as { files: Meta[] }).files;

describe('per-repository files', () => {
  it('stores an uploaded file privately, records its env variable and reports only metadata', async () => {
    const { app, repoDir, hono } = setup('sdlc-repo-files-');
    const res = await upload(hono, 'GOOGLE_APPLICATION_CREDENTIALS', 'key.json', SECRET);
    expect(res.status).toBe(201);

    const entry = app.config.repos[0]!.files[0]!;
    expect(entry.env).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    expect(entry.path).toBe(path.join(repoDir, 'key.json'));
    expect(fs.readFileSync(entry.path, 'utf8')).toBe(SECRET);
    expect(fs.statSync(entry.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(entry.path)).mode & 0o777).toBe(0o700);

    const files = await list(hono);
    expect(files).toEqual([{ env: 'GOOGLE_APPLICATION_CREDENTIALS', filename: 'key.json', size: SECRET.length, mtime: expect.any(String), missing: false }]);

    // the contents never travel back, through this route or the config view
    const bodies = [JSON.stringify(files), await (await hono.request(`/api/repos/${id}/files`)).text(), await (await hono.request('/api/config')).text()];
    for (const b of bodies) expect(b).not.toContain('service-account-key');
    const cfgView = await (await hono.request('/api/config')).json() as { repos: { files: Meta[] }[] };
    expect(cfgView.repos[0]!.files).toEqual(files);
  });

  it('replaces the file bound to an env variable and leaves no old copy behind', async () => {
    const { app, repoDir, hono } = setup('sdlc-repo-files-replace-');
    await upload(hono, 'KEYSTORE', 'old.jks', 'old');
    const res = await upload(hono, 'KEYSTORE', 'new.jks', 'new');
    expect(res.status).toBe(201);

    expect(app.config.repos[0]!.files).toHaveLength(1);
    const entry = app.config.repos[0]!.files[0]!;
    expect(path.basename(entry.path)).toBe('new.jks');
    expect(fs.readFileSync(entry.path, 'utf8')).toBe('new');
    expect(fs.readdirSync(repoDir)).toEqual(['new.jks']);
  });

  it('deletes the config entry together with the file on disk', async () => {
    const { app, hono } = setup('sdlc-repo-files-delete-');
    await upload(hono, 'KEYSTORE', 'key.jks', 'x');
    const stored = app.config.repos[0]!.files[0]!.path;

    const res = await hono.request(`/api/repos/${id}/files/KEYSTORE`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [] });
    expect(app.config.repos[0]!.files).toEqual([]);
    expect(fs.existsSync(stored)).toBe(false);
    expect((await hono.request(`/api/repos/${id}/files/KEYSTORE`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses an env name a phase could never see, and writes nothing in the process', async () => {
    const { app, filesDir, hono } = setup('sdlc-repo-files-names-');
    for (const bad of ['SDLC_SECRET', '1BAD', 'a-b', '', '  ', 'PATH', 'HOME', 'NODE_OPTIONS']) {
      const res = await upload(hono, bad, 'key.json', SECRET);
      expect(res.status, bad).toBe(400);
    }
    expect((await (await upload(hono, 'SDLC_SECRET', 'k', 'x')).json() as { error: string }).error).toMatch(/SDLC_/);
    expect((await (await upload(hono, 'PATH', 'k', 'x')).json() as { error: string }).error).toMatch(/needs this variable/);
    expect(app.config.repos[0]!.files).toEqual([]);
    expect(fs.existsSync(filesDir)).toBe(false);
  });

  it('refuses a file over the 10 MB limit', async () => {
    const { app, hono } = setup('sdlc-repo-files-size-');
    const res = await upload(hono, 'BIG', 'big.bin', new Uint8Array(MAX_REPO_FILE_BYTES + 1));
    expect(MAX_REPO_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(res.status).toBe(413);
    expect(app.config.repos[0]!.files).toEqual([]);
    expect((await upload(hono, 'FITS', 'fits.bin', new Uint8Array(1024))).status).toBe(201);
  });

  it('keeps a slug-shaped repository name and a traversing filename inside one component of files_dir', async () => {
    const { app, filesDir, repoDir, hono } = setup('sdlc-repo-files-safe-');
    expect((await upload(hono, 'SNEAKY', '../../x', 'x')).status).toBe(201);
    const stored = app.config.repos[0]!.files[0]!.path;
    expect(path.dirname(stored)).toBe(repoDir);
    expect(path.dirname(repoDir)).toBe(filesDir);
    expect(path.basename(stored)).not.toContain('..');
    expect(path.relative(filesDir, stored).split(path.sep)).toHaveLength(2);
  });

  it('never lets two env variables share one stored file, however the uploads are named', async () => {
    const { app, repoDir, hono } = setup('sdlc-repo-files-collide-');
    expect((await upload(hono, 'DEV_ENV', '.env', 'dev')).status).toBe(201);
    expect((await upload(hono, 'PROD_ENV', '.env', 'prod')).status).toBe(201);

    const [dev, prod] = app.config.repos[0]!.files;
    expect(dev!.path).not.toBe(prod!.path);
    expect(fs.readFileSync(dev!.path, 'utf8')).toBe('dev');
    expect(fs.readFileSync(prod!.path, 'utf8')).toBe('prod');
    expect(fs.readdirSync(repoDir)).toHaveLength(2);

    // and deleting one leaves the other's file alone
    expect((await hono.request(`/api/repos/${id}/files/PROD_ENV`, { method: 'DELETE' })).status).toBe(200);
    expect(fs.readFileSync(dev!.path, 'utf8')).toBe('dev');
  });

  it('keeps the disambiguated name apart too, for env names that sanitise to one another', async () => {
    const { app, repoDir, hono } = setup('sdlc-repo-files-collide2-');
    // `_X` and `X` sanitise to the same thing, so naming the fallback after the env name would collapse them
    for (const [env, body] of [['A', 'first'], ['_X', 'second'], ['X', 'third']]) {
      expect((await upload(hono, env!, 'key', body!)).status, env).toBe(201);
    }
    const files = app.config.repos[0]!.files;
    expect(new Set(files.map((f) => f.path)).size).toBe(3);
    expect(files.map((f) => fs.readFileSync(f.path, 'utf8'))).toEqual(['first', 'second', 'third']);
    expect(fs.readdirSync(repoDir)).toHaveLength(3);

    // and deleting the last one leaves the other two on disk
    expect((await hono.request(`/api/repos/${id}/files/X`, { method: 'DELETE' })).status).toBe(200);
    expect((await list(hono)).map((f) => f.missing)).toEqual([false, false]);
  });

  it('reports a file that is gone from disk as missing instead of pretending it is there', async () => {
    const { app, hono } = setup('sdlc-repo-files-missing-');
    await upload(hono, 'KEYSTORE', 'key.jks', 'x');
    fs.rmSync(app.config.repos[0]!.files[0]!.path);
    expect(await list(hono)).toEqual([{ env: 'KEYSTORE', filename: 'key.jks', size: null, mtime: null, missing: true }]);
  });
});

describe('repos[].files in config.yaml', () => {
  it('survives a save/load round trip and is optional in an older file', () => {
    const dir = tmpDir('sdlc-repo-files-config-');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, YAML.stringify({ data_dir: path.join(dir, 'data'), repos: [{ name: 'shop', path: '/srv/shop' }] }));
    const old = loadConfig(configPath);
    expect(old.repos[0]!.files).toEqual([]);   // a file written before this feature keeps loading
    saveConfig(old, configPath);
    expect(YAML.parse(fs.readFileSync(configPath, 'utf8')).repos).toEqual([{ name: 'shop', path: '/srv/shop' }]);   // and stays as it was

    old.repos[0]!.files.push({ env: 'KEYSTORE', path: '/srv/files/shop/key.jks' });
    saveConfig(old, configPath);
    expect(YAML.parse(fs.readFileSync(configPath, 'utf8')).repos).toEqual([{ name: 'shop', path: '/srv/shop', files: [{ env: 'KEYSTORE', path: '/srv/files/shop/key.jks' }] }]);
    expect(loadConfig(configPath).repos[0]!.files).toEqual([{ env: 'KEYSTORE', path: '/srv/files/shop/key.jks' }]);
  });

  it('rejects a hand-written entry a phase could never use', () => {
    const entry = (files: unknown) => () => ConfigSchema.parse({ repos: [{ name: 'shop', path: '/srv/shop', files }] });
    expect(entry([{ env: 'SDLC_X', path: '/a' }])).toThrow(/SDLC_/);
    expect(entry([{ env: 'PATH', path: '/a' }])).toThrow(/needs this variable/);
    expect(entry([{ env: 'a-b', path: '/a' }])).toThrow(/not a valid environment variable name/);
    expect(entry([{ env: 'A', path: 'relative/key' }])).toThrow(/absolute/);
    expect(entry([{ env: 'A', path: '/a' }, { env: 'A', path: '/b' }])).toThrow(/configured twice/);
    expect(entry([{ env: 'A', path: '/a' }, { env: 'B', path: '/b' }])).not.toThrow();
  });
});
