import { describe, it, expect } from 'vitest';
import { normalizeVerdict } from '../../server/src/phases/claude.js';

const qa = (verdict: string, severities: string[]) => ({
  verdict, summary: 's', checks: [{ name: 'n', method: 'm', result: 'ok' }],
  issues: severities.map((severity, i) => ({ severity, title: `t${i}`, description: 'd' })),
});

describe('normalizeVerdict: the QA verdict follows its issues', () => {
  it('a blocking or should_fix issue means `issues`, whatever the model wrote', () => {
    for (const written of ['pass', 'issues', 'skipped']) {
      expect(normalizeVerdict(qa(written, ['should_fix'])).verdict).toBe('issues');
      expect(normalizeVerdict(qa(written, ['nit', 'blocking'])).verdict).toBe('issues');
    }
  });

  it('nit-only issues never gate: `issues` is downgraded to `pass`', () => {
    expect(normalizeVerdict(qa('issues', ['nit'])).verdict).toBe('pass');
    expect(normalizeVerdict(qa('issues', ['nit', 'nit'])).verdict).toBe('pass');
    expect(normalizeVerdict(qa('pass', ['nit'])).verdict).toBe('pass');
    expect(normalizeVerdict(qa('skipped', ['nit'])).verdict).toBe('skipped');   // a skipped QA is not turned into a pass
  });

  it('`issues` with nothing listed is kept: the human still sees it', () => {
    expect(normalizeVerdict(qa('issues', [])).verdict).toBe('issues');
    expect(normalizeVerdict(qa('pass', [])).verdict).toBe('pass');
    expect(normalizeVerdict(qa('skipped', [])).verdict).toBe('skipped');
  });

  it('keeps the rest of the output, and leaves other shapes alone', () => {
    const out = normalizeVerdict(qa('pass', ['blocking']));
    expect(out).toEqual(qa('issues', ['blocking']));
    const test = { verdict: 'pass', summary: 's', failures: [], commands: [], tests_added: [], notes: '' };
    expect(normalizeVerdict(test)).toBe(test);
    expect(normalizeVerdict(null)).toBe(null);
    expect(normalizeVerdict('x')).toBe('x');
    expect(normalizeVerdict({ verdict: 'issues', issues: 'not an array' })).toEqual({ verdict: 'issues', issues: 'not an array' });
  });
});

const review = (verdict: string, severities: string[]) => ({
  verdict, summary: 's', findings: severities.map((severity, i) => ({ severity, title: `t${i}`, description: 'd', file: 'a.ts', line: i + 1 })),
});

describe('normalizeVerdict: the review verdict follows its findings', () => {
  it('a blocking or should_fix finding means `request_changes`: a review never approves one', () => {
    expect(normalizeVerdict(review('approve', ['should_fix']))).toEqual(review('request_changes', ['should_fix']));
    expect(normalizeVerdict(review('approve', ['nit', 'blocking'])).verdict).toBe('request_changes');
    expect(normalizeVerdict(review('request_changes', ['should_fix'])).verdict).toBe('request_changes');
  });

  it('nit-only findings approve; `request_changes` with nothing listed is kept', () => {
    expect(normalizeVerdict(review('request_changes', ['nit'])).verdict).toBe('approve');
    expect(normalizeVerdict(review('approve', ['nit'])).verdict).toBe('approve');
    expect(normalizeVerdict(review('approve', [])).verdict).toBe('approve');
    expect(normalizeVerdict(review('request_changes', [])).verdict).toBe('request_changes');
  });
});
