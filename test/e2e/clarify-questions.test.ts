import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { NO_ANSWER } from '../../server/src/engine/engine.js';
import type { ClarifyQuestion } from '@sdlc/shared';

/**
 * Clarify may ask as many questions as it needs and the developer may leave any of them unanswered:
 * an unanswered one is itself an answer ("decide it yourself"), and the implementer has to be told so.
 */
const quickRunner = (questions: ClarifyQuestion[]) => new FakeRunner((spec) => ({
  act: () => {
    const p = spec.prompt;
    if (p.includes('Phase: clarify')) return { structured: { branch: 'change a', questions, suggestedPrompt: 'Change a.txt', assumptions: [] } };
    if (p.includes('Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
    if (p.includes('Phase: self_check')) return { text: 'checked' };
    if (p.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' } };
    if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
    if (p.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
    throw new Error('unexpected prompt: ' + p.slice(0, 100));
  },
}));

async function refineHil(prefix: string, questions: ClarifyQuestion[]) {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  const runner = quickRunner(questions);
  const app = testApp(dir, runner);
  const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick', baseRemote: null });
  await app.engine.advance(task.id);
  const hil = app.store.openHilForTask(task.id)[0]!;
  expect(hil.kind).toBe('refine_prompt');
  return { app, runner, task, hil };
}

describe('clarifying questions at the refine checkpoint', () => {
  it('approve with no answers at all goes through and leaves the question to the implementer', async () => {
    const { app, runner, task, hil } = await refineHil('sdlc-clarify-open-', [{ question: 'Which file?', header: 'File', options: ['a.txt'] }]);
    await app.engine.respondHil(hil.id, { decision: 'approve' }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getHil(hil.id)!.status).toBe('answered');
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe(`Change a.txt\n\n## Clarifying questions\n- **File**: Which file?\n  → ${NO_ANSWER}`);
    // the implementer sees the question itself, not just that there was none: it is the one deciding now
    const implement = runner.specs.find((s) => s.prompt.includes('Phase: implement'))!;
    expect(implement.prompt).toContain('- **File**: Which file?');
    expect(implement.prompt).toContain(NO_ANSWER);
  });

  it('an answered question is rendered with the answer the developer gave', async () => {
    const { app, task, hil } = await refineHil('sdlc-clarify-answered-', [{ question: 'Which file?', header: 'File', options: ['a.txt'] }]);
    await app.engine.respondHil(hil.id, { decision: 'approve', answers: { 'Which file?': ' a.txt ' } }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe('Change a.txt\n\n## Clarifying questions\n- **File**: Which file?\n  → a.txt');
  });

  it('more than four questions all reach the checkpoint, answered and unanswered side by side', async () => {
    const questions: ClarifyQuestion[] = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}?`, header: `H${i}` }));
    const { app, task, hil } = await refineHil('sdlc-clarify-many-', questions);
    expect(hil.payload.kind === 'refine_prompt' && hil.payload.questions.length).toBe(6);
    expect(hil.summary).toBe('6 clarifying question(s)');
    await app.engine.respondHil(hil.id, { decision: 'approve', answers: { 'Q1?': 'one', 'Q4?': 'four' } }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe([
      'Change a.txt', '', '## Clarifying questions',
      ...questions.map((q, i) => `- **${q.header}**: ${q.question}\n  → ${i === 1 ? 'one' : i === 4 ? 'four' : NO_ANSWER}`),
    ].join('\n'));
  });
});
