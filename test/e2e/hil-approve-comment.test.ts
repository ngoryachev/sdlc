import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { HUMAN_ADDITIONS_HEADING } from '@sdlc/shared';

/** The standard pipeline up to implement: clarify asks one question so the refine checkpoint reaches the human. */
function setup(prefix: string) {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  const prompts: Record<string, string[]> = {};
  const seen = (k: string, p: string) => { (prompts[k] ??= []).push(p); };
  const runner = new FakeRunner((spec) => ({
    act: () => {
      const p = spec.prompt;
      if (p.includes('Phase: clarify')) return { structured: { questions: [{ question: 'Which file?', header: 'File' }], suggestedPrompt: 'Change a.txt', assumptions: [] } };
      if (p.includes('Phase: plan')) { seen('plan', p); fs.mkdirSync(path.join(spec.cwd, '.sdlc'), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# Plan v1\n\n- change a.txt\n'); return { text: 'plan summary' }; }
      if (p.includes('Phase: implement')) { seen('implement', p); fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
      throw new Error('unexpected prompt: ' + p.slice(0, 80));
    },
  }));
  const app = testApp(dir, runner);
  return { app, repo, prompts };
}

const planPath = (app: ReturnType<typeof testApp>, taskId: string) => {
  const run = app.store.latestRunForTask(taskId)!;
  return app.store.phaseRunsForRun(run.id).find((p) => p.artifacts.plan_md)!.artifacts.plan_md!;
};

describe('an approval comment reaches the agent', () => {
  it('approve_plan + comment: appended to plan.md as Human additions after the edit, and implement reads it', async () => {
    const { app, repo, prompts } = setup('sdlc-approve-comment-');
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'standard', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);

    // refine: the note is appended to the refined prompt, so plan (and every later phase) sees it
    let hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('refine_prompt');
    await app.engine.respondHil(hil.id, { decision: 'approve', answers: { 'Which file?': 'a.txt' }, comment: 'keep the trailing newline' }, 'web');
    await app.engine.advance(task.id);
    const refined = app.store.getTask(task.id)!.refinedPrompt!;
    expect(refined).toMatch(/## Clarifying questions[\s\S]*## Additional notes from the human\nkeep the trailing newline$/);
    expect(prompts.plan![0]).toContain('## Additional notes from the human\nkeep the trailing newline');

    hil = app.store.openHilForTask(task.id)[0]!;
    expect(hil.kind).toBe('approve_plan');
    await app.engine.respondHil(hil.id, { decision: 'approve', edited: { planMd: '# Plan v1 (edited)\n' }, comment: '  also rename foo to bar  ' }, 'web');
    await app.engine.advance(task.id);

    const plan = fs.readFileSync(planPath(app, task.id), 'utf8');
    expect(plan).toBe(`# Plan v1 (edited)\n\n${HUMAN_ADDITIONS_HEADING}\n\nThe human approved the plan with these additions; they take precedence over the plan where they conflict:\n\nalso rename foo to bar\n`);
    expect(prompts.implement).toHaveLength(1);
    expect(prompts.implement![0]).toContain('# Plan v1 (edited)');
    expect(prompts.implement![0]).toContain(`${HUMAN_ADDITIONS_HEADING}\n\nThe human approved the plan with these additions`);
    expect(prompts.implement![0]).toContain('also rename foo to bar');
    expect(app.store.getTask(task.id)!.status).toBe('succeeded');
  });

  it('approve without a comment leaves the plan and the prompt as they were', async () => {
    const { app, repo, prompts } = setup('sdlc-approve-nocomment-');
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'standard', baseRemote: null, stopAfter: 'implement' });
    await app.engine.advance(task.id);
    let hil = app.store.openHilForTask(task.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'approve', answers: { 'Which file?': 'a.txt' } }, 'web');
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).not.toContain('Additional notes');

    hil = app.store.openHilForTask(task.id)[0]!;
    await app.engine.respondHil(hil.id, { decision: 'approve', comment: '   ' }, 'web');   // whitespace is no comment
    await app.engine.advance(task.id);
    expect(fs.readFileSync(planPath(app, task.id), 'utf8')).toBe('# Plan v1\n\n- change a.txt\n');
    expect(prompts.implement![0]).not.toContain(HUMAN_ADDITIONS_HEADING);
  });
});
