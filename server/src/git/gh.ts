import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ReviewOutput } from '@sdlc/shared';

const execFileP = promisify(execFile);

export async function gh(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileP('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string };
    if (err.code === 'ENOENT') throw new Error('gh CLI is not installed');
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${err.stderr?.trim() || err.message}`);
  }
}

let loginCache: string | null | undefined;
/** Login of the gh account in use (cached); null when gh is unavailable. sdlc never ingests its own PR comments. */
export async function ghLogin(): Promise<string | null> {
  if (loginCache !== undefined) return loginCache;
  try { loginCache = (await gh(['api', 'user', '-q', '.login'])).trim() || null; } catch { loginCache = null; }
  return loginCache;
}

export async function ghAvailable(): Promise<boolean> { try { await gh(['--version']); return true; } catch { return false; } }

export async function repoSlug(cwd: string): Promise<{ slug: string; parent: string | null } | null> {
  try {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner,parent'], cwd);
    const j = JSON.parse(out) as { nameWithOwner: string; parent?: { owner: { login: string }; name: string } | null };
    return { slug: j.nameWithOwner, parent: j.parent ? `${j.parent.owner.login}/${j.parent.name}` : null };
  } catch { return null; }
}

export async function createPr(o: { cwd: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string; number: number }> {
  const bodyFile = path.join(os.tmpdir(), `sdlc-pr-${Date.now()}.md`);
  fs.writeFileSync(bodyFile, o.body);
  try {
    const args = ['pr', 'create', '--head', o.head, '--base', o.base, '--title', o.title, '--body-file', bodyFile];
    if (o.draft) args.push('--draft');
    const info = await repoSlug(o.cwd);
    if (info?.parent) args.push('--repo', info.parent);
    const url = (await gh(args, o.cwd)).split('\n').find((l) => l.startsWith('http')) ?? '';
    const m = /\/pull\/(\d+)/.exec(url);
    return { url, number: m ? Number(m[1]) : 0 };
  } finally { fs.rmSync(bodyFile, { force: true }); }
}

export async function prSlugFor(cwd: string): Promise<string> {
  const info = await repoSlug(cwd);
  if (!info) throw new Error('cannot determine GitHub repo (gh repo view failed)');
  return info.parent ?? info.slug;
}

export async function postReview(o: { cwd: string; number: number; review: ReviewOutput }): Promise<void> {
  const slug = await prSlugFor(o.cwd);
  const comments = o.review.findings.filter((f) => f.file && f.line).map((f) => ({ path: f.file!, line: f.line!, body: `**${f.severity}: ${f.title}**\n\n${f.description}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ''}` }));
  const payload = { body: o.review.summary, event: 'COMMENT', comments };
  const tmp = path.join(os.tmpdir(), `sdlc-review-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  try { await gh(['api', `repos/${slug}/pulls/${o.number}/reviews`, '--method', 'POST', '--input', tmp], o.cwd); }
  finally { fs.rmSync(tmp, { force: true }); }
}

export interface PrComment { id: string; author: string; body: string; path?: string; line?: number; url: string; reviewState?: string; createdAt: string; association?: string }
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export async function prFeedback(cwd: string, number: number): Promise<{ state: string; comments: PrComment[] }> {
  const slug = await prSlugFor(cwd);
  const view = JSON.parse(await gh(['pr', 'view', String(number), '--json', 'state,reviews,comments,url'], cwd)) as {
    state: string; url: string;
    reviews: { id: string; author: { login: string }; authorAssociation?: string; body: string; state: string; submittedAt: string }[];
    comments: { id: string; author: { login: string }; authorAssociation?: string; body: string; createdAt: string; url: string }[];
  };
  const inline = JSON.parse(await gh(['api', `repos/${slug}/pulls/${number}/comments`, '--paginate'], cwd)) as
    { id: number; user: { login: string }; author_association?: string; body: string; path: string; line: number | null; original_line: number | null; html_url: string; created_at: string }[];
  const comments: PrComment[] = [
    ...view.reviews.filter((r) => r.body || r.state === 'CHANGES_REQUESTED').map((r) => ({ id: `review:${r.id}`, author: r.author.login, association: r.authorAssociation, body: r.body, url: view.url, reviewState: r.state, createdAt: r.submittedAt })),
    ...view.comments.map((c) => ({ id: `comment:${c.id}`, author: c.author.login, association: c.authorAssociation, body: c.body, url: c.url, createdAt: c.createdAt })),
    ...inline.map((c) => ({ id: `inline:${c.id}`, author: c.user.login, association: c.author_association, body: c.body, path: c.path, line: c.line ?? c.original_line ?? undefined, url: c.html_url, createdAt: c.created_at })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { state: view.state, comments };
}

export interface PrInfo { number: number; url: string; title: string; body: string; headRefName: string; baseRefName: string; state: string; isDraft: boolean }
export async function prView(cwd: string, number: number): Promise<PrInfo> {
  const out = await gh(['pr', 'view', String(number), '--json', 'number,url,title,body,headRefName,baseRefName,state,isDraft'], cwd);
  return JSON.parse(out) as PrInfo;
}

/** Merge a PR on GitHub; the remote head branch is deleted. Returns the merge state reported afterwards. */
export async function prMerge(cwd: string, number: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
  await gh(['pr', 'ready', String(number)], cwd).catch(() => {});
  await gh(['pr', 'merge', String(number), `--${method}`, '--delete-branch'], cwd);
}

export async function prComment(cwd: string, number: number, body: string): Promise<void> {
  await gh(['pr', 'comment', String(number), '--body', body], cwd);
}

export async function listRepos(q?: string): Promise<{ slug: string; description: string; isFork: boolean }[]> {
  const args = q ? ['search', 'repos', q, '--limit', '20', '--json', 'fullName,description,isFork'] : ['repo', 'list', '--limit', '50', '--json', 'nameWithOwner,description,isFork'];
  const rows = JSON.parse(await gh(args)) as Record<string, unknown>[];
  return rows.map((r) => ({ slug: String(r.fullName ?? r.nameWithOwner), description: String(r.description ?? ''), isFork: !!r.isFork }));
}

export async function cloneRepo(slug: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await gh(['repo', 'clone', slug, dest]);
  const info = await repoSlug(dest);
  if (info?.parent) { try { await execFileP('git', ['remote', 'add', 'upstream', `https://github.com/${info.parent}.git`], { cwd: dest }); } catch { /* exists */ } }
}
