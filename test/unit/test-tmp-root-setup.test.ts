import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { tmpDir } from '../helpers.js';
import setup, { pruneOldRoots } from '../global-setup.js';

/**
 * The contract `vitest` relies on, exercised directly: setup prunes, creates the root, publishes it,
 * and the teardown it returns takes the whole tree with it (vitest calls that teardown whatever the exit status).
 */
describe('the global setup/teardown contract', () => {
  const original = process.env.SDLC_TEST_TMP;
  afterEach(() => { if (original === undefined) delete process.env.SDLC_TEST_TMP; else process.env.SDLC_TEST_TMP = original; });

  it('prunes, creates the root inside the parent, publishes it and removes it with its contents', async () => {
    const parent = tmpDir('sdlc-setup-parent-');
    process.env.SDLC_TEST_TMP = parent;
    const stale = path.join(parent, 'sdlc-test-run-stale');
    fs.mkdirSync(path.join(stale, 'junk'), { recursive: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

    const teardown = await setup();
    const root = process.env.SDLC_TEST_TMP!;
    expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root)).toMatch(/^sdlc-test-run-/);
    expect(fs.existsSync(stale)).toBe(false);                 // setup pruned the root a killed run left behind
    const child = tmpDir('sdlc-setup-child-');                // what a test would make while the run is on
    expect(path.dirname(child)).toBe(root);
    fs.writeFileSync(path.join(child, 'f.txt'), 'x');

    await teardown();
    expect(fs.existsSync(root)).toBe(false);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('does not throw when the root is already gone at teardown', async () => {
    const parent = tmpDir('sdlc-setup-gone-');
    process.env.SDLC_TEST_TMP = parent;
    const teardown = await setup();
    fs.rmSync(process.env.SDLC_TEST_TMP!, { recursive: true, force: true });
    await expect(teardown()).resolves.toBeUndefined();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('prunes only directories: an old file or symlink with a root name is left alone', async () => {
    const parent = tmpDir('sdlc-prune-kinds-');
    const file = path.join(parent, 'sdlc-test-run-file');
    const target = tmpDir('sdlc-prune-target-');
    const link = path.join(parent, 'sdlc-test-run-link');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(target, link);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(file, twoDaysAgo, twoDaysAgo);
    fs.lutimesSync(link, twoDaysAgo, twoDaysAgo);

    await pruneOldRoots(parent);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(target)).toBe(true);                 // the link was not followed, so its target survives
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });
});
