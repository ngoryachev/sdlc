import { describe, it, expect } from 'vitest';
import { TtlCache } from '../../server/src/git/gh.js';

describe('TtlCache: answers of gh are remembered, failures are not', () => {
  it('asks again after a null or an empty list, and stops asking once there is a value', async () => {
    const tokens = new TtlCache<string | null>(60_000);
    let calls = 0;
    const locked = async () => { calls++; return null; };              // the keyring is still locked right after boot
    expect(await tokens.get('me', locked)).toBeNull();
    expect(await tokens.get('me', locked)).toBeNull();
    expect(calls).toBe(2);
    const unlocked = async () => { calls++; return 'tok'; };
    expect(await tokens.get('me', unlocked)).toBe('tok');
    expect(await tokens.get('me', unlocked)).toBe('tok');
    expect(calls).toBe(3);                                               // the value is served from memory

    const lists = new TtlCache<string[]>(60_000);
    let n = 0;
    expect(await lists.get('all', async () => { n++; return []; })).toEqual([]);
    expect(await lists.get('all', async () => { n++; return ['a']; })).toEqual(['a']);
    expect(await lists.get('all', async () => { n++; return ['b']; })).toEqual(['a']);
    expect(n).toBe(2);
  });

  it('a value expires after its time and a later failure replaces nothing stale', async () => {
    const c = new TtlCache<string | null>(0);                            // already expired on the next read
    expect(await c.get('k', async () => 'v1')).toBe('v1');
    expect(await c.get('k', async () => null)).toBeNull();
    expect(await c.get('k', async () => 'v2')).toBe('v2');
  });
});
