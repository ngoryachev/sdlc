import path from 'node:path';
import type { SdlcConfig } from '../config/config.js';
import type { GitHub, RepoAuth } from './gh.js';
import { slugFromRemote } from './git.js';

/**
 * Which GitHub account each repository is worked on with. The choice is stored per repository in the config
 * (`repos[].gh_user`), detected on first use as the first logged-in account (active first) that may push there,
 * and never depends on which account happens to be active in `gh` globally.
 */
export class RepoAccounts {
  private unregistered = new Map<string, string | null>();
  private detecting = new Map<string, Promise<string | null>>();

  constructor(private config: SdlcConfig, private gh: GitHub, private persist: () => void) {}

  private entry(repoPath: string) { const p = path.resolve(repoPath); return this.config.repos.find((r) => path.resolve(r.path) === p); }

  async userFor(repoPath: string): Promise<string | null> {
    const e = this.entry(repoPath);
    if (e?.gh_user) return e.gh_user;
    if (!e && this.unregistered.has(repoPath)) return this.unregistered.get(repoPath)!;
    let pending = this.detecting.get(repoPath);
    if (!pending) { pending = this.detect(repoPath).finally(() => this.detecting.delete(repoPath)); this.detecting.set(repoPath, pending); }
    const login = await pending;
    const again = this.entry(repoPath);
    if (again && login && !again.gh_user) { again.gh_user = login; this.persist(); }
    else if (!again) this.unregistered.set(repoPath, login);
    return login;
  }

  async forRepo(repoPath: string): Promise<RepoAuth> { return this.forUser(await this.userFor(repoPath)); }

  async forUser(login: string | null | undefined): Promise<RepoAuth> {
    if (!login) return { user: null, token: null };
    return { user: login, token: await this.gh.tokenFor(login).catch(() => null) };
  }

  /** First logged-in account (active first) with push access; else the active one; null when the repo is not on GitHub. */
  async detect(repoPath: string): Promise<string | null> {
    const slug = await slugFromRemote(repoPath);
    if (!slug) return null;
    const accounts = await this.gh.accounts().catch(() => []);
    const ordered = [...accounts.filter((a) => a.active), ...accounts.filter((a) => !a.active)];
    for (const a of ordered) {
      const token = await this.gh.tokenFor(a.login).catch(() => null);
      if (token && (await this.gh.canPush(slug, token))) return a.login;
    }
    return ordered[0]?.login ?? null;
  }

  /** Set (or clear, to re-detect) the account of a registered repository. */
  set(repoPath: string, login: string | null): void {
    const e = this.entry(repoPath);
    if (!e) throw new Error(`repository ${repoPath} is not registered`);
    if (login) e.gh_user = login; else delete e.gh_user;
    this.unregistered.delete(repoPath);
    this.persist();
  }
}
