import { describe, it, expect } from 'vitest';
import { normalizeStrings, resolveModel } from '../../server/src/phases/claude.js';
import { branchNameFor, isSdlcBranch } from '../../server/src/git/git.js';

describe('resolveModel', () => {
  const cfg = { default: 'sonnet', effort: 'medium' as const, phases: { review: { model: 'opus', effort: 'high' as const } } };
  it('task override beats config beats pipeline', () => {
    expect(resolveModel('review', { phaseModel: 'p', phaseEffort: 'low' }, cfg, { review: { model: 'haiku' } })).toEqual({ model: 'haiku', effort: 'high' });
    expect(resolveModel('review', { phaseModel: 'p', phaseEffort: 'low' }, cfg, null)).toEqual({ model: 'opus', effort: 'high' });
    expect(resolveModel('plan', { phaseModel: 'p', phaseEffort: 'low' }, cfg, null)).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(resolveModel('plan', { phaseModel: 'p', phaseEffort: 'low' }, { phases: {} }, null)).toEqual({ model: 'p', effort: 'low' });
    expect(resolveModel('plan', { phaseModel: 'p' }, { phases: {} }, { '*': { effort: 'max' } })).toEqual({ model: 'p', effort: 'max' });
  });
});

describe('normalizeStrings', () => {
  it('turns literal \\n into newlines only when the string has no real newlines', () => {
    expect(normalizeStrings({ summary: 'a\\nb\\n\\nc', list: ['x\\ty'], keep: 'real\nnewline\\n', n: 1 })).toEqual({ summary: 'a\nb\n\nc', list: ['x\ty'], keep: 'real\nnewline\\n', n: 1 });
    expect(normalizeStrings(null)).toBeNull();
  });
});

describe('branchNameFor', () => {
  it('keeps at most five lowercase english words and the id; non-latin summaries fall back to the id', () => {
    expect(branchNameFor('Add playToEnd flag so traps play to the key move', 't_1')).toBe('sdlc/add-playtoend-flag-so-traps-t_1');
    expect(branchNameFor('play-lines-to-end', 't_2')).toBe('sdlc/play-lines-to-end-t_2');
    expect(branchNameFor('Сделать до конца', 't_3')).toBe('sdlc/t_3');
    expect(isSdlcBranch('sdlc/t_3', 't_3')).toBe(true); expect(isSdlcBranch('sdlc/x-t_3', 't_3')).toBe(true); expect(isSdlcBranch('feature/x', 't_3')).toBe(false);
    expect(branchNameFor('Add playToEnd flag', 't_1', null)).toBe('sdlc/add-playtoend-flag-t_1');
  });

  it('puts an issue key in front of the slug, with its case, and leaves the 40-char cap on the slug', () => {
    expect(branchNameFor('Add a flag so traps play to the end', 't_1', 'ABC-123')).toBe('sdlc/ABC-123-add-a-flag-so-traps-t_1');
    expect(branchNameFor('Сделать до конца', 't_3', 'ABC-123')).toBe('sdlc/ABC-123-t_3');
    expect(branchNameFor('', 't_3', 'ABC-123')).toBe('sdlc/ABC-123-t_3');
    // the cap counts the slug only: the same five long words are cut at the same word with and without a key
    const long = 'extraordinarily verbose summary describing everything precisely';
    expect(branchNameFor(long, 't_9')).toBe('sdlc/extraordinarily-verbose-summary-t_9');
    expect(branchNameFor(long, 't_9', 'PROJ-1')).toBe('sdlc/PROJ-1-extraordinarily-verbose-summary-t_9');
    expect(isSdlcBranch('sdlc/ABC-123-some-slug-t_x', 't_x')).toBe(true);
    expect(isSdlcBranch('sdlc/ABC-123-t_x', 't_x')).toBe(true);
    expect(isSdlcBranch('sdlc/ABC-123-some-slug-t_y', 't_x')).toBe(false);
  });
});
