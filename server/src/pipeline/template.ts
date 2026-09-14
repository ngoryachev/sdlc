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
