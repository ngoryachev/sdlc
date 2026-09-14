import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';

describe('auto pipeline end-to-end (fake runner)', () => {
  it('implements, commits, tests, reviews; test failure loops back once', async () => {
    const dir = tmpDir('sdlc-e2e-');
    const repo = makeRepo(dir, {
      'package.json': '{"name":"demo","type":"module"}',
      'src/math.js': 'export function divide(a, b) { return a / b; }\n',
      'test.js': "import { divide } from './src/math.js'; import assert from 'node:assert'; assert.throws(() => divide(1, 0)); console.log('ok');\n",
    }, 'test_command: node test.js\n');

    let implementCalls = 0;
    const runner = new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: implement') || spec.prompt.includes('Tests failed')) {
          implementCalls++;
          const f = path.join(spec.cwd, 'src/math.js');
          if (implementCalls === 1) {
            // first attempt: wrong fix (does not throw) → tests fail
            fs.writeFileSync(f, 'export function divide(a, b) { if (b === 0) return NaN; return a / b; }\n');
            fs.mkdirSync(path.join(spec.cwd, '.sdlc'), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# plan\n');
            return { text: 'implemented (wrong)', cost: 0.5, toolCalls: [{ name: 'Edit', input: { file_path: f } }] };
          }
          expect(spec.resume).toBe('fake-session-1'); // back_to resumes the implement session
          expect(spec.prompt).toMatch(/Tests failed/);
          fs.writeFileSync(f, 'export function divide(a, b) { if (b === 0) throw new Error("div by zero"); return a / b; }\n');
          return { text: 'fixed', cost: 0.3 };
        }
        if (spec.prompt.includes('Phase: review')) {
          return { text: 'reviewed', structured: { verdict: 'approve', summary: 'Looks right.', findings: [] }, cost: 0.2 };
        }
        throw new Error('unexpected prompt: ' + spec.prompt.slice(0, 80));
      },
    }));

    const app = testApp(dir, runner);
    const seen: string[] = [];
    app.events.on((e) => { if (e.type === 'phase.finished') { const p = (e.payload as { phaseRun: { phaseName: string; status: string } }).phaseRun; seen.push(`${p.phaseName}:${p.status}`); } });

    const task = await app.engine.createTask({ prompt: 'divide by zero should throw', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);

    const t = app.store.getTask(task.id)!;
    expect(t.status).toBe('succeeded');
    expect(seen).toEqual(['implement:succeeded', 'commit_impl:succeeded', 'test:failed', 'implement:succeeded', 'commit_impl:succeeded', 'test:succeeded', 'review:succeeded']);
    expect(implementCalls).toBe(2);
    expect(t.totalCostUsd).toBeCloseTo(1.0, 5);

    // two commits on the task branch, worktree kept (cleanup: never)
    const log = execFileSync('git', ['log', '--oneline', 'main..' + t.branch], { cwd: repo }).toString().trim().split('\n');
    expect(log.length).toBe(2);
    expect(fs.existsSync(path.join(t.worktreePath, '.sdlc/plan.md'))).toBe(true);
    // .sdlc not committed
    expect(execFileSync('git', ['ls-tree', '-r', '--name-only', t.branch], { cwd: repo }).toString()).not.toMatch(/^\.sdlc\//m);
    // review structured output persisted
    const review = app.store.phaseRunsForTask(t.id).find((p) => p.phaseName === 'review')!;
    expect((review.structuredOutput as { verdict: string }).verdict).toBe('approve');
  });

  it('escalates to HIL when review keeps requesting changes and on_fail.then is hil; retry answers work', async () => {
    const dir = tmpDir('sdlc-e2e2-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('implement') || spec.prompt.includes('Additional')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'ok' }; }
        if (spec.prompt.includes('review')) return { subtype: 'error_max_turns' as const, text: '' };
        return { text: 'ok' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    let t = app.store.getTask(task.id)!;
    // review failed with error_max_turns → no on_fail on review in auto → escalation HIL
    expect(t.status).toBe('waiting_hil');
    const hil = app.store.openHilForTask(t.id)[0]!;
    expect(hil.kind).toBe('escalation');
    expect(hil.allowedDecisions).toContain('skip');
    await app.engine.respondHil(hil.id, { decision: 'skip' }, 'cli');
    await app.engine.advance(t.id);
    t = app.store.getTask(task.id)!;
    expect(t.status).toBe('succeeded');
  });
});
