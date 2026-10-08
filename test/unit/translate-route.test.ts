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

  /** Echo translator: answers with "ru:<text>" for every element of the array it was handed. */
  const echo = (seen: string[][]) => async (p: string) => {
    const asked = JSON.parse(p.slice(p.indexOf('\n["') + 1)) as string[];
    seen.push(asked);
    return JSON.stringify(asked.map((x) => `ru:${x}`));
  };

  it('splits a long checkpoint into batches and keeps the input order', async () => {
    const seen: string[][] = [];
    const texts = Array.from({ length: 25 }, (_, i) => `finding ${i}`);
    const res = await post(mount(echo(seen)), { texts, lang: 'ru' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ texts: texts.map((x) => `ru:${x}`) });
    expect(seen.map((b) => b.length)).toEqual([20, 5]);   // 20 items per call
  });

  it('splits by characters too: one long plan per call', async () => {
    const seen: string[][] = [];
    const texts = ['a'.repeat(3000), 'b'.repeat(3000)];
    const res = await post(mount(echo(seen)), { texts, lang: 'ru' });
    expect((await res.json() as { texts: string[] }).texts).toEqual(texts.map((x) => `ru:${x}`));
    expect(seen.map((b) => b.length)).toEqual([1, 1]);
  });

  it('translates a repeated text once and fills every slot it appears in', async () => {
    const seen: string[][] = [];
    const res = await post(mount(echo(seen)), { texts: ['a', 'b', 'a'], lang: 'ru' });
    expect(await res.json()).toEqual({ texts: ['ru:a', 'ru:b', 'ru:a'] });
    expect(seen).toEqual([['a', 'b']]);
  });

  it('asks only for what the cache is missing, and still answers in input order', async () => {
    const seen: string[][] = [];
    const hono = mount(echo(seen));
    await post(hono, { texts: ['a'], lang: 'ru' });
    expect(await (await post(hono, { texts: ['b', 'a', 'c'], lang: 'ru' })).json()).toEqual({ texts: ['ru:b', 'ru:a', 'ru:c'] });
    expect(seen).toEqual([['a'], ['b', 'c']]);
  });

  it('an empty list costs no call, even without a cheap runner', async () => {
    const res = await post(mount(), { texts: [], lang: 'ru' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ texts: [] });
  });

  it('a batch that failed is retried, the batch that succeeded is not', async () => {
    let n = 0;
    const hono = mount(async (p) => {
      const asked = JSON.parse(p.slice(p.indexOf('\n["') + 1)) as string[];
      return ++n === 2 ? 'sorry' : JSON.stringify(asked.map((x) => `ru:${x}`));
    });
    const texts = Array.from({ length: 25 }, (_, i) => `finding ${i}`);
    expect((await post(hono, { texts, lang: 'ru' })).status).toBe(502);
    expect(n).toBe(2);
    expect(await (await post(hono, { texts, lang: 'ru' })).json()).toEqual({ texts: texts.map((x) => `ru:${x}`) });
    expect(n).toBe(3);   // only the tail of 5 is asked again
  });

  /** An aborted brief() answers '' rather than throwing: the toast should not blame the shape of the answer. */
  it('distinguishes an answer that never came from a malformed one, and names the bad field', async () => {
    const empty = await post(mount(async () => ''), { texts: ['first'], lang: 'ru' });
    expect(empty.status).toBe(502);
    expect((await empty.json() as { error: string }).error).toMatch(/returned nothing/);
    const bad = await post(mount(), { texts: ['first'], lang: 'de' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toMatch(/^bad translate request: lang/);
  });

  it('never answers a non-empty text with an empty one', async () => {
    let n = 0;
    const hono = mount(async (p) => {
      const asked = JSON.parse(p.slice(p.indexOf('\n["') + 1)) as string[];
      // the model keeps the count but drops the content of one element
      return ++n === 1 ? JSON.stringify(['перевод', '']) : JSON.stringify(asked.map((x) => `ru:${x}`));
    });
    const body = { texts: ['the review found a race', 'await the handle'], lang: 'ru' };
    const first = await post(hono, body);
    if (first.status === 200) expect((await first.json() as { texts: string[] }).texts[1]).not.toBe('');
    else expect(first.status).toBe(502);
    // and pressing Translate again must be able to recover: a blank is not a translation worth caching
    expect((await (await post(hono, body)).json() as { texts: string[] }).texts[1]).not.toBe('');
  });
});
