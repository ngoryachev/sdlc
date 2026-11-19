import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { renderBody, renderTemplate } from '../../server/src/pipeline/template.js';
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

/**
 * The pull request body quotes free-form text verbatim, so dropping an empty link line must never reach into it: a
 * blank line inside a fenced code block of the prompt is content (two between two functions is what PEP 8 asks for).
 */
describe('renderBody', () => {
  const OWN = ['task.jira_url', 'task.branch_url'];
  const tpl = ['prelude', '', '{{task.prompt}}', '', '{{task.jira_url?}}', '{{task.branch_url?}}', '', '---', 'footer', ''].join('\n');
  const CODE = ['```python', 'def f():', '    pass', '', '', 'def g():', '    pass', '```'].join('\n');
  const ctx = (jira: string, branch: string, prompt = 'do x') => ({ task: { prompt, jira_url: jira, branch_url: branch } });
  const withoutLinks = ['prelude', '', 'do x', '', '---', 'footer', ''].join('\n');

  it('drops the whole block and its separator when neither link has anything to show', () => {
    expect(renderBody(tpl, ctx('', ''), OWN)).toBe(withoutLinks);
    // byte-identical to the same template without those lines at all
    expect(renderBody(tpl.replace('{{task.jira_url?}}\n{{task.branch_url?}}\n\n', ''), ctx('', ''), OWN)).toBe(withoutLinks);
  });

  it('keeps the block, blank lines and all, when a single link has something to show', () => {
    expect(renderBody(tpl, ctx('J', ''), OWN)).toBe(['prelude', '', 'do x', '', 'J', '', '---', 'footer', ''].join('\n'));
    expect(renderBody(tpl, ctx('', 'B'), OWN)).toBe(['prelude', '', 'do x', '', 'B', '', '---', 'footer', ''].join('\n'));
    expect(renderBody(tpl, ctx('J', 'B'), OWN)).toBe(['prelude', '', 'do x', '', 'J', 'B', '', '---', 'footer', ''].join('\n'));
  });

  it('never touches the text it substitutes: blank lines inside a quoted code block survive', () => {
    for (const links of [['', ''], ['J', 'B']] as const) {
      const body = renderBody(tpl, ctx(links[0], links[1], CODE), OWN);
      expect(body).toContain(CODE);
      expect(body).toContain('    pass\n\n\ndef g():');
    }
  });

  it('leaves every other optional line rendering as the empty line it always did', () => {
    const other = ['a', '', '{{task.nothing?}}', '', 'b'].join('\n');
    expect(renderBody(other, ctx('', ''), OWN)).toBe(renderTemplate(other, ctx('', '')));
    // a line that mixes a named variable with other text is not the block's either
    const mixed = ['a', '', 'Jira: {{task.jira_url?}}', '', 'b'].join('\n');
    expect(renderBody(mixed, ctx('', ''), OWN)).toBe(['a', '', 'Jira: ', '', 'b'].join('\n'));
  });

  /**
   * A custom body template (the README invites one to use these variables) may put a link next to another variable on
   * one line. Only the named variables are the block's: a line that also carries other content must survive.
   */
  it('leaves a line alone when it mixes a link variable with another variable', () => {
    const c = { task: { id: 't_1', branch: 'sdlc/x', prompt: 'p', jira_url: '', branch_url: 'https://gh/tree/x' } };
    expect(renderBody(['head', '', '{{task.jira_url?}} {{task.id}}', '', 'tail'].join('\n'), c, OWN))
      .toBe(['head', '', ' t_1', '', 'tail'].join('\n'));
    expect(renderBody(['head', '', '{{task.branch}}{{task.jira_url?}}', '', 'tail'].join('\n'), c, OWN))
      .toBe(['head', '', 'sdlc/x', '', 'tail'].join('\n'));
  });

  /** The other shapes of "not only the named variables": another optional variable, or both links sharing one line. */
  it('tells a line of nothing but links from one that carries anything else', () => {
    const c = { task: { id: 't_1', prompt: 'p', jira_url: '', branch_url: '' }, artifacts: { plan_md: 'PLAN' } };
    // a non-owned optional variable keeps the line, even though the link next to it is empty
    expect(renderBody(['a', '', '{{task.jira_url?}}{{artifacts.plan_md?}}', '', 'b'].join('\n'), c, OWN))
      .toBe(['a', '', 'PLAN', '', 'b'].join('\n'));
    // both links on one line are still the block's: it vanishes with its separator when neither shows
    expect(renderBody(['a', '', '{{task.jira_url?}} {{task.branch_url?}}', '', 'b'].join('\n'), c, OWN)).toBe(['a', '', 'b'].join('\n'));
    expect(renderBody(['a', '', '{{task.jira_url?}} {{task.branch_url?}}', '', 'b'].join('\n'), { ...c, task: { ...c.task, jira_url: 'J' } }, OWN))
      .toBe(['a', '', 'J ', '', 'b'].join('\n'));
  });

  it('takes the preceding blank line only when the block ends the template', () => {
    expect(renderBody(['a', '', '{{task.jira_url?}}'].join('\n'), ctx('', ''), OWN)).toBe('a');
    expect(renderBody(['a', '', '{{task.jira_url?}}'].join('\n'), ctx('J', ''), OWN)).toBe('a\n\nJ');
    // text follows straight after the block: the blank line before it belongs to that paragraph, not to the block
    expect(renderBody(['head', '', '{{task.jira_url?}}', 'footer'].join('\n'), ctx('', ''), OWN)).toBe(['head', '', 'footer'].join('\n'));
    expect(renderBody(['head', '', '{{task.jira_url?}}', 'footer'].join('\n'), ctx('J', ''), OWN)).toBe(['head', '', 'J', 'footer'].join('\n'));
  });

  /** The other positions a block can sit in, which the shipped template does not exercise. */
  it('drops the block wherever it sits: first line, only line, alone before a blank line', () => {
    expect(renderBody(['{{task.jira_url?}}', 'footer'].join('\n'), ctx('', ''), OWN)).toBe('footer');
    expect(renderBody(['{{task.jira_url?}}', '', 'footer'].join('\n'), ctx('', ''), OWN)).toBe('footer');
    expect(renderBody('{{task.jira_url?}}', ctx('', ''), OWN)).toBe('');
    // a template file ends with a newline: the trailing empty line is the separator, the blank line before stays
    expect(renderBody(['a', '', '{{task.jira_url?}}', ''].join('\n'), ctx('', ''), OWN)).toBe('a\n');
  });

  /** The template actually shipped, rather than a stand-in for it: without links its body must not move a byte. */
  it('leaves the shipped prompts/pr_body.md identical to today when neither link exists', () => {
    const shipped = fs.readFileSync(new URL('../../prompts/pr_body.md', import.meta.url), 'utf8');
    const c = { task: { id: 't_1', branch: 'sdlc/x', cost_usd: '0.10', prompt: 'do x', jira_url: '', branch_url: '' }, phases: {}, artifacts: {} };
    const asBefore = shipped.replace('{{task.jira_url?}}\n{{task.branch_url?}}\n\n', '');
    expect(renderBody(shipped, c, OWN)).toBe(renderTemplate(asBefore, c));
    // and with both it carries them on their own lines, right above the footer rule
    const both = { task: { ...c.task, jira_url: 'https://j/browse/ABC-1', branch_url: 'https://gh/o/r/tree/b' } };
    expect(renderBody(shipped, both, OWN)).toContain('\nhttps://j/browse/ABC-1\nhttps://gh/o/r/tree/b\n\n---\n');
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
