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
        if (spec.prompt.includes('Phase: implement') || spec.prompt.includes('test phase found defects')) {
          implementCalls++;
          const f = path.join(spec.cwd, 'src/math.js');
          if (implementCalls === 1) {
            // first attempt: wrong fix (does not throw) → tests fail
            fs.writeFileSync(f, 'export function divide(a, b) { if (b === 0) return NaN; return a / b; }\n');
            fs.mkdirSync(path.join(spec.cwd, '.sdlc'), { recursive: true }); fs.writeFileSync(path.join(spec.cwd, '.sdlc/plan.md'), '# plan\n');
            return { text: 'implemented (wrong)', cost: 0.5, toolCalls: [{ name: 'Edit', input: { file_path: f } }] };
          }
          expect(spec.resume).toBe('fake-session-1'); // back_to resumes the implement session
          expect(spec.prompt).toMatch(/test phase found defects/);
          expect(spec.prompt).toMatch(/no throw on zero/);
          fs.writeFileSync(f, 'export function divide(a, b) { if (b === 0) throw new Error("div by zero"); return a / b; }\n');
          return { text: 'fixed', cost: 0.3 };
        }
        if (spec.prompt.includes('Phase: test')) {
          // agentic test phase: run the suite and report a verdict
          try { execFileSync('node', ['test.js'], { cwd: spec.cwd, stdio: 'pipe' }); return { structured: { verdict: 'pass', summary: 'suite passes', commands: ['node test.js'], tests_added: [], failures: [], notes: '' }, cost: 0.1 }; }
          catch { return { structured: { verdict: 'fail', summary: 'divide(1,0) does not throw', commands: ['node test.js'], tests_added: [], failures: [{ title: 'no throw on zero', description: 'expected throw, got NaN', file: 'src/math.js', line: 1 }], notes: '' }, cost: 0.1 }; }
        }
        if (spec.prompt.includes('Phase: review')) {
          return { text: 'reviewed', structured: { verdict: 'approve', summary: 'Looks right.', findings: [] }, cost: 0.2 };
        }
        if (spec.prompt.includes('Phase: QA')) return { structured: { verdict: 'pass', summary: 'ok', checks: [], issues: [] }, cost: 0.1 };
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
    expect(seen).toEqual(['implement:succeeded', 'commit_impl:succeeded', 'test:failed', 'implement:succeeded', 'commit_impl:succeeded', 'test:succeeded', 'commit_tests:succeeded', 'review:succeeded', 'qa:succeeded']);
    expect(implementCalls).toBe(2);
    expect(t.totalCostUsd).toBeCloseTo(1.3, 5);

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

  it('auto: a failing review gets one implement round, then the task continues without a checkpoint', async () => {
    const dir = tmpDir('sdlc-e2e2-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner((spec) => ({
      act: () => {
        if (spec.prompt.includes('Phase: implement') || spec.prompt.includes('reviewer requested changes')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'ok' }; }
        if (spec.prompt.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'nothing to test', commands: [], tests_added: [], failures: [], notes: '' } };
        if (spec.prompt.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
        if (spec.prompt.includes('Phase: review')) return { structured: { verdict: 'request_changes', summary: 'no', findings: [{ severity: 'should_fix', title: 'x', description: 'y' }] } };
        return { text: 'ok' };
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'auto', baseRemote: null });
    await app.engine.advance(task.id);
    const t = app.store.getTask(task.id)!;
    expect(t.status).toBe('succeeded');
    const runs = app.store.phaseRunsForTask(t.id);
    expect(runs.filter((p) => p.phaseName === 'review').map((p) => p.status)).toEqual(['failed', 'failed']);
    expect(runs.filter((p) => p.phaseName === 'implement').length).toBe(2);
    expect(runs.find((p) => p.phaseName === 'qa')!.status).toBe('succeeded');
    expect(app.store.openHilForTask(t.id)).toEqual([]);
  });
});
