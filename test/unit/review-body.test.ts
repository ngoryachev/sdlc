import { describe, it, expect } from 'vitest';
import { reviewBody } from '../../server/src/git/gh.js';

const comment = { path: 'a.ts', line: 1, body: 'nit' };

describe('reviewBody: the text a GitHub review event needs to be accepted', () => {
  it('keeps whatever the review itself says, whole', () => {
    for (const event of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const) {
      expect(reviewBody({ event, body: 'Looks good\n\n---\n\nbut see below', comments: [] })).toBe('Looks good\n\n---\n\nbut see below');
    }
  });

  it('lets an approval say nothing: the only verdict GitHub accepts with an empty body', () => {
    expect(reviewBody({ event: 'APPROVE', body: '', comments: [] })).toBe('');
    expect(reviewBody({ event: 'APPROVE', body: '', comments: [comment] })).toBe('');
  });

  it('speaks for a comment review that is only inline comments (a bodyless one is a 422)', () => {
    expect(reviewBody({ event: 'COMMENT', body: '', comments: [comment] })).toBe('See the comments.');
    expect(reviewBody({ event: 'COMMENT', body: '   \n ', comments: [comment] })).toBe('See the comments.');
  });

  it('speaks for request_changes whether or not it has inline comments', () => {
    expect(reviewBody({ event: 'REQUEST_CHANGES', body: '', comments: [] })).toBe('Changes requested, see the comments.');
    expect(reviewBody({ event: 'REQUEST_CHANGES', body: ' ', comments: [comment] })).toBe('Changes requested, see the comments.');
  });

  it('has nothing to say for an empty comment review: the publish phase skips that one before it is sent', () => {
    expect(reviewBody({ event: 'COMMENT', body: '', comments: [] })).toBe('');
  });
});
