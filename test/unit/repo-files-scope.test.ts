import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { reposRoutes } from '../../server/src/http/routes/repos.js';

const runner = () => new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));

/** The three executions the developer asked for are Claude phases, shell phases and `setup_command`. */
describe('setup_command and the repository files', () => {
  it('runs with the variable set to the stored file', async () => {
    const dir = tmpDir('sdlc-file-env-setup-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n', '.gitignore': 'setup-env.txt\n' }, 'setup_command: printf %s "$KEYSTORE" > setup-env.txt\n');
    const stored = path.join(dir, 'key.jks');
    fs.writeFileSync(stored, 'keystore bytes\n');

    const app = testApp(dir, runner(), { repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: stored }] }] });
    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, startAt: 'end' });
    expect(fs.readFileSync(path.join(task.worktreePath, 'setup-env.txt'), 'utf8')).toBe(stored);
  });

  it('still runs when the file is gone, and the task is warned about it once', async () => {
    const dir = tmpDir('sdlc-file-env-setup-missing-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n', '.gitignore': 'setup-env.txt\n' }, 'setup_command: printf "[%s]" "$KEYSTORE" > setup-env.txt\n');
    const gone = path.join(dir, 'never-written.jks');

    const app = testApp(dir, runner(), { repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: gone }] }] });
    const warnings: string[] = [];
    app.events.on((e) => { if (e.type === 'engine.warning') warnings.push((e.payload as { message: string }).message); });

    const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'auto', baseRemote: null, startAt: 'end' });
    expect(fs.readFileSync(path.join(task.worktreePath, 'setup-env.txt'), 'utf8')).toBe('[]');   // unset, not the literal path
    expect(warnings).toEqual([`file for $KEYSTORE is missing at ${gone}; the variable is not set`]);
    expect(app.store.getTask(task.id)!.status).not.toBe('failed');
  });
});

describe('deleting a repository file', () => {
  it('forgets a hand-written entry outside the managed directory without touching the file', async () => {
    const dir = tmpDir('sdlc-repo-files-outside-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const outside = path.join(dir, 'my-own-keystore.jks');
    fs.writeFileSync(outside, 'not sdlc managed\n');
    const app = testApp(dir, runner(), { files_dir: path.join(dir, 'files'), repos: [{ name: 'shop', path: repo, files: [{ env: 'KEYSTORE', path: outside }] }] });
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    hono.route('/api', reposRoutes(app));

    expect((await hono.request('/api/repos/shop/files/KEYSTORE', { method: 'DELETE' })).status).toBe(200);
    expect(app.config.repos[0]!.files).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

/** Two registered repositories must never be given the same file on disk: one would read (or delete) the other's secret. */
describe('two repository names that sanitise to the same directory', () => {
  it('keeps their uploads apart', async () => {
    const dir = tmpDir('sdlc-repo-files-two-');
    const a = makeRepo(path.join(dir, 'a'), { 'a.txt': 'x\n' });
    const b = makeRepo(path.join(dir, 'b'), { 'a.txt': 'x\n' });
    const filesDir = path.join(dir, 'files');
    const app = testApp(dir, runner(), { files_dir: filesDir, repos: [{ name: 'owner/name', path: a }, { name: 'owner_name', path: b }] });
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    hono.route('/api', reposRoutes(app));
    const upload = (repoName: string, body: string) => {
      const fd = new FormData();
      fd.set('env', 'KEYSTORE');
      fd.set('file', new File([body], 'key.jks'));
      return hono.request(`/api/repos/${encodeURIComponent(repoName)}/files`, { method: 'POST', body: fd });
    };

    expect((await upload('owner/name', 'secret of A')).status).toBe(201);
    expect((await upload('owner_name', 'secret of B')).status).toBe(201);

    const [pathA, pathB] = [app.config.repos[0]!.files[0]!.path, app.config.repos[1]!.files[0]!.path];
    // the uploads must not share one file on disk: $KEYSTORE of repository A still has to be A's own keystore
    expect(fs.readFileSync(pathA, 'utf8')).toBe('secret of A');
    expect(fs.readFileSync(pathB, 'utf8')).toBe('secret of B');
    expect(pathA).not.toBe(pathB);

    // and deleting one repository's file leaves the other's alone
    expect((await hono.request(`/api/repos/${encodeURIComponent('owner_name')}/files/KEYSTORE`, { method: 'DELETE' })).status).toBe(200);
    expect(fs.existsSync(pathA)).toBe(true);
  });
});
