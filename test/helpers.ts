import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigSchema, sdlcRoot } from '../server/src/config/config.js';
import { createApp } from '../server/src/app.js';
import type { ClaudeRunner } from '../server/src/claude/runner.js';

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

export function testApp(dir: string, runner: ClaudeRunner, overrides: Record<string, unknown> = {}) {
  const config = ConfigSchema.parse({ data_dir: path.join(dir, 'data'), worktrees_dir: path.join(dir, 'wt'), pipelines_dirs: [path.join(sdlcRoot(), 'pipelines')], cleanup: 'never', ...overrides });
  return createApp({ config, runner, dbFile: ':memory:' });
}
