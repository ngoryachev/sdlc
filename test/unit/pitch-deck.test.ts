import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { join } from 'node:path';

/**
 * `docs/index.html` is the published pitch deck (GitHub Pages, branch main / folder /docs).
 * It has no build step and no test of its own, so the promises that make it work are checked here:
 * it must open offline with zero network requests, and its single inline script must survive an edit.
 */
const root = join(import.meta.dirname, '../..');
const html = readFileSync(join(root, 'docs/index.html'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const slides = html.match(/<section class="slide[^>]*>/g) ?? [];
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

describe('pitch deck: self-contained', () => {
  it('loads nothing from the network', () => {
    // Anything that fetches: an element with src, a stylesheet link, a CSS import, a remote font/image, XHR.
    for (const pattern of [/\ssrc=/, /<link\b/i, /@import/, /url\(\s*['"]?https?:/i, /\bfetch\(/, /XMLHttpRequest/, /\bimport\s*\(/]) {
      expect(html, `docs/index.html must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  it('mentions remote URLs only as text or as a link to click', () => {
    const urls = html.match(/https?:\/\/[^"'\s<)]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toMatch(/^https:\/\/(github\.com|raw\.githubusercontent\.com)\/ngoryachev\/sdlc/);
  });

  it('keeps the install command in step with the README', () => {
    const cmd = 'https://raw.githubusercontent.com/ngoryachev/sdlc/main/deploy/install.sh';
    expect(html).toContain(cmd);
    expect(readme).toContain(cmd);
  });

  it('is linked from the README at its published URL', () => {
    expect(readme).toContain('https://ngoryachev.github.io/sdlc/');
    expect(readme).toContain('docs/index.html');
  });
});

describe('pitch deck: the script that drives it', () => {
  it('parses', () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Script(script, { filename: 'docs/index.html' })).not.toThrow();   // compile only, never run: there is no DOM here
  });

  it('only reaches for elements that exist', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    expect(wanted.length).toBeGreaterThan(5);
    for (const id of wanted) expect(ids, `#${id} is read by the script`).toContain(id);
    for (const sel of [...script.matchAll(/querySelector\('#([\w-]+)/g)].map((m) => m[1])) expect(ids).toContain(sel);
  });

  it('attaches its per-slide key handlers to slides that are really there', () => {
    const keys = [...script.matchAll(/^\s{4}'(s-[\w-]+)': function/gm)].map((m) => m[1]);
    expect(keys).toEqual(['s-pipeline', 's-autonomy', 's-triage']);   // the three viewer-driven slides
    for (const k of keys) expect(html).toContain(`id="${k}"`);
  });

  it('shows one phase per step of the pipeline the README advertises', () => {
    const phases = [...script.matchAll(/\{ n: '([\w]+)',\s+k: '(\w+)'/g)].map((m) => ({ name: m[1], kind: m[2] }));
    expect(phases.map((p) => p.name)).toEqual(
      ['clarify', 'refine', 'plan', 'approve', 'implement', 'self_check', 'commit', 'test', 'review', 'approve', 'PR', 'qa'],
    );
    expect(phases.filter((p) => p.kind === 'hil')).toHaveLength(3);   // slide 4 claims "three of them are yours"
    expect(html).toContain('Twelve phases. Three of them are yours.');
  });
});

describe('pitch deck: the slides', () => {
  it('has 10 to 14 of them', () => {
    expect(slides.length).toBeGreaterThanOrEqual(10);
    expect(slides.length).toBeLessThanOrEqual(14);
  });

  it('gives every slide a title, a duration and speaker notes', () => {
    // show() and the overview read all three; a missing one renders the string "undefined" on screen.
    slides.forEach((s, i) => {
      for (const attr of ['data-title', 'data-sec', 'data-notes']) {
        expect(s, `slide ${i + 1} needs ${attr}`).toContain(`${attr}="`);
      }
    });
  });

  it('is paced for about five minutes', () => {
    const total = slides.reduce((sum, s) => sum + Number(/data-sec="(\d+)"/.exec(s)![1]), 0);
    expect(total).toBeGreaterThan(240);
    expect(total).toBeLessThan(400);
  });

  it('closes on the call-to-action, with no date invented for it', () => {
    const last = slides[slides.length - 1]!;
    expect(last).toContain('coming soon');
    expect(html).toContain('https://github.com/ngoryachev/sdlc');
  });
});
