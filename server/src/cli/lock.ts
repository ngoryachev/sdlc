import fs from 'node:fs';
import path from 'node:path';

/** True when `pid` is a live sdlc server. A reused pid of some other program does not count (Linux: checked by command line). */
export function isLiveServer(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return /\bserve\b/.test(cmd);
  } catch { return true; }   // no /proc (macOS): a live pid is all we can know
}

/**
 * One server per data directory. A second `serve` on the same data would open the same database and resume the same
 * tasks next to the first one, so it must refuse to start. Returns the release function.
 */
export function acquireServerLock(dataDir: string, alive: (pid: number) => boolean = isLiveServer): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true }); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = Number(fs.readFileSync(file, 'utf8').trim());
      if (owner !== process.pid && alive(owner)) throw new Error(`another sdlc server (pid ${owner}) already runs on ${dataDir}. Stop it first, or start this one on its own data with SDLC_HOME=<dir> and another --port.`);
      fs.rmSync(file, { force: true });   // left behind by a crash or a reboot
    }
  }
  throw new Error(`could not take the server lock ${file}`);
}
