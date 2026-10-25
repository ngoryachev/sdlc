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
  /** Lets the pending requests run on: a few turns of the event loop, each one draining everything they queued. */
  const settle = async (turns = 5) => { for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0)); };
  /** The same, but only until the condition holds. */
  const waitFor = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await settle(1); expect(ok()).toBe(true); };
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

  /**
   * The UI does not abort a running translation when the human leaves the checkpoint with j/k, so pressing Translate
   * again lands on the server while the first call is still out: the second request waits for it, it does not pay.
   */
  it('two requests for the same texts while the first call runs share one model call', async () => {
    const seen: string[][] = [];
    let release!: (answer: string) => void;
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res) => { release = res; }); });
    const texts = ['first', 'second'];
    const first = post(hono, { texts, lang: 'ru' });
    await waitFor(() => seen.length > 0);                            // the call is out and nothing is cached yet
    const second = post(hono, { texts, lang: 'ru' });
    await settle();
    expect(seen).toEqual([texts]);                                   // the second press waited instead of asking again
    release(JSON.stringify(seen[0]!.map((x) => `ru:${x}`)));
    for (const res of [await first, await second]) expect(await res.json()).toEqual({ texts: ['ru:first', 'ru:second'] });
    expect(seen).toEqual([texts]);                                   // one call, both answered from it
  });

  it('asks only for the fragments nobody is translating yet', async () => {
    const seen: string[][] = [];
    const release: ((answer: string) => void)[] = [];
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res) => { release.push(res); }); });
    const first = post(hono, { texts: ['a', 'b'], lang: 'ru' });
    await waitFor(() => seen.length > 0);
    const second = post(hono, { texts: ['b', 'c'], lang: 'ru' });     // 'b' is already out with the first call
    await waitFor(() => seen.length > 1);
    expect(seen).toEqual([['a', 'b'], ['c']]);
    release.forEach((r, i) => r(JSON.stringify(seen[i]!.map((x) => `ru:${x}`))));
    expect(await (await first).json()).toEqual({ texts: ['ru:a', 'ru:b'] });
    expect(await (await second).json()).toEqual({ texts: ['ru:b', 'ru:c'] });
  });

  /** A shared call that fails must fail everyone waiting on it and leave nothing behind: the next press asks again. */
  it('fails every request waiting on a failed call and keeps asking afterwards', async () => {
    const seen: string[][] = [];
    let fail!: (e: Error) => void;
    let n = 0;
    const hono = mount(async (p) => {
      seen.push(asked(p));
      if (++n > 1) return JSON.stringify(asked(p).map((x) => `ru:${x}`));
      return new Promise<string>((_, rej) => { fail = rej; });
    });
    const texts = ['first', 'second'];
    const first = post(hono, { texts, lang: 'ru' });
    await waitFor(() => seen.length > 0);
    const second = post(hono, { texts, lang: 'ru' });
    await settle();
    expect(seen).toEqual([texts]);                                   // both are now riding on the same call
    fail(new Error('Claude Code process aborted by user'));
    for (const res of [await first, await second]) {
      expect(res.status).toBe(502);
      expect((await res.json() as { error: string }).error).toMatch(/original text is still available/);
    }
    // nothing was poisoned: the fragments are neither cached nor still marked as in flight
    expect(await (await post(hono, { texts, lang: 'ru' })).json()).toEqual({ texts: ['ru:first', 'ru:second'] });
    expect(seen).toEqual([texts, texts]);
  });

  /** The maps are module singletons: a call left running by one test must not be waited on by the next one. */
  it('forgets what is in flight when the cache is cleared', async () => {
    const seen: string[][] = [];
    const release: ((answer: string) => void)[] = [];
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res) => { release.push(res); }); });
    const first = post(hono, { texts: ['a'], lang: 'ru' });
    await waitFor(() => seen.length > 0);
    clearTranslationCache();
    const second = post(hono, { texts: ['a'], lang: 'ru' });
    await waitFor(() => seen.length > 1);                            // nothing left to wait on, so the model is asked again
    release.forEach((r) => r('["ru:a"]'));
    for (const res of [await first, await second]) expect(await res.json()).toEqual({ texts: ['ru:a'] });
  });

  /** The key carries the language: a Ukrainian press must not be handed the Russian call that is already out. */
  it('does not wait on a call made for another language', async () => {
    const seen: string[][] = [];
    const release: ((answer: string) => void)[] = [];
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res) => { release.push(res); }); });
    const first = post(hono, { texts: ['a'], lang: 'ru' });
    await waitFor(() => seen.length > 0);
    const second = post(hono, { texts: ['a'], lang: 'uk' });
    await waitFor(() => seen.length > 1);                            // two languages, two calls
    expect(seen).toEqual([['a'], ['a']]);
    release.forEach((r) => r('["перевод"]'));
    for (const res of [await first, await second]) expect(await res.json()).toEqual({ texts: ['перевод'] });
  });

  /** A fragment the shared call handed back in English answers both requests and is cached for neither. */
  it('shares a fragment returned word for word without caching it for either request', async () => {
    const seen: string[][] = [];
    let release!: (answer: string) => void;
    let n = 0;
    const hono = mount(async (p) => {
      const a = asked(p);
      seen.push(a);
      // the first answer leaves 'b' in English, the next one translates it
      if (++n > 1) return JSON.stringify(a.map((x) => `ru:${x}`));
      return new Promise<string>((res) => { release = res; });
    });
    const texts = ['a', 'b'];
    const first = post(hono, { texts, lang: 'ru' });
    await waitFor(() => seen.length > 0);
    const second = post(hono, { texts, lang: 'ru' });
    await settle();
    release('["ru:a","b"]');
    for (const res of [await first, await second]) expect(await res.json()).toEqual({ texts: ['ru:a', 'b'] });
    await settle();
    // only 'b' is still missing: its in-flight entry is gone and nothing was cached for it
    expect(await (await post(hono, { texts, lang: 'ru' })).json()).toEqual({ texts: ['ru:a', 'ru:b'] });
    expect(seen).toEqual([texts, ['b']]);
  });

  /** The overlap fails, the rest does not: the request reports the failure but keeps what it paid for itself. */
  it('keeps what a request translated itself when the call it was waiting on failed', async () => {
    const seen: string[][] = [];
    const settled: { res: (a: string) => void; rej: (e: Error) => void }[] = [];
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res, rej) => { settled.push({ res, rej }); }); });
    const first = post(hono, { texts: ['a', 'b'], lang: 'ru' });
    await waitFor(() => seen.length > 0);
    const second = post(hono, { texts: ['b', 'c', 'b', ''], lang: 'ru' });   // 'b' rides on the first call, twice over
    await waitFor(() => seen.length > 1);
    expect(seen).toEqual([['a', 'b'], ['c']]);
    settled[1]!.res('["ru:c"]');
    settled[0]!.rej(new Error('Claude Code process aborted by user'));
    expect((await first).status).toBe(502);
    expect((await second).status).toBe(502);                         // 'b' never came, so the second press failed too
    await settle();
    // 'c' was translated and cached; only the fragments of the failed call are asked for again
    const third = post(hono, { texts: ['a', 'b', 'c'], lang: 'ru' });
    await waitFor(() => seen.length > 2);
    settled[2]!.res(JSON.stringify(seen[2]!.map((x) => `ru:${x}`)));
    expect(await (await third).json()).toEqual({ texts: ['ru:a', 'ru:b', 'ru:c'] });
    expect(seen).toEqual([['a', 'b'], ['c'], ['a', 'b']]);
  });

  /** The size limit counts what this request itself sends; refusing it must leave the running call alone. */
  it('refuses an oversized press without disturbing the call already running', async () => {
    const seen: string[][] = [];
    let release!: (answer: string) => void;
    const hono = mount(async (p) => { seen.push(asked(p)); return new Promise<string>((res) => { release = res; }); });
    const first = post(hono, { texts: ['a'], lang: 'ru' });
    await waitFor(() => seen.length > 0);
    expect((await post(hono, { texts: ['a', 'x'.repeat(61_000)], lang: 'ru' })).status).toBe(413);
    release('["ru:a"]');
    expect(await (await first).json()).toEqual({ texts: ['ru:a'] });
    expect(seen).toEqual([['a']]);                                   // the oversized press cost no call
  });

  /** A failed call leaves a rejection per fragment, waited on or not: none of them may reach the process. */
  it('does not leak an unhandled rejection when a call nobody is waiting on fails', async () => {
    const leaked: unknown[] = [];
    const onLeak = (e: unknown) => { leaked.push(e); };
    process.on('unhandledRejection', onLeak);
    try {
      const hono = mount(async () => { throw new Error('Claude Code process aborted by user'); });
      expect((await post(hono, { texts: ['a', 'b', 'c'], lang: 'ru' })).status).toBe(502);
      await settle(20);
      expect(leaked).toEqual([]);
    } finally { process.off('unhandledRejection', onLeak); }
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
