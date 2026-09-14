import { getPath } from './template.js';

/**
 * Tiny boolean expression language for `when` / `fail_if`:
 *   path            truthy check
 *   !expr
 *   path == 'str'   path != 'str'   path == 123   path == true
 *   a && b  a || b  ( ... )
 */
type Tok = { t: 'path'; v: string } | { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'bool'; v: boolean } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('&&', i) || src.startsWith('||', i) || src.startsWith('==', i) || src.startsWith('!=', i)) { toks.push({ t: 'op', v: src.slice(i, i + 2) }); i += 2; continue; }
    if ('!()'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`expr: unterminated string in "${src}"`);
      toks.push({ t: 'str', v: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    const m = /^[a-zA-Z_][a-zA-Z0-9_.-]*/.exec(src.slice(i));
    if (m) {
      const w = m[0];
      if (w === 'true' || w === 'false') toks.push({ t: 'bool', v: w === 'true' });
      else toks.push({ t: 'path', v: w });
      i += w.length; continue;
    }
    const n = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (n) { toks.push({ t: 'num', v: Number(n[0]) }); i += n[0].length; continue; }
    throw new Error(`expr: unexpected character '${c}' in "${src}"`);
  }
  return toks;
}

export function evalExpr(src: string, ctx: unknown): boolean {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const value = (): unknown => {
    const t = next();
    if (!t) throw new Error(`expr: unexpected end in "${src}"`);
    if (t.t === 'op' && t.v === '(') { const v = or(); const close = next(); if (!close || close.t !== 'op' || close.v !== ')') throw new Error('expr: expected )'); return v; }
    if (t.t === 'op' && t.v === '!') return !truthy(value());
    if (t.t === 'path') return getPath(ctx, t.v).value;
    if (t.t === 'str' || t.t === 'num' || t.t === 'bool') return t.v;
    throw new Error(`expr: unexpected token ${JSON.stringify(t)}`);
  };
  const cmp = (): unknown => {
    let l = value();
    const t = peek();
    if (t && t.t === 'op' && (t.v === '==' || t.v === '!=')) {
      next();
      const r = value();
      // eslint-disable-next-line eqeqeq
      const eq = String(l ?? '') == String(r ?? '');
      l = t.v === '==' ? eq : !eq;
    }
    return l;
  };
  const and = (): unknown => { let l = cmp(); while (peek()?.t === 'op' && peek()?.v === '&&') { next(); const r = cmp(); l = truthy(l) && truthy(r); } return l; };
  const or = (): unknown => { let l = and(); while (peek()?.t === 'op' && peek()?.v === '||') { next(); const r = and(); l = truthy(l) || truthy(r); } return l; };
  const res = or();
  if (p !== toks.length) throw new Error(`expr: trailing tokens in "${src}"`);
  return truthy(res);
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
