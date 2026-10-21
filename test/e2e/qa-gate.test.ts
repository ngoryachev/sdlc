import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, sh, testApp, tmpDir } from '../helpers.js';

type Severity = 'blocking' | 'should_fix' | 'nit';
const qaOutput = (verdict: string, severities: Severity[]) => ({
  verdict, summary: 'exercised the change', checks: [{ name: 'smoke', method: 'curl /', result: 'ok' }],
  issues: severities.map((severity, i) => ({ severity, title: `issue ${i}`, description: 'expected x, got y' })),
});

/** Run only the QA tail of `quick` (qa → qa_report → qa_gate) on a branch that already has the change. */
async function runQaTail(name: string, qa: Record<string, unknown>) {
  const dir = tmpDir(`sdlc-qa-gate-${name}-`);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  sh(repo, ['checkout', '-q', '-b', 'done']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'y\n');
  sh(repo, ['commit', '-q', '-am', 'flip a to y']);
  sh(repo, ['checkout', '-q', 'main']);
  const app = testApp(dir, new FakeRunner(() => ({ act: () => ({ structured: qa }) })));
  const task = await app.engine.createTask({ prompt: 'flip a', repoPath: repo, pipeline: 'quick', baseRemote: null, branch: 'done', startAt: 'qa' });
  await app.engine.advance(task.id);
  const t = app.store.getTask(task.id)!;
  const gate = app.store.phaseRunsForTask(t.id).find((p) => p.phaseName === 'qa_gate');
  const hil = app.store.openHilForTask(t.id)[0] ?? null;
  const stored = app.store.phaseRunsForTask(t.id).find((p) => p.phaseName === 'qa')!.structuredOutput as { verdict: string };
  return { task: t, gate, hil, verdict: stored.verdict };
}

describe('qa_gate opens on the severity of the QA issues, not on the verdict the model wrote', () => {
  it('verdict pass with one should_fix issue opens the gate', async () => {
    const { task, gate, hil, verdict } = await runQaTail('shouldfix', qaOutput('pass', ['nit', 'should_fix']));
    expect(verdict).toBe('issues');                      // normalized: the issues decide
    expect(gate!.status).toBe('waiting_hil');
    expect(task.status).toBe('waiting_hil');
    expect(hil!.kind).toBe('approve_result');
    // the human decides on the QA issues (not on the review findings), and gets both of them to pick from
    expect(hil!.payload).toMatchObject({ kind: 'approve_result', focus: 'qa' });
    expect(hil!.payload.kind === 'approve_result' ? hil!.payload.qa!.issues.map((i) => i.severity) : []).toEqual(['nit', 'should_fix']);
  });

  it('nit-only issues do not open the gate, even when the model said issues', async () => {
    const { task, gate, hil, verdict } = await runQaTail('nit', qaOutput('issues', ['nit', 'nit']));
    expect(verdict).toBe('pass');
    expect(gate!.status).toBe('skipped');
    expect(task.status).toBe('succeeded');
    expect(hil).toBe(null);
  });

  it('verdict issues with nothing listed still opens the gate: a problem reported but not named', async () => {
    const { task, gate, verdict } = await runQaTail('empty', qaOutput('issues', []));
    expect(verdict).toBe('issues');
    expect(gate!.status).toBe('waiting_hil');
    expect(task.status).toBe('waiting_hil');
  });

  it('a blocking issue on a skipped QA opens the gate too', async () => {
    const { gate, verdict } = await runQaTail('skipped', qaOutput('skipped', ['blocking']));
    expect(verdict).toBe('issues');
    expect(gate!.status).toBe('waiting_hil');
  });

  it('verdict pass with nit-only issues does not open the gate either', async () => {
    const { task, gate, hil, verdict } = await runQaTail('passnit', qaOutput('pass', ['nit']));
    expect(verdict).toBe('pass');
    expect(gate!.status).toBe('skipped');
    expect(task.status).toBe('succeeded');
    expect(hil).toBe(null);
  });

  it('the checkpoint the human sees carries the normalized verdict, and QA issues are never published', async () => {
    const { hil } = await runQaTail('summary', qaOutput('pass', ['blocking', 'nit']));
    expect(hil!.summary).toContain('qa: issues (2 issue(s))');            // not the `pass` the model wrote
    // canFix is false only because this harness starts the task at `qa`, so `implement` is outside its segment
    expect(hil!.payload).toMatchObject({ kind: 'approve_result', focus: 'qa', canPost: false });
  });
});
