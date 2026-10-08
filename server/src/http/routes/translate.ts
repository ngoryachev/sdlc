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

/** One cheap call translates up to this much at once; `brief()` has a 20s timeout, so long checkpoints are split. */
const BATCH_ITEMS = 20;
const BATCH_CHARS = 4000;
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
    const { texts, lang } = Body.parse(await c.req.json());
    // empty and whitespace-only strings come back as they are; repeated texts are translated once
    const todo = [...new Set(texts.filter((t) => t.trim() && !cache.has(keyOf(lang, t))))];
    if (todo.length) {
      if (!app.runner.brief) throw new HttpError(503, 'translation is not available on this server (no cheap model runner)');
      const brief = app.runner.brief.bind(app.runner);
      for (const batch of batches(todo)) {
        const got = await translateBatch(brief, batch, lang);
        batch.forEach((text, j) => cachePut(keyOf(lang, text), got[j]!));
      }
    }
    return c.json({ texts: texts.map((t) => (t.trim() ? cache.get(keyOf(lang, t)) ?? t : t)) });
  });
  return r;
}

function batches(texts: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= BATCH_ITEMS || chars + t.length > BATCH_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(t); chars += t.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function translateBatch(brief: (prompt: string) => Promise<string>, texts: string[], lang: TranslateLang): Promise<string[]> {
  const raw = await brief(prompt(texts, lang));
  const parsed = parseArray(raw);
  if (!parsed || parsed.length !== texts.length) throw new HttpError(502, 'translation returned an unexpected shape; the original text is still available');
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
