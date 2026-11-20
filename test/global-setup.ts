import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT_PREFIX = 'sdlc-test-run-';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Remove roots left by runs that died before teardown (Ctrl+C, kill, crash).
 * Only roots older than `maxAgeMs` go: a recent one may belong to a run in progress in a sibling worktree.
 * Every failure is ignored — another user may own an entry, or a parallel run may delete it first.
 */
export async function pruneOldRoots(parent: string, maxAgeMs = DAY_MS): Promise<void> {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(ROOT_PREFIX)) continue;
    const dir = path.join(parent, e.name);
    try {
      const st = await fs.stat(dir);
      if (st.mtimeMs >= cutoff) continue;
      await fs.rm(dir, { recursive: true, force: true });
    } catch { /* gone, or not ours */ }
  }
}

/** One temp root per `vitest` run, exported to the forked workers as SDLC_TEST_TMP (which `tmpDir()` reads). */
export default async function setup(): Promise<() => Promise<void>> {
  // where the roots live; an outer SDLC_TEST_TMP wins, so a nested run stays inside its parent's root
  const parent = process.env.SDLC_TEST_TMP ?? os.tmpdir();
  await pruneOldRoots(parent);
  const root = await fs.mkdtemp(path.join(parent, ROOT_PREFIX));
  process.env.SDLC_TEST_TMP = root;
  // returned as teardown: vitest calls it however the suite ended
  return async () => { await fs.rm(root, { recursive: true, force: true }); };
}
