import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ReviewOutput } from '@sdlc/shared';
import { git, netEnv } from './git.js';

const execFileP = promisify(execFile);

/** The GitHub account a repository is worked on with; token null = whatever account is active in gh. */
export interface RepoAuth { user: string | null; token: string | null }
export interface GhAccount { login: string; active: boolean }
export interface GhRepo { slug: string; description: string; isFork: boolean; isPrivate: boolean; pushedAt: string | null; defaultBranch: string; canPush: boolean }
export interface PrInfo { number: number; url: string; title: string; body: string; headRefName: string; baseRefName: string; state: string; isDraft: boolean }
export interface PrComment { id: string; author: string; body: string; path?: string; line?: number; url: string; reviewState?: string; createdAt: string; association?: string }
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Everything sdlc asks of GitHub. The default implementation shells out to `gh`; tests use a fake. */
export interface GitHub {
  accounts(): Promise<GhAccount[]>;
  tokenFor(login: string): Promise<string | null>;
  canPush(slug: string, token: string | null): Promise<boolean>;
  repoInfo(cwd: string, auth: RepoAuth): Promise<{ slug: string; parent: string | null } | null>;
  listRepos(auth: RepoAuth): Promise<GhRepo[]>;
  repoBranches(slug: string, auth: RepoAuth): Promise<string[]>;
  clone(slug: string, dest: string, auth: RepoAuth): Promise<void>;
  prView(cwd: string, number: number, auth: RepoAuth): Promise<PrInfo>;
  prCreate(o: { cwd: string; head: string; base: string; title: string; body: string; draft: boolean }, auth: RepoAuth): Promise<{ url: string; number: number }>;
  prMerge(cwd: string, number: number, method: MergeMethod, auth: RepoAuth): Promise<void>;
  prEditBase(cwd: string, number: number, base: string, auth: RepoAuth): Promise<void>;
  prClose(cwd: string, number: number, auth: RepoAuth): Promise<void>;
  prComment(cwd: string, number: number, body: string, auth: RepoAuth): Promise<void>;
  postReview(o: { cwd: string; number: number; review: ReviewOutput }, auth: RepoAuth): Promise<void>;
  prFeedback(cwd: string, number: number, auth: RepoAuth): Promise<{ state: string; comments: PrComment[] }>;
}

function ghEnv(token: string | null | undefined, clearTokens = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' };
  if (token) { env.GH_TOKEN = token; delete env.GITHUB_TOKEN; }
  else if (clearTokens) { delete env.GH_TOKEN; delete env.GITHUB_TOKEN; }
  return env;
}

export async function gh(args: string[], o: { cwd?: string; token?: string | null; clearTokens?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileP('gh', args, { cwd: o.cwd, env: ghEnv(o.token, o.clearTokens), maxBuffer: 64 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string };
    if (err.code === 'ENOENT') throw new Error('gh CLI is not installed');
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${err.stderr?.trim() || err.message}`);
  }
}

export async function ghAvailable(): Promise<boolean> { try { await gh(['--version']); return true; } catch { return false; } }

class TtlCache<V> {
  private m = new Map<string, { at: number; v: V }>();
  constructor(private ttlMs: number) {}
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.v;
    const v = await load();
    this.m.set(key, { at: Date.now(), v });
    return v;
  }
  drop(key?: string) { if (key === undefined) this.m.clear(); else this.m.delete(key); }
}

/** `gh`-backed GitHub. Every call runs with the token of the account chosen for the repository. */
export class GhCli implements GitHub {
  private tokens = new TtlCache<string | null>(10 * 60_000);
  private accountsCache = new TtlCache<GhAccount[]>(60_000);
  private repos = new TtlCache<GhRepo[]>(5 * 60_000);
  private infos = new TtlCache<{ slug: string; parent: string | null } | null>(10 * 60_000);

  async accounts(): Promise<GhAccount[]> {
    return this.accountsCache.get('all', async () => {
      let out = '';
      // exits non-zero when some account has a problem; the JSON on stdout is still complete
      try { ({ stdout: out } = await execFileP('gh', ['auth', 'status', '--json', 'hosts'], { env: ghEnv(null, true) })); }
      catch (e) { out = (e as { stdout?: string }).stdout ?? ''; }
      if (!out.trim()) return [];
      const j = JSON.parse(out) as { hosts?: Record<string, { login: string; active: boolean; state: string }[]> };
      return (j.hosts?.['github.com'] ?? []).filter((a) => a.state === 'success').map((a) => ({ login: a.login, active: a.active }));
    });
  }

  tokenFor(login: string): Promise<string | null> {
    return this.tokens.get(login, async () => { try { return (await gh(['auth', 'token', '--user', login], { clearTokens: true })).trim() || null; } catch { return null; } });
  }

  async canPush(slug: string, token: string | null): Promise<boolean> {
    try { return (await gh(['api', `repos/${slug}`, '-q', '.permissions.push'], { token })).trim() === 'true'; } catch { return false; }
  }

  repoInfo(cwd: string, auth: RepoAuth): Promise<{ slug: string; parent: string | null } | null> {
    return this.infos.get(`${cwd}|${auth.user ?? ''}`, async () => {
      try {
        const j = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner,parent'], { cwd, token: auth.token })) as { nameWithOwner: string; parent?: { owner: { login: string }; name: string } | null };
        return { slug: j.nameWithOwner, parent: j.parent ? `${j.parent.owner.login}/${j.parent.name}` : null };
      } catch { return null; }
    });
  }

  /** Repository PRs live in: the parent for forks. */
  private async prRepo(cwd: string, auth: RepoAuth): Promise<string> {
    const info = await this.repoInfo(cwd, auth);
    if (!info) throw new Error(`cannot determine the GitHub repository of ${cwd} (gh repo view failed${auth.user ? ` as ${auth.user}` : ''})`);
    return info.parent ?? info.slug;
  }

  listRepos(auth: RepoAuth): Promise<GhRepo[]> {
    return this.repos.get(auth.user ?? '(active)', async () => {
      const q = '.[] | {slug: .full_name, description: (.description // ""), isFork: .fork, isPrivate: .private, pushedAt: .pushed_at, defaultBranch: .default_branch, canPush: (.permissions.push // false)}';
      const out = await gh(['api', '--paginate', 'user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100', '-q', q], { token: auth.token });
      return out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhRepo);
    });
  }

  async repoBranches(slug: string, auth: RepoAuth): Promise<string[]> {
    const out = await gh(['api', '--paginate', `repos/${slug}/branches?per_page=100`, '-q', '.[].name'], { token: auth.token });
    return out.split('\n').filter(Boolean);
  }

  async clone(slug: string, dest: string, auth: RepoAuth): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await gh(['repo', 'clone', slug, dest], { token: auth.token });
    const info = await this.repoInfo(dest, auth);
    if (info?.parent) await git(dest, ['remote', 'add', 'upstream', `https://github.com/${info.parent}.git`], { allowFail: true });
    this.repos.drop();
  }

  async prView(cwd: string, number: number, auth: RepoAuth): Promise<PrInfo> {
    const repo = await this.prRepo(cwd, auth);
    return JSON.parse(await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'number,url,title,body,headRefName,baseRefName,state,isDraft'], { token: auth.token })) as PrInfo;
  }

  async prCreate(o: { cwd: string; head: string; base: string; title: string; body: string; draft: boolean }, auth: RepoAuth): Promise<{ url: string; number: number }> {
    const bodyFile = path.join(os.tmpdir(), `sdlc-pr-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(bodyFile, o.body);
    try {
      const info = await this.repoInfo(o.cwd, auth);
      const args = ['pr', 'create', '--head', info?.parent ? `${info.slug.split('/')[0]}:${o.head}` : o.head, '--base', o.base, '--title', o.title, '--body-file', bodyFile];
      if (o.draft) args.push('--draft');
      if (info) args.push('--repo', info.parent ?? info.slug);
      const url = (await gh(args, { cwd: o.cwd, token: auth.token })).split('\n').find((l) => l.startsWith('http')) ?? '';
      const m = /\/pull\/(\d+)/.exec(url);
      return { url, number: m ? Number(m[1]) : 0 };
    } finally { fs.rmSync(bodyFile, { force: true }); }
  }

  /** Merge on GitHub. Branches are not deleted here: the engine retargets stacked PRs first, then deletes. */
  async prMerge(cwd: string, number: number, method: MergeMethod, auth: RepoAuth): Promise<void> {
    const repo = await this.prRepo(cwd, auth);
    await gh(['pr', 'ready', String(number), '--repo', repo], { token: auth.token }).catch(() => {});
    await gh(['pr', 'merge', String(number), '--repo', repo, `--${method}`], { token: auth.token });
  }

  async prEditBase(cwd: string, number: number, base: string, auth: RepoAuth): Promise<void> {
    const repo = await this.prRepo(cwd, auth);
    await gh(['pr', 'edit', String(number), '--repo', repo, '--base', base], { token: auth.token });
  }

  async prClose(cwd: string, number: number, auth: RepoAuth): Promise<void> {
    const repo = await this.prRepo(cwd, auth);
    await gh(['pr', 'close', String(number), '--repo', repo], { token: auth.token });
  }

  async prComment(cwd: string, number: number, body: string, auth: RepoAuth): Promise<void> {
    const repo = await this.prRepo(cwd, auth);
    await gh(['pr', 'comment', String(number), '--repo', repo, '--body', body], { token: auth.token });
  }

  async postReview(o: { cwd: string; number: number; review: ReviewOutput }, auth: RepoAuth): Promise<void> {
    const repo = await this.prRepo(o.cwd, auth);
    const comments = o.review.findings.filter((f) => f.file && f.line).map((f) => ({ path: f.file!, line: f.line!, body: `**${f.severity}: ${f.title}**\n\n${f.description}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ''}` }));
    const tmp = path.join(os.tmpdir(), `sdlc-review-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ body: o.review.summary, event: 'COMMENT', comments }));
    try { await gh(['api', `repos/${repo}/pulls/${o.number}/reviews`, '--method', 'POST', '--input', tmp], { token: auth.token }); }
    finally { fs.rmSync(tmp, { force: true }); }
  }

  async prFeedback(cwd: string, number: number, auth: RepoAuth): Promise<{ state: string; comments: PrComment[] }> {
    const repo = await this.prRepo(cwd, auth);
    const view = JSON.parse(await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,reviews,comments,url'], { token: auth.token })) as {
      state: string; url: string;
      reviews: { id: string; author: { login: string }; authorAssociation?: string; body: string; state: string; submittedAt: string }[];
      comments: { id: string; author: { login: string }; authorAssociation?: string; body: string; createdAt: string; url: string }[];
    };
    const inline = (await gh(['api', '--paginate', `repos/${repo}/pulls/${number}/comments?per_page=100`, '-q', '.[] | {id, user: {login: .user.login}, author_association, body, path, line, original_line, html_url, created_at}'], { token: auth.token }))
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; user: { login: string }; author_association?: string; body: string; path: string; line: number | null; original_line: number | null; html_url: string; created_at: string });
    const comments: PrComment[] = [
      ...view.reviews.filter((r) => r.body || r.state === 'CHANGES_REQUESTED').map((r) => ({ id: `review:${r.id}`, author: r.author.login, association: r.authorAssociation, body: r.body, url: view.url, reviewState: r.state, createdAt: r.submittedAt })),
      ...view.comments.map((c) => ({ id: `comment:${c.id}`, author: c.author.login, association: c.authorAssociation, body: c.body, url: c.url, createdAt: c.createdAt })),
      ...inline.map((c) => ({ id: `inline:${c.id}`, author: c.user.login, association: c.author_association, body: c.body, path: c.path, line: c.line ?? c.original_line ?? undefined, url: c.html_url, createdAt: c.created_at })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { state: view.state, comments };
  }
}

/** Env for a git network command run with this repo's account (re-exported for callers that only have RepoAuth). */
export const gitEnvFor = (auth: RepoAuth) => netEnv({ token: auth.token });
