import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { FakeRunner } from '../fakes/fake-runner.js';
import { testApp, tmpDir } from '../helpers.js';
import { HttpError } from '../../server/src/engine/engine.js';
import { clearTranslationCache, translateRoutes } from '../../server/src/http/routes/translate.js';

/** Reading-only translation of checkpoint texts: one call per checkpoint, never the real Claude, never the database. */
describe('POST /translate', () => {
  beforeEach(() => clearTranslationCache());

  const mount = (brief?: (prompt: string, opts?: { model?: string; timeoutMs?: number }) => Promise<string>) => {
    const app = testApp(tmpDir('sdlc-translate-'), new FakeRunner(() => ({ act: () => ({}) })));
    if (brief) (app.runner as FakeRunner).brief = brief;
    // the real app maps HttpError via hono.onError; mirror just that much here
    const hono = new Hono();
    hono.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 500));
    return hono.route('/api', translateRoutes(app));
  };
  const post = (hono: Hono, body: unknown) => hono.request('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** The JSON array the prompt handed to the model. */
  const asked = (p: string) => JSON.parse(p.slice(p.indexOf('\n["') + 1)) as string[];
  /** Echo translator: answers with "ru:<text>" for every element of the array it was given. */
  const echo = (seen: string[][]) => async (p: string) => { const a = asked(p); seen.push(a); return JSON.stringify(a.map((x) => `ru:${x}`)); };

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

  /** The point of the single pass: a whole checkpoint is one call, however many texts and however long they are. */
  it('sends the whole checkpoint in one call and lays the answer out over every text', async () => {
    const seen: string[][] = [];
    const texts = [
      ...Array.from({ length: 40 }, (_, i) => `finding ${i}: ${'prose '.repeat(20)}`),
      ['# Plan', '## Summary', 'x'.repeat(3000), 'tail'].join('\n\n'),
      '',
      ...Array.from({ length: 40 }, (_, i) => `note ${i}`),
    ];
    const res = await post(mount(echo(seen)), { texts, lang: 'ru' });
    expect(res.status).toBe(200);
    const got = (await res.json() as { texts: string[] }).texts;
    expect(seen).toHaveLength(1);                                   // one call
    expect(seen[0]).toHaveLength(texts.length - 1);                 // every text but the blank one
    expect(got).toHaveLength(texts.length);
    expect(got[40]).toBe(`ru:${texts[40]!}`);                       // the long plan came back whole, not in pieces
    expect(got[41]).toBe('');
    expect(got.filter((_, i) => i !== 41)).toEqual(texts.filter((_, i) => i !== 41).map((x) => `ru:${x}`));
  });

  /** The default cheap call is haiku on a 20s leash: it cannot hold a checkpoint, so translation asks for more. */
  it('asks for a model that holds the whole checkpoint, and for far longer than a branch slug gets', async () => {
    let opts: { model?: string; timeoutMs?: number } | undefined;
    const hono = mount(async (p, o) => { opts = o; return JSON.stringify(asked(p).map((x) => `ru:${x}`)); });
    expect((await post(hono, { texts: ['first'], lang: 'ru' })).status).toBe(200);
    expect(opts?.model).toBeTruthy();
    expect(opts?.model).not.toBe('haiku');
    expect(opts?.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  /** Quality drops near the end of a long answer: some fragments come back in English. They must stay askable. */
  it('does not cache a fragment the model handed back unchanged', async () => {
    const seen: string[][] = [];
    let n = 0;
    const hono = mount(async (p) => {
      const a = asked(p);
      seen.push(a);
      // first answer leaves the second text in English, the next one translates it
      return ++n === 1 ? JSON.stringify([`ru:${a[0]!}`, a[1]!]) : JSON.stringify(a.map((x) => `ru:${x}`));
    });
    const texts = ['the review found a race', 'await the handle'];
    expect(await (await post(hono, { texts, lang: 'ru' })).json()).toEqual({ texts: ['ru:the review found a race', 'await the handle'] });
    // the translated one is cached, the untouched one is asked again and heals
    expect(await (await post(hono, { texts, lang: 'ru' })).json()).toEqual({ texts: ['ru:the review found a race', 'ru:await the handle'] });
    expect(seen).toEqual([texts, ['await the handle']]);
  });

  it('keeps empty strings and asks the model only for the rest', async () => {
    const hono = mount(async () => '["перевод"]');
    const res = await post(hono, { texts: ['', 'first', '  '], lang: 'ru' });
    expect(await res.json()).toEqual({ texts: ['', 'перевод', '  '] });
  });

  it('translates a repeated text once and fills every slot it appears in', async () => {
    const seen: string[][] = [];
    const res = await post(mount(echo(seen)), { texts: ['a', 'b', 'a'], lang: 'ru' });
    expect(await res.json()).toEqual({ texts: ['ru:a', 'ru:b', 'ru:a'] });
    expect(seen).toEqual([['a', 'b']]);
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

  it('never answers a non-empty text with an empty one', async () => {
    let n = 0;
    const hono = mount(async (p) => {
      // the model keeps the count but drops the content of one element
      return ++n === 1 ? JSON.stringify(['перевод', '']) : JSON.stringify(asked(p).map((x) => `ru:${x}`));
    });
    const body = { texts: ['the review found a race', 'await the handle'], lang: 'ru' };
    expect((await post(hono, body)).status).toBe(502);
    // and pressing Translate again recovers: a blank was not cached as a translation
    expect((await (await post(hono, body)).json() as { texts: string[] }).texts[1]).not.toBe('');
  });

  /** brief() throws on an abort ('Claude Code process aborted by user'); that text must not end up in a toast. */
  it('reports a failed or aborted call as a translation problem, not as an internal Claude message', async () => {
    const res = await post(mount(async () => { throw new Error('Claude Code process aborted by user'); }), { texts: ['first'], lang: 'ru' });
    expect(res.status).toBe(502);
    const { error } = await res.json() as { error: string };
    expect(error).not.toContain('Claude Code');
    expect(error).toMatch(/original text is still available/);
  });

  /** An aborted call can also answer '' rather than throwing: the toast should not blame the shape of the answer. */
  it('distinguishes an answer that never came from a malformed one, and names the bad field', async () => {
    const empty = await post(mount(async () => ''), { texts: ['first'], lang: 'ru' });
    expect(empty.status).toBe(502);
    expect((await empty.json() as { error: string }).error).toMatch(/returned nothing/);
    const bad = await post(mount(), { texts: ['first'], lang: 'de' });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toMatch(/^bad translate request: lang/);
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

  it('refuses a checkpoint too large for one answer instead of trying', async () => {
    let calls = 0;
    const hono = mount(async () => { calls++; return '[]'; });
    const huge = Array.from({ length: 700 }, (_, i) => `paragraph ${i} ${'x'.repeat(100)}`).join('\n\n');   // ~80 KB
    const res = await post(hono, { texts: [huge], lang: 'ru' });
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toMatch(/too large to translate/);
    expect(calls).toBe(0);
  });

  /** Whatever the text is made of, the answer is handed back as the model gave it: no separator is lost or doubled. */
  it('passes every shape of text through unchanged', async () => {
    const cases: Record<string, string> = {
      'blank lines': ['# Plan', '## Summary', 'x'.repeat(900), '- a '.repeat(200), '```ts\n' + 'const a = 1;\n'.repeat(120) + '```', 'tail'].join('\n\n'),
      'single newlines only': Array.from({ length: 200 }, (_, i) => `- line ${i} ${'y'.repeat(20)}`).join('\n'),
      'spaces only': Array.from({ length: 500 }, (_, i) => `word${i}`).join(' '),
      'crlf': Array.from({ length: 80 }, (_, i) => `line ${i} ${'c'.repeat(30)}`).join('\r\n'),
      'runs of blank space between long blocks': '\n\n' + 'q'.repeat(900) + '\n\n   \n\n' + 'w'.repeat(900) + '\n\n',
    };
    for (const [name, text] of Object.entries(cases)) {
      clearTranslationCache();
      const seen: string[][] = [];
      // identity "translation": whatever comes back must be the original, separators and all
      const hono = mount(async (p) => { const a = asked(p); seen.push(a); return JSON.stringify(a); });
      const res = await post(hono, { texts: [text], lang: 'ru' });
      expect(res.status, name).toBe(200);
      const got = (await res.json() as { texts: string[] }).texts;
      expect(got, name).toEqual([text]);
      expect(seen, name).toEqual([[text]]);              // one text, one element, one call
    }
  });
});
