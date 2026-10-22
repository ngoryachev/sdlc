import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { namingPrompt } from '../../server/src/engine/engine.js';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * Prompts whose output leaves the machine: a phase that writes in the language of the developer's
 * settings puts that language on the pull request. Every one of them states the English rule itself,
 * on top of the global rule in prompts/system/common.md.
 */
const PUBLISHED: Record<string, string> = {
  'prompts/clarify.md': 'title becomes the PR title, suggestedPrompt the task text in the PR body',
  'prompts/plan.md': '.sdlc/plan.md is included in the PR body',
  'prompts/implement.md': 'the final message is the PR body and the answer to review feedback',
  'prompts/implement_direct.md': 'same, for pipelines without a separate plan phase',
  'prompts/test.md': 'structured.summary is included in the PR body',
  'prompts/review.md': 'summary and findings are posted on the PR',
  'prompts/review_line.md': 'summary and findings are posted as inline PR comments',
  'prompts/qa.md': 'the whole report is posted as a PR comment',
};

/** Prompts whose output stays inside sdlc; the rule in common.md still covers them. */
const UNPUBLISHED = ['prompts/self_check.md'];

/** Not phase prompts but the bodies published verbatim: they are checked by what they interpolate. */
const BODIES = ['prompts/pr_body.md', 'prompts/qa_comment.md'];

describe('prompt language rule', () => {
  it('common.md requires English for everything a phase produces', () => {
    const s = read('prompts/system/common.md');
    expect(s).toMatch(/Language:/);
    expect(s).toMatch(/\*\*English\*\*/);
    expect(s).toMatch(/settings/);           // the rule beats a configured "always answer in <language>"
    expect(s).toMatch(/Translate/);          // and says where a human gets their own language
    expect(s).not.toMatch(/in the language of the developer's request/);
  });

  it.each(Object.entries(PUBLISHED))('%s states the rule (%s)', (file) => {
    const s = read(file);
    expect(s).toMatch(/Language: write .*\bin English\b/);
    expect(s).toMatch(/\bpublished\b|\bpull request title\b/);
    expect(s).toMatch(/settings/);
  });

  it('classifies every phase prompt, so a new one has to decide', () => {
    const all = fs.readdirSync(path.join(root, 'prompts')).filter((f) => f.endsWith('.md') && !BODIES.includes(`prompts/${f}`));
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect([...Object.keys(PUBLISHED), ...UNPUBLISHED]).toContain(`prompts/${f}`);
  });

  it('the title of a task written in Russian is still asked for in English', () => {
    // task.title is the pull request title; the UI task list is the only other place it shows
    const p = namingPrompt('Починить падающий тест');
    expect(p).toMatch(/title:.*\bin English\b/);
    expect(p).not.toMatch(/Russian/);
  });

  it('PR and comment templates only quote phases that carry the rule', () => {
    // the developer's own prompt is their text, in their language; everything a phase wrote must be English
    const own = new Set(['task', 'hil', 'repo', 'loop', 'recheck']);
    const owners: Record<string, string> = { plan_md: 'prompts/plan.md' };
    for (const f of BODIES) {
      for (const [, ref] of read(f).matchAll(/\{\{\s*([\w.]+)\??\s*\}\}/g)) {
        const [kind, name] = ref.split('.');
        if (own.has(kind!)) continue;
        if (kind === 'artifacts') {
          expect(Object.keys(PUBLISHED), `${f}: artifact ${name}`).toContain(owners[name!]);
          continue;
        }
        expect(kind, `${f}: unexpected template root in a published body`).toBe('phases');
        expect(Object.keys(PUBLISHED).map((p) => path.basename(p, '.md')), `${f}: phase ${name}`).toContain(name);
      }
    }
  });
});
