/** `{{ a.b.c }}` substitution. Unknown path throws unless written `{{ a.b? }}`. Objects are JSON-pretty-printed. */
export type TemplateContext = Record<string, unknown>;

export function getPath(ctx: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = ctx;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    if (!(seg in (cur as Record<string, unknown>))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { found: true, value: cur };
}

export function renderTemplate(tpl: string, ctx: TemplateContext): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.-]+)(\?)?\s*\}\}/g, (_m, path: string, opt?: string) => {
    const { found, value } = getPath(ctx, path);
    if (!found || value === undefined || value === null) {
      if (opt) return '';
      throw new Error(`template: unknown variable {{${path}}}`);
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value, null, 2);
  });
}

/** Collect variable paths referenced by a template (for load-time validation). */
export function templateVars(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)(\?)?\s*\}\}/g)) out.push(m[1]!);
  return out;
}

const OPT_VAR = /\{\{\s*([a-zA-Z0-9_.-]+)\?\s*\}\}/g;

/**
 * Render a body template (pull request, comment) in which each of `ownLine` holds a line of its own that is meant to
 * vanish completely when it has nothing to show — together with the blank line that separated the block from what
 * follows, so the body equals the one of a template that never carried those lines.
 *
 * Only the template's own lines are examined, and only lines made up of nothing but the named variables: the text the
 * body quotes (`{{task.prompt}}`, artifacts, phase output) is substituted afterwards and is never rewritten, so blank
 * lines inside its code fences survive. Every other `{{x?}}` still renders as the empty line it always did.
 */
export function renderBody(tpl: string, ctx: TemplateContext, ownLine: string[]): string {
  const owns = new Set(ownLine);
  const varsOf = (line: string) => [...line.matchAll(OPT_VAR)].map((m) => m[1]!);
  // only the owned placeholders are stripped: whatever is left — literal text, or another variable, which would lose
  // its content if the line went — means the line is not the block's and must survive
  const isOwnLine = (line: string) => {
    const vars = varsOf(line);
    if (!vars.length || !vars.every((v) => owns.has(v))) return false;
    return line.replace(OPT_VAR, (m, name: string) => (owns.has(name) ? '' : m)).trim() === '';
  };
  const rendersEmpty = (line: string) => varsOf(line).every((v) => {
    const { found, value } = getPath(ctx, v);
    return !found || value === undefined || value === null || value === '';
  });

  const lines = tpl.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isOwnLine(lines[i]!)) { out.push(lines[i]!); continue; }
    const run: string[] = [];
    while (i < lines.length && isOwnLine(lines[i]!)) run.push(lines[i++]!);
    i--;
    const kept = run.filter((l) => !rendersEmpty(l));
    if (kept.length) { out.push(...kept); continue; }   // at least one link: the block keeps its blank lines
    if (lines[i + 1] === '') i++;                       // nothing to show: the separator after the block goes too
    else if (i === lines.length - 1 && out.at(-1) === '') out.pop();   // the block ended the template: take the one before it
    // else: text follows straight after the block, so the blank line before it is that paragraph's own
  }
  return renderTemplate(out.join('\n'), ctx);
}
