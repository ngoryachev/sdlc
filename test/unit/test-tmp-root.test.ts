import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { tmpDir } from '../helpers.js';
import { pruneOldRoots } from '../global-setup.js';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every temp directory a test makes must sit under the per-run root, so teardown takes all of it with one rm. */
describe('per-run temp root', () => {
  it('hands the globalSetup root to a forked worker', () => {
    const root = process.env.SDLC_TEST_TMP;
    expect(root).toBeTruthy();
    expect(path.basename(root!)).toMatch(/^sdlc-test-run-/);
    const dir = tmpDir('sdlc-root-check-');
    expect(path.dirname(dir)).toBe(root);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes roots older than a day and leaves the rest alone', async () => {
    const parent = tmpDir('sdlc-prune-');
    const old = path.join(parent, 'sdlc-test-run-old');
    const fresh = path.join(parent, 'sdlc-test-run-new');
    const other = path.join(parent, 'other-dir');
    for (const d of [old, fresh, other]) fs.mkdirSync(path.join(d, 'inside'), { recursive: true });
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    fs.utimesSync(other, longAgo, longAgo);

    await pruneOldRoots(parent);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('does not throw on a parent that is gone', async () => {
    const parent = tmpDir('sdlc-prune-gone-');
    fs.rmSync(parent, { recursive: true, force: true });
    await expect(pruneOldRoots(parent)).resolves.toBeUndefined();
  });

  it('is the only way tests make temp directories', () => {
    // helpers.ts holds tmpDir() itself, global-setup.ts creates the root, and this file names both to check for them
    const allowed = new Set(['helpers.ts', 'global-setup.ts', 'unit/test-tmp-root.test.ts']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.ts')) continue;
        const rel = path.relative(testRoot, full);
        if (allowed.has(rel)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (src.includes('mkdtemp') || src.includes('tmpdir(')) offenders.push(rel);
      }
    };
    walk(testRoot);
    expect(offenders).toEqual([]);
  });
});
