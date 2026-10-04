import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { acquireServerLock, isLiveServer } from '../../server/src/cli/lock.js';
import { tmpDir } from '../helpers.js';

describe('server lock: one server per data directory', () => {
  it('takes a free lock, refuses while another server holds it, takes over a stale one', () => {
    const dir = tmpDir('sdlc-lock-');
    const file = path.join(dir, 'server.lock');
    const release = acquireServerLock(dir);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(String(process.pid));
    release();
    expect(fs.existsSync(file)).toBe(false);

    fs.writeFileSync(file, '424242\n');
    expect(() => acquireServerLock(dir, () => true)).toThrow(/another sdlc server \(pid 424242\) already runs/);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('424242');          // the owner's lock is untouched

    const again = acquireServerLock(dir, () => false);                    // the owner died (crash, reboot)
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(String(process.pid));
    fs.writeFileSync(file, '424242\n');                                   // someone else took it meanwhile
    again();
    expect(fs.existsSync(file)).toBe(true);                               // release never removes a lock that is not ours
  });

  it.skipIf(process.platform !== 'linux')('a live pid of another program is not a server; a dead pid is nobody', () => {
    expect(isLiveServer(process.pid)).toBe(false);                        // vitest is alive but is not `sdlc serve`
    expect(isLiveServer(0)).toBe(false);
    expect(isLiveServer(2 ** 30)).toBe(false);
  });
});
