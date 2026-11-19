import { describe, it, expect } from 'vitest';
import { statusView } from '../../ui/src/pages/Dashboard.js';

/** The dashboard chip: what a task's status reads as, including GitHub's review verdict on an open PR. */
describe('statusView', () => {
  it('shows an approved open PR as its own chip, with a title saying it is not merged yet', () => {
    const v = statusView({ status: 'pr_open', prNumber: 3, reviewDecision: 'APPROVED' });
    expect(v.cls).toBe('approved');
    expect(v.label).toBe('approved');
    expect(v.title).toMatch(/approved on GitHub/);
    expect(v.title).toMatch(/not merged/);
  });

  it('leaves a pr_open task alone for every other review decision', () => {
    for (const d of [null, undefined, '', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'approved']) {
      expect(statusView({ status: 'pr_open', prNumber: 3, reviewDecision: d as string | null })).toEqual({ cls: 'pr_open', label: 'pr_open' });
    }
  });

  it('never calls a task approved outside pr_open, whatever is stored on it', () => {
    for (const status of ['running', 'waiting_hil', 'merged', 'closed', 'failed', 'aborted', 'paused']) {
      expect(statusView({ status, prNumber: 3, reviewDecision: 'APPROVED' })).toEqual({ cls: status, label: status });
    }
    // succeeded without a PR keeps its own label; a stored decision does not shadow it
    expect(statusView({ status: 'succeeded', prNumber: null, reviewDecision: 'APPROVED' })).toMatchObject({ cls: 'ready', label: 'ready to land' });
  });

  it('works for a child task, which carries no review decision at all', () => {
    expect(statusView({ status: 'pr_open', prNumber: 1 })).toEqual({ cls: 'pr_open', label: 'pr_open' });
  });
});
