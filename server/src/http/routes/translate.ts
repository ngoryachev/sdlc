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

/** One cheap call must finish inside brief()'s hard 20s timeout, so it gets few texts and not too many characters. */
const BATCH_ITEMS = 20;
const BATCH_CHARS = 2000;
/** A text longer than this is translated in slices and joined back: a 7 KB plan would never fit one call. */
const PIECE_CHARS = 1500;
/** Calls are independent; a big review should not wait for one at a time. */
const PARALLEL = 3;
/** Beyond this the human would wait minutes for one checkpoint; only what is not cached yet counts. */
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
    // empty and whitespace-only strings come back as they are; a long text is sliced, repeated slices translated once
    const jobs = texts.map((text) => (text.trim() ? slice(text) : { parts: [], joiners: [] }));
    const todo = [...new Set(jobs.flatMap((j) => j.parts).filter((x) => x.trim() && !cache.has(keyOf(lang, x))))];
    const chars = todo.reduce((n, x) => n + x.length, 0);
    if (chars > MAX_CHARS) throw new HttpError(413, `this checkpoint is too large to translate at once (${Math.round(chars / 1000)} KB of text, limit ${MAX_CHARS / 1000} KB); read it in English`);
    if (todo.length) {
      if (!app.runner.brief) throw new HttpError(503, 'translation is not available on this server (no cheap model runner)');
      const brief = app.runner.brief.bind(app.runner);
      // what a batch managed is cached before the failure of another one surfaces: Translate again asks only for the rest
      await pool(batches(todo), async (batch) => {
        const got = await translateBatch(brief, batch, lang);
        batch.forEach((text, j) => cachePut(keyOf(lang, text), got[j]!));
      });
    }
    return c.json({ texts: texts.map((text, i) => assemble(jobs[i]!, lang, text)) });
  });
  return r;
}

/** One input text as the slices sent to the model plus the separators that put it back together. */
interface Job { parts: string[]; joiners: string[] }

/** Where a too-long text may be cut, widest boundary first; past the last one it is cut at the limit. */
const BOUNDARIES = [/(\n{2,})/, /(\n)/, /([.!?] )/, /( )/];

/** One slice and the separator that goes before it ('' for the first and for a cut made at the limit). */
interface Piece { pre: string; text: string }

/**
 * Cuts a text too long for one cheap call. Neighbours are grouped up to the limit on the current boundary, and only a
 * group that is still too long is cut finer — one over-long paragraph no longer pushes the whole text onto word
 * boundaries. `pieces.map((x) => x.pre + x.text).join('')` is the text it came from, character for character.
 */
function cut(text: string, level: number): Piece[] {
  if (text.length <= PIECE_CHARS) return [{ pre: '', text }];
  const re = BOUNDARIES[level];
  if (!re) {                                        // nothing left to cut on (base64, one long URL): cut at the limit
    const out: Piece[] = [];
    for (let i = 0; i < text.length; i += PIECE_CHARS) out.push({ pre: '', text: text.slice(i, i + PIECE_CHARS) });
    return out;
  }
  const bits = text.split(re);                      // [part, separator, part, separator, ...]
  if (bits.length < 3) return cut(text, level + 1); // that boundary does not occur in this text
  const out: Piece[] = [];
  let cur = bits[0]!; let pre = '';
  const flush = () => { cut(cur, level + 1).forEach((x, i) => out.push(i ? x : { pre, text: x.text })); };
  for (let i = 1; i < bits.length; i += 2) {
    const sep = bits[i]!; const next = bits[i + 1] ?? '';
    if (cur && cur.length + sep.length + next.length > PIECE_CHARS) { flush(); pre = sep; cur = next; }
    else cur += sep + next;
  }
  flush();
  return out;
}

/** Each slice is translated and cached on its own, so a failure costs only the slice that failed. */
function slice(text: string): Job {
  const pieces = cut(text, 0);
  return { parts: pieces.map((x) => x.text), joiners: pieces.slice(1).map((x) => x.pre) };
}

/** The text as the human sees it: translated slices in place, original separators between them. */
function assemble(job: Job, lang: TranslateLang, original: string): string {
  if (!job.parts.length) return original;           // blank input, nothing was asked for
  return job.parts.reduce((acc, x, i) => acc + (i ? job.joiners[i - 1]! : '') + (x.trim() ? cache.get(keyOf(lang, x)) ?? x : x), '');
}

/** Runs the calls a few at a time; every rejection is awaited, so one failure cannot take the process down. */
async function pool(items: string[][], f: (x: string[]) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await f(item);
  });
  const failed = (await Promise.allSettled(workers)).find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
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
  const raw = (await brief(prompt(texts, lang))).trim();
  // brief() answers '' when its 20s timeout aborts the call or the run fails: that is not a shape problem
  if (!raw) throw new HttpError(502, 'the translation model returned nothing (timed out or failed); the original text is still available');
  const parsed = parseArray(raw);
  // every text handed to a batch is non-blank, so a blank back is a lost finding, not a translation: never cache it
  if (!parsed || parsed.length !== texts.length || parsed.some((s) => !s.trim())) throw new HttpError(502, 'translation returned an unexpected shape; the original text is still available');
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
