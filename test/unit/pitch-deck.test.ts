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

/** One piece of the inline script, with a failure that names what went missing instead of a null deref. */
function part(re: RegExp, what: string): string {
  const m = re.exec(script);
  if (!m?.[1]) throw new Error(`${what} not found in the script of docs/index.html — was it renamed or reformatted?`);
  return m[1];
}

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

  it('attaches its per-slide behaviour to slides that are really there', () => {
    // keyed by slide id in two places: the key handlers and the state reset done on slide entry
    const keys = [...new Set([...script.matchAll(/'(s-[\w-]+)':\s*function/g)].map((m) => m[1]))];
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

describe('pitch deck: navigation matches the way it is documented', () => {
  // The head comment is the only documentation the deck has; it already drifted from the
  // click handler once ("right or left half" vs a 32% split), so both halves are pinned here.
  const header = /<!--([\s\S]*?)-->/.exec(html)?.[1] ?? '';
  const clickHandler = () =>
    part(/getElementById\('deck'\)\.addEventListener\('click',([\s\S]*?\bgo\([^)]*\);)/, 'the slide-navigation click handler');

  it('handles every key the head comment advertises', () => {
    const advertised = [
      'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', // "arrows"
      'PageUp', 'PageDown', 'Home', 'End', 'Escape',     // "PageUp / PageDown / Home / End", "Esc for the overview"
    ];
    for (const k of advertised) expect(script, `the comment promises ${k}`).toContain(`'${k}'`);
    expect(script).toMatch(/k === ' '/);                 // space
    expect(script).toMatch(/k === 'n' \|\| k === 'N'/);  // notes
    expect(script).toMatch(/k === 't' \|\| k === 'T'/);  // theme
  });

  it('splits the click target where the comment says it does', () => {
    const ratio = Number(part(/BACK_ZONE = ([\d.]+)/, 'the BACK_ZONE constant'));
    expect(ratio).toBeGreaterThan(0.25);                 // the comment says "left third goes back"
    expect(ratio).toBeLessThan(0.4);
    expect(header).toMatch(/left third goes back/);
  });

  it('never steals a click meant for a control, a link or selectable text', () => {
    // Everything interactive or worth copying must be exempt, or the deck jumps while you use it.
    const handler = clickHandler();
    for (const tag of ['button', 'a', '.mock', 'pre']) expect(handler).toContain(tag);
    expect(handler, 'a drag-selection must not advance the slide').toMatch(/getSelection\(\)/);
    // Each exempt selector has to correspond to something really on a slide.
    for (const sel of ['<button', '<a ', 'class="mock', '<pre']) expect(html).toContain(sel);
  });
});

describe('pitch deck: a viewer-driven slide opens in its demo state', () => {
  // Entering slide 4, 5 or 7 resets it, so a presenter who steps the pipeline, backs up and
  // comes again gets the demo rather than the state they left behind. The reset has to restore
  // everything the slide's key handler can change, or the slide comes back half-edited.
  const showBody = () => part(/function show\(i, push\) \{([\s\S]*?)\n  \}/, 'the show() function');
  const objBody = (name: string) =>
    part(new RegExp(`var ${name} = \\{([\\s\\S]*?)\\n  \\};`), `the ${name} object`);
  const perSlide = (name: string): Record<string, string> => {
    const parts = objBody(name).split(/'(s-[\w-]+)':/).slice(1);
    return Object.fromEntries(parts.flatMap((p, i) => (i % 2 ? [] : [[p, parts[i + 1]!]])));
  };
  /** The state a block writes to, by field name: `pcur`, `GATES[i].on` and `g.on` each count once. */
  const written = (body: string): string[] => {
    const locals = new Set([...body.matchAll(/\bvar\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));
    const slots = [...body.matchAll(/(?:\.|\b)([A-Za-z_]\w*)\s*(?:=(?!=)|\+\+|--)/g)].map((m) => m[1]!);
    return [...new Set(slots.filter((s) => !locals.has(s)))].sort();
  };

  it('resets the slide on entry, and not on a re-render of the slide already on screen', () => {
    expect(showBody()).toMatch(/cur !== shown/);
    expect(showBody()).toMatch(/resets\[/);
  });

  it('restores every piece of state the slide lets the viewer change', () => {
    const handlers = perSlide('handlers');
    const resets = perSlide('resets');
    expect(Object.keys(resets)).toEqual(Object.keys(handlers));
    for (const [slide, handler] of Object.entries(handlers)) {
      expect(written(resets[slide]!), `#${slide} must reset what its keys change`)
        .toEqual(expect.arrayContaining(written(handler)));
    }
  });

  it('snapshots the demo values before the viewer can touch them', () => {
    // `g.on0` / `f.a0` are the baselines the reset restores. Taken late they would snapshot an edit.
    for (const [live, base] of [['on', 'on0'], ['a', 'a0']]) {
      const at = script.indexOf(`.${base} = `);
      expect(at, `the ${base} baseline`).toBeGreaterThan(-1);
      expect(script.slice(at, at + 40), `${base} must copy the live ${live}`).toContain(`.${live};`);
      expect(at, `${base} must be captured before the resets run`).toBeLessThan(script.indexOf('var resets = {'));
    }
  });

  it('keeps navigating when the browser refuses to update the hash', () => {
    // Opened from disk the document can be an opaque origin, where replaceState throws.
    expect(showBody()).toMatch(/try \{[^}]*history\.replaceState[\s\S]*?\} catch/);
    // The slide must already be painted by then, so a throw cannot leave the deck mid-transition.
    expect(showBody().indexOf('classList.toggle')).toBeLessThan(showBody().indexOf('history.replaceState'));
  });
});
