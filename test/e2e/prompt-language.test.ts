import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

/**
 * The file-level checks live in test/unit/prompts.test.ts. Here the rule is followed to where it has
 * to arrive: the prompt and the system prompt of a phase that really ran, for a task written in
 * Russian — the case that put Russian findings on PR #1514.
 */
const COMMON_RULE = 'write everything this phase produces in **English**';
const PROMPT_RULE = /Language: write .*\bin English\b/;
/** The header each published phase's prompt file starts with. */
const PUBLISHED = ['# Phase: implement (direct)', '# Phase: test', '# Phase: review', '# Phase: QA'];  // matched as a prefix: QA's reads "# Phase: QA (best effort)"

const autoRunner = () => new FakeRunner((spec) => ({
  act: () => {
    if (spec.prompt.includes('# Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'changed a.txt' }; }
    if (spec.prompt.includes('# Phase: test')) return { structured: { verdict: 'skipped', summary: 'nothing to test', commands: [], tests_added: [], failures: [], notes: '' } };
    if (spec.prompt.includes('# Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    if (spec.prompt.includes('# Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
    if (spec.prompt.includes('# Phase: self_check')) return { text: 'checked' };
    throw new Error('unexpected prompt: ' + spec.prompt.slice(0, 80));
  },
}));

describe('the English rule reaches the phase', () => {
  it('auto on a Russian task: every phase gets it in the system prompt, every published one also in its own prompt', async () => {
    const dir = tmpDir('sdlc-lang-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = autoRunner();
    const app = testApp(dir, runner, { max_loops: 1 });
    const task = await app.engine.createTask({ prompt: 'поменяй a.txt, пожалуйста', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');

    // prompts/system/common.md is appended to every phase, whatever it produces
    expect(runner.specs.length).toBeGreaterThanOrEqual(5);
    for (const s of runner.specs) expect(s.systemAppend ?? '', s.prompt.slice(0, 40)).toContain(COMMON_RULE);

    // and a phase whose output is published repeats it itself, so it survives a "always answer in <language>" setting
    const headers = runner.specs.map((s) => s.prompt.split('\n')[0]!);
    for (const h of PUBLISHED) {
      const spec = runner.specs[headers.findIndex((x) => x.startsWith(h))];
      expect(spec, `phase ${h} never ran`).toBeDefined();
      expect(spec!.prompt, h).toMatch(PROMPT_RULE);
    }
  });

  it('review_mode "line" swaps in prompts/review_line.md, which carries the rule too', async () => {
    const dir = tmpDir('sdlc-lang-line-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = autoRunner();
    const app = testApp(dir, runner, { max_loops: 1 });
    const task = await app.engine.createTask({ prompt: 'поменяй a.txt, пожалуйста', repoPath: repo, pipeline: 'auto', baseRemote: null, reviewMode: 'line' });
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');

    const review = runner.specs.find((s) => s.prompt.startsWith('# Phase: review'))!;
    expect(review.prompt.split('\n')[0]).toBe('# Phase: review (line-level)');
    expect(review.prompt).toMatch(PROMPT_RULE);
    expect(review.systemAppend ?? '').toContain(COMMON_RULE);
  });
});
