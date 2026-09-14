import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../server/src/pipeline/template.js';
import { evalExpr } from '../../server/src/pipeline/expr.js';

describe('renderTemplate', () => {
  const ctx = { task: { id: 't1', prompt: 'do x' }, phases: { test: { output: 'FAIL', structured: { verdict: 'approve', n: 2 } } }, repo: { test_command: '' } };
  it('substitutes paths and pretty-prints objects', () => {
    expect(renderTemplate('{{task.id}}: {{ task.prompt }}', ctx)).toBe('t1: do x');
    expect(renderTemplate('{{phases.test.structured}}', ctx)).toContain('"verdict": "approve"');
  });
  it('throws on unknown unless optional', () => {
    expect(() => renderTemplate('{{nope.x}}', ctx)).toThrow(/unknown variable/);
    expect(renderTemplate('a{{nope.x?}}b', ctx)).toBe('ab');
  });
});

describe('evalExpr', () => {
  const ctx = { repo: { test_command: 'npm test', lint: '' }, structured: { verdict: 'request_changes', findings: [] } };
  it('truthiness, comparisons, logic', () => {
    expect(evalExpr('repo.test_command', ctx)).toBe(true);
    expect(evalExpr('repo.lint', ctx)).toBe(false);
    expect(evalExpr('!repo.lint', ctx)).toBe(true);
    expect(evalExpr("structured.verdict == 'request_changes'", ctx)).toBe(true);
    expect(evalExpr("structured.verdict != 'request_changes'", ctx)).toBe(false);
    expect(evalExpr("structured.verdict == 'approve' || repo.test_command", ctx)).toBe(true);
    expect(evalExpr("(structured.verdict == 'approve') && repo.test_command", ctx)).toBe(false);
    expect(evalExpr('structured.findings', ctx)).toBe(false);
    expect(evalExpr('missing.path', ctx)).toBe(false);
  });
  it('rejects garbage', () => { expect(() => evalExpr('a == ', ctx)).toThrow(); expect(() => evalExpr('a $ b', ctx)).toThrow(); });
});
