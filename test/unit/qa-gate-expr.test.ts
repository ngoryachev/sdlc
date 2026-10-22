import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sdlcRoot } from '../../server/src/config/config.js';
import { loadPipeline } from '../../server/src/pipeline/loader.js';
import { evalExpr } from '../../server/src/pipeline/expr.js';
import { normalizeVerdict } from '../../server/src/phases/claude.js';

/**
 * The gate is the pair (normalized QA verdict, `when` of qa_gate). The rule lives in the code, so the
 * expression must stay the one a run created before the rule carries in its pipeline snapshot — these tests
 * pin both halves together, and fail if the rule is ever moved into `when` (where old snapshots would miss it).
 */
const OLD_GATE = "phases.qa.structured.verdict == 'issues'";

const pipelineDir = path.join(sdlcRoot(), 'pipelines');
const pipelines = fs.readdirSync(pipelineDir).filter((f) => f.endsWith('.yaml'))
  .map((f) => ({ name: f, spec: loadPipeline(path.join(pipelineDir, f)).spec }));

const qa = (verdict: string, severities: string[]) => ({
  verdict, summary: 's', checks: [],
  issues: severities.map((severity, i) => ({ severity, title: `t${i}`, description: 'd' })),
});
/** What a snapshot taken before this change does with a QA output that went through the executor. */
const opens = (verdict: string, severities: string[]) =>
  evalExpr(OLD_GATE, { phases: { qa: { structured: normalizeVerdict(qa(verdict, severities)) } } });

describe('qa_gate in the shipped pipelines', () => {
  it('loads at least one qa_gate, and every one of them still carries the pre-change expression', () => {
    const gates = pipelines.flatMap(({ name, spec }) => spec.phases.filter((p) => p.name === 'qa_gate').map((p) => ({ name, when: p.when })));
    expect(gates.length).toBeGreaterThan(0);
    for (const g of gates) expect(g.when, g.name).toBe(OLD_GATE);   // the YAML comment is not part of the quoted value
  });

  it('qa_gate is the only place any pipeline reads the QA verdict', () => {
    const readers = pipelines.flatMap(({ name, spec }) => spec.phases
      .filter((p) => [p.when, (p as { fail_if?: string }).fail_if].some((e) => e?.includes('phases.qa.structured.verdict')))
      .map((p) => `${name}:${p.name}`));
    expect(readers.length).toBeGreaterThan(0);
    for (const r of readers) expect(r.endsWith(':qa_gate'), r).toBe(true);
  });

  it('the best-effort qa phase never fails its run, so an upgraded verdict cannot break a pipeline without a gate', () => {
    for (const { name, spec } of pipelines) {
      const p = spec.phases.find((x) => x.name === 'qa');
      if (!p) continue;
      expect((p as { fail_if?: string }).fail_if, name).toBeUndefined();
      expect(p.on_fail?.then, name).toBe('continue');
    }
  });
});

describe('an old snapshot gates on the severity of the QA issues', () => {
  it('opens on a blocking or should_fix issue, whatever verdict the model wrote', () => {
    for (const written of ['pass', 'issues', 'skipped']) {
      expect(opens(written, ['should_fix']), written).toBe(true);
      expect(opens(written, ['blocking']), written).toBe(true);
      expect(opens(written, ['nit', 'should_fix']), written).toBe(true);
    }
  });

  it('stays shut on nit-only issues and on a clean QA', () => {
    expect(opens('issues', ['nit'])).toBe(false);
    expect(opens('issues', ['nit', 'nit'])).toBe(false);
    expect(opens('pass', ['nit'])).toBe(false);
    expect(opens('skipped', ['nit'])).toBe(false);
    expect(opens('pass', [])).toBe(false);
    expect(opens('skipped', [])).toBe(false);
  });

  it('opens on `issues` with nothing listed: a problem reported but not named', () => {
    expect(opens('issues', [])).toBe(true);
  });
});
