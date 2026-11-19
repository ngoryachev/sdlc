import { describe, it, expect } from 'vitest';
import { defaultFindingActions, type HilPayload, type QaOutput, type ReviewFinding, type TaskRole } from '@sdlc/shared';

const finding = (severity: ReviewFinding['severity']): ReviewFinding => ({ severity, title: 't', description: 'd' });
const issue = (severity: QaOutput['issues'][number]['severity']): QaOutput['issues'][number] => ({ severity, title: 't', description: 'd' });
const checkpoint = (o: { role: TaskRole; canFix?: boolean; canPost?: boolean; findings?: ReviewFinding[]; focus?: 'review' | 'qa'; issues?: QaOutput['issues'] }): HilPayload => ({
  kind: 'approve_result', diffStat: '', diff: '', testOutput: null, test: null, commits: [], branch: 'b',
  review: { verdict: 'request_changes', summary: 's', findings: o.findings ?? [] },
  qa: o.issues ? { verdict: 'issues', summary: 's', checks: [], issues: o.issues } : null,
  focus: o.focus ?? 'review', canFix: o.canFix ?? false, canPost: o.canPost ?? false, role: o.role,
});

describe('defaultFindingActions: what a result checkpoint proposes before the human touches it', () => {
  it('posts every finding but a nit for a reviewer that can post', () => {
    const p = checkpoint({ role: 'reviewer', canPost: true, findings: [finding('nit'), finding('should_fix'), finding('blocking')] });
    expect(defaultFindingActions(p, null)).toEqual({ 'review:0': 'skip', 'review:1': 'post', 'review:2': 'post' });
  });

  it('skips everything for a reviewer without a PR to post to', () => {
    const p = checkpoint({ role: 'reviewer', canPost: false, findings: [finding('nit'), finding('blocking')] });
    expect(defaultFindingActions(p, null)).toEqual({ 'review:0': 'skip', 'review:1': 'skip' });
  });

  it('keeps the author default: fix real defects, skip nits', () => {
    const p = checkpoint({ role: 'author', canFix: true, findings: [finding('nit'), finding('should_fix'), finding('blocking')] });
    expect(defaultFindingActions(p, null)).toEqual({ 'review:0': 'skip', 'review:1': 'fix', 'review:2': 'fix' });
    const noFix = checkpoint({ role: 'author', canFix: false, findings: [finding('blocking')] });
    expect(defaultFindingActions(noFix, null)).toEqual({ 'review:0': 'skip' });
  });

  it('keeps the QA focus default, keyed by qa index', () => {
    const p = checkpoint({ role: 'author', canFix: true, focus: 'qa', issues: [issue('blocking'), issue('nit')] });
    expect(defaultFindingActions(p, null)).toEqual({ 'qa:0': 'fix', 'qa:1': 'skip' });
    const reviewer = checkpoint({ role: 'reviewer', canPost: true, focus: 'qa', issues: [issue('blocking')] });
    expect(defaultFindingActions(reviewer, null)).toEqual({ 'qa:0': 'skip' });
  });

  it('returns a saved response over the computed defaults', () => {
    const p = checkpoint({ role: 'reviewer', canPost: true, findings: [finding('nit'), finding('blocking')] });
    expect(defaultFindingActions(p, { decision: 'approve', findings: { 'review:0': 'post', 'review:1': 'skip' } }))
      .toEqual({ 'review:0': 'post', 'review:1': 'skip' });
  });

  it('never proposes post for an author, and nothing at all without items', () => {
    const author = checkpoint({ role: 'author', canFix: true, canPost: true, findings: [finding('blocking'), finding('nit')] });
    expect(defaultFindingActions(author, null)).toEqual({ 'review:0': 'fix', 'review:1': 'skip' });
    expect(defaultFindingActions(checkpoint({ role: 'reviewer', canPost: true }), null)).toEqual({});
    expect(defaultFindingActions(checkpoint({ role: 'author', canFix: true, focus: 'qa' }), null)).toEqual({});
  });

  it('proposes nothing outside a result checkpoint', () => {
    expect(defaultFindingActions({ kind: 'question', questions: [] }, null)).toEqual({});
  });
});
