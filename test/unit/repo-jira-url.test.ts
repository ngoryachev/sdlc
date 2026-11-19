import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { FakeGitHub } from '../fakes/fake-github.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { createApp } from '../../server/src/app.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { reposRoutes } from '../../server/src/http/routes/repos.js';
import { configRoutes } from '../../server/src/http/routes/config.js';

const runner = () => new FakeRunner(() => ({ act: () => ({ text: 'ok' }) }));

/** A field missing from the route's zod schema is dropped without a word, so the route is what has to be tested. */
describe('PUT /repos/:name — jira_url', () => {
  const setup = (o: { configPath?: string } = {}) => {
    const dir = tmpDir('sdlc-repo-jira-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const base = testApp(dir, runner(), { repos: [{ name: 'shop', path: repo, gh_user: 'tester' }] }, new FakeGitHub(repo));
    const app = o.configPath
      ? createApp({ config: base.config, runner: runner(), dbFile: ':memory:', github: new FakeGitHub(repo), configPath: o.configPath })
      : base;
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    hono.route('/api', reposRoutes(app)).route('/api', configRoutes(app));
    return { app, hono, entry: () => app.config.repos[0]! };
  };

  it('stores a jira_url sent on its own and gives it back', async () => {
    const { hono, entry } = setup();
    const res = await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: ' https://x.atlassian.net/ ' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'shop', ghUser: 'tester', jiraUrl: 'https://x.atlassian.net/' });
    expect(entry().jira_url).toBe('https://x.atlassian.net/');   // trimmed; the trailing slash is normalised where the link is composed
    expect(entry().gh_user).toBe('tester');                      // a body without gh_user leaves the account alone
  });

  it('clears it with null, and with an empty string', async () => {
    const { hono, entry } = setup();
    for (const value of [null, '  ']) {
      await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: 'https://x.atlassian.net' }) });
      expect(entry().jira_url).toBe('https://x.atlassian.net');
      const res = await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: value }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ jiraUrl: null });
      expect('jira_url' in entry()).toBe(false);
    }
  });

  it('refuses a value that is not an http(s) URL, and keeps what was there', async () => {
    const { hono, entry } = setup();
    await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: 'https://x.atlassian.net' }) });
    const res = await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: 'company.atlassian.net' }) });
    expect(res.status).toBe(400);
    expect(entry().jira_url).toBe('https://x.atlassian.net');
  });

  it('exposes it through GET /config, next to the GitHub account', async () => {
    const { hono } = setup();
    await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: 'https://x.atlassian.net' }) });
    const cfg = await (await hono.request('/api/config')).json() as { repos: { name: string; ghUser: string | null; jiraUrl: string | null }[] };
    expect(cfg.repos).toHaveLength(1);
    expect(cfg.repos[0]).toMatchObject({ name: 'shop', ghUser: 'tester', jiraUrl: 'https://x.atlassian.net' });
  });

  it('survives the save that prunes the defaults out of config.yaml', async () => {
    const dir = tmpDir('sdlc-repo-jira-file-');
    const configPath = path.join(dir, 'config.yaml');
    const { hono } = setup({ configPath });
    await hono.request('/api/repos/shop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jira_url: 'https://x.atlassian.net' }) });
    const saved = YAML.parse(fs.readFileSync(configPath, 'utf8')) as { repos: { jira_url?: string }[] };
    expect(saved.repos[0]!.jira_url).toBe('https://x.atlassian.net');
  });
});
