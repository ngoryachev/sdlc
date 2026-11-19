import { describe, it, expect } from 'vitest';
import { defaultReviewEvent, type HilPayload, type ReviewFinding } from '@sdlc/shared';

const finding = (severity: ReviewFinding['severity']): ReviewFinding => ({ severity, title: 't', description: 'd' });
const checkpoint = (verdict: 'approve' | 'request_changes', findings: ReviewFinding[], focus: 'review' | 'qa' = 'review'): HilPayload => ({
  kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, qa: null, commits: [], branch: 'b',
  review: { verdict, summary: 's', findings }, focus, canFix: false, canPost: true, role: 'reviewer',
});

describe('defaultReviewEvent: the GitHub event a review checkpoint proposes', () => {
  it('follows an approve verdict when the findings are only nits (PR #1565: one nit, skipped, approval lost)', () => {
    expect(defaultReviewEvent(checkpoint('approve', []))).toBe('approve');
    expect(defaultReviewEvent(checkpoint('approve', [finding('nit')]))).toBe('approve');
    expect(defaultReviewEvent(checkpoint('approve', [finding('nit'), finding('nit')]))).toBe('approve');
  });

  it('does not approve by default when a finding is should_fix or blocking, whatever the verdict', () => {
    expect(defaultReviewEvent(checkpoint('approve', [finding('should_fix')]))).toBe('comment');
    expect(defaultReviewEvent(checkpoint('approve', [finding('nit'), finding('blocking')]))).toBe('comment');
  });

  it('stays `comment` for a request_changes verdict and outside a review focus', () => {
    expect(defaultReviewEvent(checkpoint('request_changes', [finding('blocking')]))).toBe('comment');
    expect(defaultReviewEvent(checkpoint('approve', [], 'qa'))).toBe('comment');
    expect(defaultReviewEvent({ kind: 'question', questions: [] })).toBe('comment');
  });
});
