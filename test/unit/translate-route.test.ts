import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { testApp, tmpDir } from '../helpers.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { clearTranslationCache, translateRoutes } from '../../server/src/http/routes/translate.js';

/** Reading-only translation of checkpoint texts: never the real Claude, never the database. */
describe('POST /translate', () => {
  beforeEach(() => clearTranslationCache());

  const mount = (brief?: (prompt: string) => Promise<string>) => {
    const app = testApp(tmpDir('sdlc-translate-'), new FakeRunner(() => ({ act: () => ({}) })));
    if (brief) (app.runner as FakeRunner).brief = brief;
    // the real app maps HttpError via hono.onError; mirror just that much here
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    return hono.route('/api', translateRoutes(app));
  };
  const post = (hono: Hono, body: unknown) => hono.request('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('returns one translation per input, in order', async () => {
    const prompts: string[] = [];
    const hono = mount(async (p) => { prompts.push(p); return '["перевод 1","перевод 2"]'; });
    const res = await post(hono, { texts: ['first', 'second'], lang: 'ru' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ texts: ['перевод 1', 'перевод 2'] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Russian');
    expect(prompts[0]).toContain('["first","second"]');
  });

  it('keeps empty strings and asks the model only for the rest', async () => {
    const hono = mount(async () => '["перевод"]');
    const res = await post(hono, { texts: ['', 'first', '  '], lang: 'ru' });
    expect(await res.json()).toEqual({ texts: ['', 'перевод', '  '] });
  });

  it('answers a repeat checkpoint from the cache, but not another language', async () => {
    let calls = 0;
    const hono = mount(async () => { calls++; return '["перевод"]'; });
    expect(await (await post(hono, { texts: ['first'], lang: 'ru' })).json()).toEqual({ texts: ['перевод'] });
    expect(await (await post(hono, { texts: ['first'], lang: 'ru' })).json()).toEqual({ texts: ['перевод'] });
    expect(calls).toBe(1);
    await post(hono, { texts: ['first'], lang: 'uk' });
    expect(calls).toBe(2);
  });

  it('503 when the server has no cheap model runner', async () => {
    const res = await post(mount(), { texts: ['first'], lang: 'ru' });
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/translation is not available/);
  });

  it('502 when the model answers with the wrong shape', async () => {
    for (const bad of ['["only one"]', 'sorry, I cannot', '{"texts":["a","b"]}']) {
      const res = await post(mount(async () => bad), { texts: ['first', 'second'], lang: 'ru' });
      expect(res.status, bad).toBe(502);
    }
  });

  it('accepts a fenced JSON array', async () => {
    const hono = mount(async () => '```json\n["перевод 1","перевод 2"]\n```');
    expect(await (await post(hono, { texts: ['first', 'second'], lang: 'ru' })).json()).toEqual({ texts: ['перевод 1', 'перевод 2'] });
  });

  it('rejects an unknown language and unknown fields without calling the model', async () => {
    let calls = 0;
    const hono = mount(async () => { calls++; return '["x"]'; });
    expect((await post(hono, { texts: ['first'], lang: 'de' })).ok).toBe(false);
    expect((await post(hono, { texts: ['first'], lang: 'ru', save: true })).ok).toBe(false);
    expect(calls).toBe(0);
  });
});
