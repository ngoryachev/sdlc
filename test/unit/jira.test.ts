import { describe, it, expect } from 'vitest';
import { jiraKeyFrom, withJiraKey } from '../../server/src/engine/jira.js';

describe('jiraKeyFrom', () => {
  it('takes the first key in the text, exactly as written', () => {
    expect(jiraKeyFrom('ABC-123 add a flag')).toBe('ABC-123');
    expect(jiraKeyFrom('fix the thing (see PROJ-7 and PROJ-9)')).toBe('PROJ-7');
    expect(jiraKeyFrom('SDLC2-45: digits in the project key')).toBe('SDLC2-45');
    expect(jiraKeyFrom('ABC-123\nmore text')).toBe('ABC-123');
  });

  it('needs uppercase: a key is never lowercased or re-cased', () => {
    expect(jiraKeyFrom('abc-123 add a flag')).toBeNull();
    expect(jiraKeyFrom('Abc-123 add a flag')).toBeNull();
    expect(jiraKeyFrom('ABC-123')).toBe('ABC-123');
  });

  it('has no key for ordinary prompts', () => {
    expect(jiraKeyFrom('Add a flag so traps play to the key move')).toBeNull();
    expect(jiraKeyFrom('A-1 is too short a project key')).toBeNull();   // the pattern needs two letters
    expect(jiraKeyFrom('')).toBeNull();
    expect(jiraKeyFrom(null)).toBeNull();
  });

  it('is stateless: the shared global regexp does not carry lastIndex between calls', () => {
    for (let i = 0; i < 3; i++) {
      expect(jiraKeyFrom('ABC-123 add a flag')).toBe('ABC-123');
      expect(jiraKeyFrom('see https://jira.test/browse/PROJ-42 for the details')).toBe('PROJ-42');
      expect(jiraKeyFrom('no key here')).toBeNull();
    }
  });

  it('skips tokens that look like keys but are standards or algorithms', () => {
    for (const t of ['decode UTF-8 input', 'switch to SHA-256', 'dates are ISO-8601', 'ask GPT-4', 'patch CVE-2024', 'enable HTTP-2', 'per RFC-5322', 'store UTC-5 offsets', 'use AES-256', 'parse RGB-255'])
      expect(jiraKeyFrom(t)).toBeNull();
    expect(jiraKeyFrom('CVE-2024 is fixed in PROJ-7')).toBe('PROJ-7');
  });
});

describe('withJiraKey', () => {
  it('prefixes the subject once, and only when there is a key', () => {
    expect(withJiraKey('sdlc(t_1): implement', 'ABC-123')).toBe('ABC-123 sdlc(t_1): implement');
    expect(withJiraKey('ABC-123 sdlc(t_1): implement', 'ABC-123')).toBe('ABC-123 sdlc(t_1): implement');
    expect(withJiraKey('sdlc(t_1): ABC-123 add a flag', 'ABC-123')).toBe('sdlc(t_1): ABC-123 add a flag');
    expect(withJiraKey('sdlc(t_1): implement', null)).toBe('sdlc(t_1): implement');
    expect(withJiraKey('sdlc(t_1): implement', '')).toBe('sdlc(t_1): implement');
  });
});
