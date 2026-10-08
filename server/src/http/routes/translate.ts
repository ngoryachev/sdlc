import crypto from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { TRANSLATE_LANGS, TRANSLATE_LANG_NAMES, type TranslateLang } from '@sdlc/shared';
import type { App } from '../../app.js';
import { HttpError } from '../../engine/engine.js';

const Body = z.object({
  texts: z.array(z.string()).max(400),
  lang: z.enum(TRANSLATE_LANGS),
}).strict();

/**
 * A whole checkpoint travels in one call and comes back as one answer, so that call is given minutes: translating real
 * prose is slow and uneven, and the 20s that a branch slug needs is nowhere near enough for it.
 */
const TIMEOUT_MS = 300_000;
/** One answer that long would not fit the cheap model's output anyway; such a checkpoint is read in English. */
const MAX_CHARS = 60_000;
/** Translations live in process memory only: nothing is written to the database or sent to GitHub. */
const CACHE_MAX = 2000;
const cache = new Map<string, string>();

const keyOf = (lang: TranslateLang, text: string) => `${lang}:${crypto.createHash('sha256').update(text).digest('hex')}`;

function cachePut(key: string, value: string): void {
  cache.delete(key);
  cache.set(key, value);
  // insertion order is eviction order: the oldest keys go first
  while (cache.size > CACHE_MAX) { const oldest = cache.keys().next(); if (oldest.done) break; cache.delete(oldest.value); }
}

/** Exported for tests: the cache is a module singleton shared by every App in the process. */
export function clearTranslationCache(): void { cache.clear(); }

export function translateRoutes(app: App) {
  const r = new Hono();
  /** Read-only translation of checkpoint texts: the English original stays the data, this never leaves the screen. */
  r.post('/translate', async (c) => {
    const body = Body.safeParse(await c.req.json());
    if (!body.success) throw new HttpError(400, `bad translate request: ${body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    const { texts, lang } = body.data;
    // empty and whitespace-only strings come back as they are; a repeated text is translated once
    const todo = [...new Set(texts.filter((x) => x.trim() && !cache.has(keyOf(lang, x))))];
    const chars = todo.reduce((n, x) => n + x.length, 0);
    if (chars > MAX_CHARS) throw new HttpError(413, `this checkpoint is too large to translate at once (${Math.round(chars / 1000)} KB of text, limit ${MAX_CHARS / 1000} KB); read it in English`);
    if (todo.length) {
      if (!app.runner.brief) throw new HttpError(503, 'translation is not available on this server (no cheap model runner)');
      const got = await translateAll(app.runner.brief.bind(app.runner), todo, lang);
      todo.forEach((text, i) => cachePut(keyOf(lang, text), got[i]!));
    }
    return c.json({ texts: texts.map((x) => (x.trim() ? cache.get(keyOf(lang, x)) ?? x : x)) });
  });
  return r;
}

/** The single pass: everything the cache is missing, one call, one answer of exactly the same length. */
async function translateAll(brief: (prompt: string, timeoutMs?: number) => Promise<string>, texts: string[], lang: TranslateLang): Promise<string[]> {
  let raw: string;
  try {
    raw = (await brief(prompt(texts, lang), TIMEOUT_MS)).trim();
  } catch (e) {
    // the SDK throws on an abort ('Claude Code process aborted by user') and on a failed launch: not a text for a toast
    console.error('[translate] the cheap model call failed:', e);
    throw new HttpError(502, 'the translation call did not finish; the original text is still available');
  }
  if (!raw) throw new HttpError(502, 'the translation model returned nothing (timed out or failed); the original text is still available');
  const parsed = parseArray(raw);
  // a blank where the input had prose is a lost finding, not a translation, and neither is a half-sized answer
  if (!parsed || parsed.length !== texts.length || parsed.some((s) => !s.trim())) {
    throw new HttpError(502, `translation came back in an unexpected shape (${texts.length} texts were asked for); the original text is still available`);
  }
  return parsed;
}

function prompt(texts: string[], lang: TranslateLang): string {
  return [
    `Translate every element of the JSON array below into ${TRANSLATE_LANG_NAMES[lang]}.`,
    'Keep unchanged: markdown markup, code blocks and inline code, file paths, identifiers, severity and verdict names, numbers, URLs and link targets.',
    'Translate prose only. Do not add, merge, split, reorder, summarise or explain anything.',
    `Answer with nothing but a JSON array of exactly ${texts.length} strings, in the same order as the input.`,
    '',
    JSON.stringify(texts),
  ].join('\n');
}

/** The model may wrap the array in a ```json fence despite the instruction. */
function parseArray(raw: string): string[] | null {
  let s = raw.trim();
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1]!.trim();
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : null;
  } catch { return null; }
}
