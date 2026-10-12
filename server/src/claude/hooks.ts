import path from 'node:path';
import type { HookCallback, HookCallbackMatcher, HookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface HookOptions {
  /** Absolute path of the worktree; writes outside it are always denied. */
  cwd: string;
  /** Globs relative to cwd; when set, writes outside them are denied and writes inside are allowed. */
  writeScope?: string[];
  /** Called for every PostToolUse (progress reporting). Never awaited by the hook. */
  onToolUse?: (info: { toolName: string; toolInput: unknown; toolUseId: string }) => void;
}

/** Commands that are denied in every phase regardless of pipeline settings. */
export const HARD_DENY_BASH: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+commit\b.*--amend/,
  /\bgit\s+(reset|checkout)\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /(^|[;&|]\s*)sudo\b/,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME)(\s|$)/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bwget\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bmkfs\b|\bdd\s+if=/,
];

/** Minimal gitignore-style glob → RegExp. Supports **, *, ? and a leading ! for negation (handled by caller). */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

export function matchesScope(relPath: string, scope: string[]): boolean {
  let matched = false;
  for (const g of scope) {
    const neg = g.startsWith('!');
    const re = globToRegExp(neg ? g.slice(1) : g);
    if (re.test(relPath)) matched = !neg;
  }
  return matched;
}

function deny(reason: string) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
  };
}
function allow(reason: string) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'allow' as const, permissionDecisionReason: reason },
  };
}

export function buildHooks(opts: HookOptions): Partial<Record<'PreToolUse' | 'PostToolUse', HookCallbackMatcher[]>> {
  const root = path.resolve(opts.cwd);

  const writeGuard: HookCallback = async (input: HookInput) => {
    const i = input as PreToolUseHookInput;
    if (!WRITE_TOOLS.has(i.tool_name)) return {};
    const fp = (i.tool_input as { file_path?: string; notebook_path?: string })?.file_path
      ?? (i.tool_input as { notebook_path?: string })?.notebook_path;
    if (!fp) return {};
    const abs = path.resolve(root, fp);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return deny(`Writes outside the worktree are not allowed: ${fp}`);
    if (rel === '.git' || rel.startsWith('.git/')) return deny('Writes inside .git are not allowed');
    if (opts.writeScope && opts.writeScope.length > 0) {
      if (!matchesScope(rel, opts.writeScope)) {
        return deny(`This phase may only write to: ${opts.writeScope.join(', ')} (attempted ${rel})`);
      }
      return allow('within write_scope');
    }
    return {};
  };

  const bashGuard: HookCallback = async (input: HookInput) => {
    const i = input as PreToolUseHookInput;
    if (i.tool_name !== 'Bash') return {};
    const cmd = String((i.tool_input as { command?: string })?.command ?? '');
    for (const re of HARD_DENY_BASH) {
      if (re.test(cmd)) return deny(`Command blocked by sdlc safety policy (${re.source})`);
    }
    return {};
  };

  const progress: HookCallback = async (input: HookInput, toolUseID) => {
    const i = input as { tool_name?: string; tool_input?: unknown };
    if (opts.onToolUse && i.tool_name) {
      try { opts.onToolUse({ toolName: i.tool_name, toolInput: i.tool_input, toolUseId: toolUseID ?? '' }); } catch { /* ignore */ }
    }
    return {};
  };

  return {
    PreToolUse: [
      { matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [writeGuard] },
      { matcher: 'Bash', hooks: [bashGuard] },
    ],
    PostToolUse: [{ hooks: [progress] }],
  };
}
