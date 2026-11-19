import fs from 'node:fs';
import path from 'node:path';
import type { RepoFile, SdlcConfig } from './config.js';

/** Upload cap for a per-repository file, checked on the parsed bytes (c.req.parseBody() reads the body into memory). */
export const MAX_REPO_FILE_BYTES = 10 * 1024 * 1024;
/** A POSIX environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** filteredEnv() strips SDLC_* (sdlc's own settings), so such a variable would never reach a phase. */
const ENV_RESERVED_PREFIX = 'SDLC_';

/** Why this env variable name cannot be used, or null. */
export function envNameError(env: string): string | null {
  if (!ENV_NAME.test(env)) return `"${env}" is not a valid environment variable name (${ENV_NAME.source})`;
  if (env.startsWith(ENV_RESERVED_PREFIX)) return `${env}: names starting with ${ENV_RESERVED_PREFIX} are reserved for sdlc and never reach a phase`;
  return null;
}

/**
 * One safe path component out of arbitrary text (a repository slug `owner/name`, an uploaded filename `../../x`):
 * separators and `..` collapse, leading dots go, the length is capped. Never empty.
 */
function safeComponent(s: string): string {
  const out = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.\.+/g, '_').replace(/^[._]+/, '').slice(0, 120);
  return out || 'file';
}

/** Directory holding the managed files of one repository: `<files_dir>/<repo>`. */
function repoFilesDir(config: SdlcConfig, repoName: string): string {
  return path.join(config.files_dir, safeComponent(repoName));
}

/**
 * Where a file uploaded for `env` is stored: `<files_dir>/<repo>/<filename>`, repository name and filename each
 * sanitised into one path component. Two env variables must never end up at one file — `.env` for both of them
 * sanitises to the same name — so a name one of the repository's other variables already holds (`taken`) gets this
 * variable's own name prefixed.
 */
export function repoFilePath(config: SdlcConfig, repoName: string, env: string, filename: string, taken: string[] = []): string {
  const dir = repoFilesDir(config, repoName);
  const abs = path.join(dir, safeComponent(filename || env));
  const used = new Set(taken.map((p) => path.resolve(p)));
  return used.has(path.resolve(abs)) ? path.join(dir, safeComponent(`${env}-${path.basename(abs)}`)) : abs;
}

/** Store (or replace) a file at a path from repoFilePath(): mode 0600 in a 0700 directory (both set explicitly, since the umask applies to the flags and an existing entry keeps its mode). */
export function saveRepoFile(abs: string, data: Buffer): void {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(abs, data, { mode: 0o600 });
  fs.chmodSync(abs, 0o600);
}

/**
 * Delete a stored file. Only inside the repository's managed directory: a `path` hand-written into config.yaml that
 * points elsewhere on disk is left alone, removing its entry is all this does.
 */
export function removeRepoFile(config: SdlcConfig, repoName: string, abs: string): void {
  const dir = repoFilesDir(config, repoName);
  const rel = path.relative(dir, path.resolve(abs));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return;
  fs.rmSync(path.resolve(abs), { force: true });
}

export interface RepoFileMeta { env: string; filename: string; size: number | null; mtime: string | null; missing: boolean }

/** What a route may say about a repository's files: never their contents. */
export function repoFileList(files: RepoFile[]): RepoFileMeta[] {
  return files.map((f) => {
    const st = statOrNull(f.path);
    return { env: f.env, filename: path.basename(f.path), size: st?.size ?? null, mtime: st ? st.mtime.toISOString() : null, missing: !st };
  });
}

/**
 * The env variables a task in this repository runs with: one per configured file, holding its absolute path.
 * A file that is gone from disk is reported in `missing` and left unset — a warning for the task, not a failure.
 */
export function repoFileEnv(config: SdlcConfig, repoPath: string): { env: Record<string, string>; missing: RepoFile[] } {
  const entry = config.repos.find((r) => path.resolve(r.path) === path.resolve(repoPath));
  const env: Record<string, string> = {};
  const missing: RepoFile[] = [];
  for (const f of entry?.files ?? []) {
    if (statOrNull(f.path)) env[f.env] = f.path;
    else missing.push(f);
  }
  return { env, missing };
}

export const missingFileWarning = (f: RepoFile) => `file for $${f.env} is missing at ${f.path}; the variable is not set`;

function statOrNull(p: string): fs.Stats | null {
  try { const st = fs.statSync(p); return st.isFile() ? st : null; } catch { return null; }
}
