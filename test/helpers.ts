import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigSchema, sdlcRoot } from '../server/src/config/config.js';
import { createApp } from '../server/src/app.js';
import type { ClaudeRunner } from '../server/src/claude/runner.js';
import type { GitHub } from '../server/src/git/gh.js';

export function tmpDir(prefix: string): string { return fs.mkdtempSync(path.join(process.env.SDLC_TEST_TMP ?? os.tmpdir(), prefix)); }

export function makeRepo(dir: string, files: Record<string, string>, sdlcYaml?: string): string {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  if (sdlcYaml) fs.writeFileSync(path.join(repo, '.sdlc.yaml'), sdlcYaml);
  const g = (args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g(['init', '-q', '-b', 'main']); g(['add', '-A']); g(['commit', '-q', '-m', 'init']);
  return repo;
}

export function testApp(dir: string, runner: ClaudeRunner, overrides: Record<string, unknown> = {}, github?: GitHub) {
  const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), worktrees_dir: path.join(dir, 'wt'), pipelines_dirs: [path.join(sdlcRoot(), 'pipelines')], cleanup: 'never', pr_sync_interval: 'off', ...overrides });
  return createApp({ config, runner, dbFile: ':memory:', github });
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString().trim();

/** A repo with a bare `origin` (main pushed): stands in for GitHub in delivery tests. */
export function makeRemoteRepo(dir: string, files: Record<string, string> = { 'README.md': 'hi\n' }): { repo: string; bare: string } {
  const repo = makeRepo(dir, files);
  const bare = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, ['remote', 'add', 'origin', bare]);
  sh(repo, ['push', '-q', '-u', 'origin', 'main']);
  return { repo, bare };
}

/** Commit a file directly on a branch of the bare remote (someone else pushing, or a PR merged on GitHub). */
export function commitOnRemote(bare: string, branch: string, file: string, content = 'remote\n'): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-remote-'));
  sh(tmp, ['clone', '-q', bare, '.']);
  sh(tmp, ['checkout', '-q', branch]);
  fs.writeFileSync(path.join(tmp, file), content);
  sh(tmp, ['add', '-A']); sh(tmp, ['commit', '-q', '-m', `remote ${file}`]); sh(tmp, ['push', '-q', 'origin', branch]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
export const remoteHas = (bare: string, branch: string) => { try { sh(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } };
export const remoteFile = (bare: string, branch: string, file: string) => { try { sh(bare, ['cat-file', '-e', `${branch}:${file}`]); return true; } catch { return false; } };
export const localHas = (repo: string, branch: string) => { try { sh(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } };
