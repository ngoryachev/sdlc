import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GhAccount, GhRepo, GitHub, MergeMethod, PrComment, PrInfo, ReviewEventName, ReviewLineComment } from '../../server/src/git/gh.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'gh', GIT_AUTHOR_EMAIL: 'gh@test', GIT_COMMITTER_NAME: 'gh', GIT_COMMITTER_EMAIL: 'gh@test' };
const g = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: ENV, stdio: 'pipe' }).toString().trim();

/** GitHub stand-in over a bare repository: PRs live in memory, merges really happen in the bare repo. */
export class FakeGitHub implements GitHub {
  prs = new Map<number, PrInfo>();
  calls: string[] = [];
  /** Comments a test puts on a PR; `prFeedback` returns them in insertion order. */
  feedback = new Map<number, PrComment[]>();
  /** Every review posted through `postReview`. */
  reviews: { number: number; event: ReviewEventName; body: string; comments: ReviewLineComment[] }[] = [];
  private next = 1;
  constructor(public bare: string, private opts: { accounts?: GhAccount[]; pushers?: string[] } = {}) {}

  async accounts() { return this.opts.accounts ?? [{ login: 'tester', active: true }]; }
  async tokenFor(login: string) { return `tok-${login}`; }
  async canPush(_slug: string, token: string | null) { return (this.opts.pushers ?? ['tester']).some((p) => token === `tok-${p}`); }
  async repoInfo() { return { slug: 'test/repo', parent: null }; }
  async listRepos(): Promise<GhRepo[]> { return []; }
  async repoBranches(): Promise<string[]> { return []; }
  async clone(): Promise<void> { throw new Error('clone is not supported by the fake'); }

  private has(branch: string) { try { g(this.bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } }
  private pr(n: number) { const p = this.prs.get(n); if (!p) throw new Error(`no PR #${n}`); return p; }

  /** Head commit is read from the bare repository, so a push by a test is what "new commits in the PR" means. */
  async prView(_cwd: string, n: number): Promise<PrInfo> { const p = this.pr(n); return { ...p, headRefOid: this.has(p.headRefName) ? g(this.bare, ['rev-parse', `refs/heads/${p.headRefName}`]) : undefined }; }
  /** Open a PR for a branch that is already on the remote (someone else's pull request). */
  openPr(head: string, base: string, title = head, body = ''): number { const number = this.next++; this.prs.set(number, { number, url: `https://github.test/test/repo/pull/${number}`, title, body, headRefName: head, baseRefName: base, state: 'OPEN', isDraft: false }); return number; }
  comment(n: number, c: Partial<PrComment> & { body: string }): void { const list = this.feedback.get(n) ?? []; list.push({ id: `comment:${list.length + 1}`, author: 'alice', association: 'COLLABORATOR', url: `https://github.test/c/${list.length + 1}`, createdAt: new Date(Date.now() + list.length).toISOString(), ...c }); this.feedback.set(n, list); }
  async prCreate(o: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string; number: number }> {
    if (!this.has(o.head)) throw new Error(`head ${o.head} is not on the remote`);
    if (!this.has(o.base)) throw new Error(`base ${o.base} is not on the remote`);
    const number = this.next++; const url = `https://github.test/test/repo/pull/${number}`;
    this.prs.set(number, { number, url, title: o.title, body: o.body, headRefName: o.head, baseRefName: o.base, state: 'OPEN', isDraft: o.draft });
    this.calls.push(`create #${number} ${o.head} -> ${o.base}`);
    return { url, number };
  }
  async prMerge(_cwd: string, n: number, method: MergeMethod): Promise<void> {
    const p = this.pr(n);
    if (p.state !== 'OPEN') throw new Error(`PR #${n} is ${p.state}`);
    if (!this.has(p.baseRefName)) throw new Error(`base ${p.baseRefName} of PR #${n} does not exist`);
    this.mergeInRemote(p.headRefName, p.baseRefName, method, `Merge pull request #${n}`);
    p.state = 'MERGED';
    this.calls.push(`merge #${n} ${method}`);
  }
  /** Merge head into base inside the bare repository (what GitHub does on merge). */
  mergeInRemote(head: string, base: string, method: MergeMethod = 'merge', message = 'merge'): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'));
    try {
      g(tmp, ['clone', '-q', this.bare, '.']);
      g(tmp, ['checkout', '-q', base]);
      if (method === 'squash') { g(tmp, ['merge', '--squash', `origin/${head}`]); g(tmp, ['commit', '-q', '-m', message]); }
      else g(tmp, ['merge', '--no-ff', '-m', message, `origin/${head}`]);
      g(tmp, ['push', '-q', 'origin', base]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  async prEditBase(_cwd: string, n: number, base: string): Promise<void> { this.pr(n).baseRefName = base; this.calls.push(`retarget #${n} -> ${base}`); }
  async prClose(_cwd: string, n: number): Promise<void> { this.pr(n).state = 'CLOSED'; this.calls.push(`close #${n}`); }
  async prComment(_cwd: string, n: number): Promise<void> { this.calls.push(`comment #${n}`); }
  async postReview(o: { number: number; event: ReviewEventName; body: string; comments: ReviewLineComment[] }): Promise<void> {
    this.reviews.push({ number: o.number, event: o.event, body: o.body, comments: o.comments });
    this.calls.push(`review #${o.number} ${o.event} ${o.comments.length} inline`);
  }
  async prFeedback(_cwd: string, n: number): Promise<{ state: string; comments: PrComment[] }> { return { state: this.pr(n).state, comments: [...(this.feedback.get(n) ?? [])] }; }
  /** GitHub closes open PRs whose base branch disappears; call after a delete to catch a wrong order. */
  closeOrphans(): void { for (const p of this.prs.values()) if (p.state === 'OPEN' && !this.has(p.baseRefName)) p.state = 'CLOSED'; }
}
