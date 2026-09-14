import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PipelineSchema } from '../../server/src/pipeline/schema.js';
import { loadPipeline } from '../../server/src/pipeline/loader.js';
import { sdlcRoot } from '../../server/src/config/config.js';

describe('PipelineSchema', () => {
  it('loads the shipped pipelines', () => {
    for (const n of ['standard', 'quick', 'auto']) {
      const lp = loadPipeline(path.join(sdlcRoot(), 'pipelines', `${n}.yaml`));
      expect(lp.spec.phases.length).toBeGreaterThan(2);
    }
  });
  it('rejects duplicate names and dangling references', () => {
    const bad = { name: 'x', phases: [{ name: 'a', type: 'shell', command: 'true', on_fail: { back_to: 'zzz' } }, { name: 'a', type: 'shell', command: 'true' }] };
    const r = PipelineSchema.safeParse(bad);
    expect(r.success).toBe(false);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message).join(' ');
    expect(msgs).toMatch(/duplicate/); expect(msgs).toMatch(/unknown phase: zzz/);
  });
  it('rejects unknown keys', () => {
    expect(PipelineSchema.safeParse({ name: 'x', phases: [{ name: 'a', type: 'shell', command: 'true', bogus: 1 }] }).success).toBe(false);
  });
});
