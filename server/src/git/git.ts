import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch (e) {
    if (opts.allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr?.trim() || err.message}`);
  }
}

/** Credentials for network git operations: the token of the GitHub account chosen for the repository. */
export interface NetAuth { token?: string | null }
/**
 * Environment for fetch/push/ls-remote. With a token, the gh credential helper is forced for github.com and GH_TOKEN
 * selects the account, whatever account is active in gh globally. Never prompts.
 */
export function netEnv(auth?: NetAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  if (!auth?.token) return env;
  return { ...env, GH_TOKEN: auth.token, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential' };
}

/**
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` for `Name <mail>`: every command of ours that writes a commit passes these, so
 * the service never depends on a `user.email` being configured on the machine it runs on.
 */
export function authorEnv(author?: string | null): NodeJS.ProcessEnv {
  const m = author ? /^(.*) <(.*)>$/.exec(author) : null;
  return m ? { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2] } : {};
}

export async function repoToplevel(p: string): Promise<string> { return git(p, ['rev-parse', '--show-toplevel']); }

/** `git merge-base --is-ancestor a b`: true when a is reachable from b. */
export async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  try { await execFileP('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo }); return true; }
  catch (e) { if ((e as { code?: number }).code === 1) return false; throw new Error(`git merge-base --is-ancestor ${a} ${b} failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`); }
}

/** Worktree (path) in which a local branch is checked out, or null. */
export async function worktreeFor(repo: string, branch: string): Promise<string | null> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true });
  for (const block of out.split('\n\n')) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (wt && br === branch && fs.existsSync(wt)) return wt;
  }
  return null;
}

/** `owner/name` of the GitHub repository behind origin (or the first remote); null when it is not on github.com. */
export async function slugFromRemote(repo: string): Promise<string | null> {
  const rs = await remotes(repo).catch(() => [] as string[]);
  const r = rs.includes('origin') ? 'origin' : rs[0];
  if (!r) return null;
  const url = await git(repo, ['remote', 'get-url', r], { allowFail: true });
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Update refs/remotes/<remote>/<branch> from the remote. Returns false when the branch does not exist there
 * (a stale tracking ref is removed); throws on other failures (network, auth).
 */
export async function fetchBranch(repo: string, remote: string, branch: string, auth?: NetAuth): Promise<boolean> {
  try {
    await execFileP('git', ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { cwd: repo, env: { ...process.env, ...netEnv(auth) }, maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? (e as Error).message;
    if (/couldn't find remote ref|could not find remote ref/i.test(msg)) { await git(repo, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`], { allowFail: true }); return false; }
    throw new Error(`git fetch ${remote} ${branch} failed: ${msg.trim()}`);
  }
}

export type BranchSync = 'no-remote' | 'not-pushed' | 'same' | 'fast-forwarded' | 'created' | 'ahead' | 'pushed';
/**
 * Bring a local branch in line with its copy on the remote: fast-forward when it is behind (commits merged into it on
 * GitHub), push when it is ahead and `push` is set. Throws when the two have diverged; nothing is changed then.
 */
export async function syncBranchWithRemote(o: { repo: string; remote: string | null; branch: string; auth?: NetAuth; push: boolean }): Promise<BranchSync> {
  if (!o.remote || !(await remotes(o.repo)).includes(o.remote)) return 'no-remote';
  if (!(await fetchBranch(o.repo, o.remote, o.branch, o.auth))) return 'not-pushed';
  const rem = await git(o.repo, ['rev-parse', `refs/remotes/${o.remote}/${o.branch}`]);
  const local = await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], { allowFail: true });
  if (!local) { await git(o.repo, ['branch', o.branch, rem]); return 'created'; }
  if (local === rem) return 'same';
  if (await isAncestor(o.repo, local, rem)) {
    const wt = await worktreeFor(o.repo, o.branch);
    if (wt) await git(wt, ['merge', '--ff-only', '--quiet', rem]);
    else await git(o.repo, ['update-ref', `refs/heads/${o.branch}`, rem, local]);
    return 'fast-forwarded';
  }
  if (await isAncestor(o.repo, rem, local)) {
    if (!o.push) return 'ahead';
    await git(o.repo, ['push', o.remote, `refs/heads/${o.branch}:refs/heads/${o.branch}`], { env: netEnv(o.auth) });
    return 'pushed';
  }
  throw new Error(`branch ${o.branch} and ${o.remote}/${o.branch} have diverged (both have commits the other lacks); reconcile them by hand and try again`);
}

export type CatchUpKind =
  | 'no-remote'          // the task has no remote, or it is not configured in this repository
  | 'not-pushed'         // the branch does not exist on the remote yet: the first push creates it
  | 'not-checked-out'    // the worktree is not on this branch (nothing safe to move)
  | 'dirty'              // uncommitted changes in the worktree: a phase is mid-work, leave it alone
  | 'up-to-date'
  | 'remote-behind'      // the remote copy is an ancestor: a plain push will fast-forward it
  | 'fast-forwarded'     // the branch had no own commits: moved to the remote tip
  | 'rebased';           // the two had diverged: sdlc's unpushed commits were replayed on the remote tip

export interface CatchUp { kind: CatchUpKind; incoming: string[]; replayed: string[]; note: string }

/** The task's own commits cannot be replayed on what was pushed from outside: only a human can resolve this. */
export class CatchUpConflict extends Error {}

/** `git log --oneline` of a range, oldest first, as `<short sha> <author>: <subject>`. */
async function commitLines(cwd: string, range: string): Promise<string[]> {
  const out = await git(cwd, ['log', '--reverse', '--format=%h %an: %s', range], { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * Bring the task branch in a worktree in line with commits pushed to it from outside sdlc (another machine, a
 * colleague, a merge on GitHub), so that the following push is a fast-forward and an agent sees those commits.
 *
 * Behind the remote copy → fast-forward; diverged → `git rebase` onto it, which rewrites only sdlc's own unpushed
 * commits. A conflict is aborted (worktree left exactly as it was) and reported, so the task escalates to a human.
 * Nothing is ever force-pushed and no commit is ever dropped.
 */
export async function catchUpWithRemoteBranch(o: { worktree: string; remote: string | null; branch: string; auth?: NetAuth; author?: string | null }): Promise<CatchUp> {
  const none = (kind: CatchUpKind): CatchUp => ({ kind, incoming: [], replayed: [], note: '' });
  const wt = o.worktree;
  if (!o.remote || !(await remotes(wt)).includes(o.remote)) return none('no-remote');
  if ((await git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })) !== o.branch) return none('not-checked-out');
  if (!(await fetchBranch(wt, o.remote, o.branch, o.auth))) return none('not-pushed');
  const ref = `refs/remotes/${o.remote}/${o.branch}`;
  const rem = await git(wt, ['rev-parse', ref]);
  const local = await git(wt, ['rev-parse', 'HEAD']);
  if (rem === local) return none('up-to-date');
  if (await isAncestor(wt, rem, local)) return none('remote-behind');
  // a merge or a rebase would fail (or stash) on uncommitted work; the phase that made it is still running
  if (await git(wt, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true })) return none('dirty');
  const incoming = await commitLines(wt, `HEAD..${ref}`);
  const label = `${o.remote}/${o.branch}`;
  const trouble = (what: string, e: unknown) => new Error(`branch ${o.branch} could not ${what} ${label}, which has ${incoming.length} commit(s) pushed from outside sdlc: ${(e as Error).message}`);
  if (await isAncestor(wt, local, rem)) {
    try { await git(wt, ['merge', '--ff-only', '--quiet', ref], { env: authorEnv(o.author) }); }
    catch (e) { throw trouble('be fast-forwarded to', e); }
    return { kind: 'fast-forwarded', incoming, replayed: [], note: `${o.branch}: fast-forwarded to ${label} (${incoming.length} commit(s) pushed from outside sdlc)` };
  }
  const replayed = await commitLines(wt, `${ref}..HEAD`);
  try {
    // the identity comes from the config, like every other commit sdlc writes: a rebase commits too
    await git(wt, ['-c', 'rebase.autoStash=false', 'rebase', '--quiet', ref], { env: authorEnv(o.author) });
  } catch (e) {
    const unmerged = await git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
    const conflicts = unmerged ? unmerged.split('\n').filter(Boolean) : [];
    await git(wt, ['rebase', '--abort'], { allowFail: true });
    // a rebase that never reached a patch (no identity, a file in the way) is not something to resolve by hand
    if (!conflicts.length) throw trouble('be rebased onto', e);
    const list = (title: string, lines: string[]) => (lines.length ? `\n\n${title}\n${lines.map((l) => `  ${l}`).join('\n')}` : '');
    throw new CatchUpConflict(
      `branch ${o.branch} has commits that were pushed from outside sdlc, and replaying this task's own commits on top of them conflicts. The rebase was aborted: the worktree is unchanged and no commit was lost.`
      + list(`commits that came from outside (on ${label}):`, incoming)
      + list('commits of this task that could not be replayed:', replayed)
      + list('files in conflict:', conflicts)
      + `\n\nResolve it by hand in ${wt} (\`git rebase ${label}\`), then retry the task. Original error: ${(e as Error).message}`,
    );
  }
  return { kind: 'rebased', incoming, replayed, note: `${o.branch}: rebased ${replayed.length} unpushed commit(s) onto ${label} (${incoming.length} commit(s) pushed from outside sdlc)` };
}

/** Number of commits on a branch that sdlc made for this task (commit trailer `Task: <id>`). */
export async function taskCommitCount(repo: string, branch: string, taskId: string): Promise<number> {
  const out = await git(repo, ['log', '--format=%H', '-F', `--grep=Task: ${taskId}`, `refs/heads/${branch}`], { allowFail: true });
  return out ? out.split('\n').filter(Boolean).length : 0;
}

export async function remotes(repo: string): Promise<string[]> { const s = await git(repo, ['remote']); return s ? s.split('\n') : []; }

export async function refExists(repo: string, ref: string): Promise<boolean> { return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })) !== ''; }

export async function defaultBase(repo: string): Promise<{ remote: string | null; branch: string }> {
  const rs = await remotes(repo);
  const remote = rs.includes('origin') ? 'origin' : rs[0] ?? null;
  if (remote) {
    const head = await git(repo, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { allowFail: true });
    if (head) return { remote, branch: head.replace(`${remote}/`, '') };
  }
  const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return { remote, branch: cur && cur !== 'HEAD' ? cur : 'main' };
}

export async function listBranches(repo: string): Promise<{ remote: string | null; branch: string }[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  const res: { remote: string | null; branch: string }[] = [];
  const rs = await remotes(repo);
  for (const ref of out.split('\n').filter(Boolean)) {
    const r = rs.find((x) => ref.startsWith(x + '/'));
    if (r) { if (!ref.endsWith('/HEAD')) res.push({ remote: r, branch: ref.slice(r.length + 1) }); }
    else res.push({ remote: null, branch: ref });
  }
  return res;
}

export interface WorktreeInfo { worktreePath: string; branch: string; baseRef: string }

/** `sdlc/<slug>-<id>` from a short English summary: lowercase, at most 5 words / 40 chars; falls back to `sdlc/<id>`. */
export function branchNameFor(summary: string, taskId: string): string {
  const words = summary.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  let slug = words.join('-');
  if (slug.length > 40) slug = slug.slice(0, 40).replace(/-[^-]*$/, '');
  return slug ? `sdlc/${slug}-${taskId}` : `sdlc/${taskId}`;
}
/** Branches sdlc created for this task: `sdlc/<id>` or `sdlc/<slug>-<id>`. Adopted branches never match. */
export function isSdlcBranch(branch: string, taskId: string): boolean { return branch === `sdlc/${taskId}` || (branch.startsWith('sdlc/') && branch.endsWith(`-${taskId}`)); }
/** Rename the branch checked out in a worktree (before it is pushed). */
export async function renameBranch(worktree: string, to: string): Promise<void> { await git(worktree, ['branch', '-m', to]); }

export async function createWorktree(opts: { repo: string; worktreesDir: string; taskId: string; baseRemote: string | null; baseBranch: string; copyUntracked?: string[]; auth?: NetAuth }): Promise<WorktreeInfo> {
  const { repo, taskId } = opts;
  if (opts.baseRemote) await fetchBranch(repo, opts.baseRemote, opts.baseBranch, opts.auth).catch(() => false);
  const baseRef = opts.baseRemote ? `${opts.baseRemote}/${opts.baseBranch}` : opts.baseBranch;
  await git(repo, ['rev-parse', '--verify', baseRef]); // throws if missing
  const branch = `sdlc/${taskId}`;
  const worktreePath = path.join(opts.worktreesDir, taskId);
  fs.mkdirSync(opts.worktreesDir, { recursive: true });
  await git(repo, ['worktree', 'add', worktreePath, '-b', branch, baseRef]);
  fs.mkdirSync(path.join(worktreePath, '.sdlc'), { recursive: true });
  // keep .sdlc/ out of git in every worktree of this repo
  const gitDir = await git(repo, ['rev-parse', '--git-common-dir']);
  const exclude = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repo, gitDir), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.sdlc/')) fs.appendFileSync(exclude, (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.sdlc/\n');
  for (const rel of opts.copyUntracked ?? []) {
    const src = path.join(repo, rel);
    if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true }); fs.cpSync(src, path.join(worktreePath, rel), { recursive: true }); }
  }
  return { worktreePath, branch, baseRef };
}

/** Attach a worktree to an existing branch for a new task (import of a PR / `--branch`). The branch is left as is. */
export async function adoptWorktree(o: { repo: string; worktreesDir: string; taskId: string; branch: string; remote: string | null; auth?: NetAuth }): Promise<WorktreeInfo> {
  const worktreePath = path.join(o.worktreesDir, o.taskId);
  await recreateWorktree({ repo: o.repo, worktreePath, branch: o.branch, remote: o.remote, auth: o.auth });
  const gitDir = await git(o.repo, ['rev-parse', '--git-common-dir']);
  const exclude = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(o.repo, gitDir), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.sdlc/')) fs.appendFileSync(exclude, (cur.endsWith('\n') || cur === '' ? '' : '\n') + '.sdlc/\n');
  return { worktreePath, branch: o.branch, baseRef: o.remote ? `${o.remote}/${o.branch}` : o.branch };
}

/** Merge `head` into `base` without a PR, in a temporary worktree of the main checkout; pushes when the base has a remote. */
export async function mergeLocally(o: { repo: string; base: string; baseRemote: string | null; head: string; method: 'merge' | 'squash' | 'rebase'; message: string; author: string; auth?: NetAuth }): Promise<string> {
  const tmp = path.join(os.tmpdir(), `sdlc-land-${Date.now()}`);
  const env = authorEnv(o.author);
  if (o.baseRemote && !(await fetchBranch(o.repo, o.baseRemote, o.base, o.auth))) throw new Error(`base branch ${o.base} does not exist on ${o.baseRemote}`);
  const baseRef = o.baseRemote ? `refs/remotes/${o.baseRemote}/${o.base}` : `refs/heads/${o.base}`;
  // detached worktree at the base tip: no local branch is checked out twice
  await git(o.repo, ['worktree', 'add', '--detach', tmp, baseRef]);
  try {
    if (o.method === 'rebase') { await git(tmp, ['merge', '--ff-only', o.head], { env }).catch(async () => { await git(tmp, ['checkout', '--detach', o.head]); await git(tmp, ['rebase', baseRef], { env }); }); }
    else if (o.method === 'squash') { await git(tmp, ['merge', '--squash', o.head], { env }); await git(tmp, ['commit', '-q', '-m', o.message], { env }); }
    else await git(tmp, ['merge', '--no-ff', '-m', o.message, o.head], { env });
    const sha = await git(tmp, ['rev-parse', 'HEAD']);
    if (o.baseRemote) await git(tmp, ['push', o.baseRemote, `HEAD:refs/heads/${o.base}`], { env: netEnv(o.auth) });
    else {
      const wt = await worktreeFor(o.repo, o.base);
      if (wt) await git(wt, ['merge', '--ff-only', '--quiet', sha], { env });   // base is checked out somewhere: fast-forward it there
      else await git(o.repo, ['update-ref', `refs/heads/${o.base}`, sha]);
    }
    return sha;
  } finally {
    await git(o.repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });
    await git(o.repo, ['worktree', 'prune'], { allowFail: true });
  }
}

/**
 * After a merge on the remote: fast-forward the local copy of the base branch when that is safe (no local commits of
 * its own; when it is checked out, only in a clean working tree). Never creates the branch.
 */
export async function syncLocalBase(repo: string, remote: string | null, base: string, auth?: NetAuth): Promise<void> {
  if (!remote) return;
  if (!(await fetchBranch(repo, remote, base, auth).catch(() => false))) return;
  const rem = await git(repo, ['rev-parse', `refs/remotes/${remote}/${base}`]);
  const local = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], { allowFail: true });
  if (!local || local === rem || !(await isAncestor(repo, local, rem))) return;
  const wt = await worktreeFor(repo, base);
  if (!wt) { await git(repo, ['update-ref', `refs/heads/${base}`, rem, local], { allowFail: true }); return; }
  const dirty = await git(wt, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true });
  if (!dirty) await git(wt, ['merge', '--ff-only', '--quiet', rem], { allowFail: true });
}

export async function deleteLocalBranch(repo: string, branch: string): Promise<boolean> {
  if (!(await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }))) return false;
  try { await git(repo, ['branch', '-D', branch]); return true; } catch { return false; }
}

export async function deleteRemoteBranch(repo: string, remote: string | null, branch: string, auth?: NetAuth): Promise<boolean> {
  if (!remote || !(await remotes(repo)).includes(remote)) return false;
  let ok = true;
  try { await git(repo, ['push', remote, '--delete', branch], { env: netEnv(auth) }); } catch { ok = false; }
  await git(repo, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`], { allowFail: true });
  return ok;
}

/** Re-attach a worktree for an existing task branch (after cleanup), e.g. for a PR feedback round. */
export async function recreateWorktree(o: { repo: string; worktreePath: string; branch: string; remote: string | null; auth?: NetAuth }): Promise<void> {
  if (fs.existsSync(path.join(o.worktreePath, '.git'))) return;
  await git(o.repo, ['worktree', 'prune'], { allowFail: true });
  const onRemote = o.remote ? await fetchBranch(o.repo, o.remote, o.branch, o.auth).catch(() => false) : false;
  const local = await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], { allowFail: true });
  fs.mkdirSync(path.dirname(o.worktreePath), { recursive: true });
  if (local) await git(o.repo, ['worktree', 'add', o.worktreePath, o.branch]);
  else if (onRemote) await git(o.repo, ['worktree', 'add', '-b', o.branch, o.worktreePath, `refs/remotes/${o.remote}/${o.branch}`]);
  else throw new Error(`branch ${o.branch} exists neither locally nor on ${o.remote ?? 'a remote'}`);
  // catch up with commits pushed from elsewhere; local-only commits are kept (never reset)
  if (local && onRemote && (await isAncestor(o.repo, local, `refs/remotes/${o.remote}/${o.branch}`))) await git(o.worktreePath, ['merge', '--ff-only', '--quiet', `refs/remotes/${o.remote}/${o.branch}`], { allowFail: true });
  fs.mkdirSync(path.join(o.worktreePath, '.sdlc'), { recursive: true });
}

export async function removeWorktree(repo: string, worktreePath: string, branch: string, opts: { deleteBranchIfEmpty?: string } = {}): Promise<{ removed: boolean; branchDeleted: boolean }> {
  let removed = false;
  if (fs.existsSync(worktreePath)) { await git(repo, ['worktree', 'remove', '--force', worktreePath]); removed = true; }
  await git(repo, ['worktree', 'prune'], { allowFail: true });
  let branchDeleted = false;
  if (opts.deleteBranchIfEmpty) {
    const count = await git(repo, ['rev-list', '--count', `${opts.deleteBranchIfEmpty}..${branch}`], { allowFail: true });
    if (count === '0') { await git(repo, ['branch', '-D', branch], { allowFail: true }); branchDeleted = true; }
  }
  return { removed, branchDeleted };
}

export async function commitAll(wt: string, message: string, author: string): Promise<{ sha: string | null; skipped: boolean }> {
  await git(wt, ['add', '-A']);
  const status = await git(wt, ['status', '--porcelain']);
  if (!status) return { sha: null, skipped: true };
  const env = authorEnv(author);
  await git(wt, ['commit', '-q', '-m', message], { env });
  return { sha: await git(wt, ['rev-parse', 'HEAD']), skipped: false };
}

export async function diffAgainst(wt: string, baseRef: string, maxBytes = 400_000): Promise<{ stat: string; patch: string; commits: string[]; truncated: boolean }> {
  const stat = await git(wt, ['diff', '--stat', `${baseRef}...HEAD`], { allowFail: true });
  let patch = await git(wt, ['diff', `${baseRef}...HEAD`], { allowFail: true });
  let truncated = false;
  if (Buffer.byteLength(patch) > maxBytes) { patch = patch.slice(0, maxBytes) + '\n\n[... diff truncated by sdlc ...]\n'; truncated = true; }
  const log = await git(wt, ['log', '--oneline', `${baseRef}..HEAD`], { allowFail: true });
  return { stat, patch, commits: log ? log.split('\n') : [], truncated };
}

/** New-side line numbers of the branch diff (added and context lines), per file: the lines a PR review comment may anchor to. */
export async function diffRightLines(wt: string, baseRef: string): Promise<Map<string, Set<number>>> {
  const out = await git(wt, ['diff', '--unified=3', '--no-color', `${baseRef}...HEAD`], { allowFail: true });
  const map = new Map<string, Set<number>>();
  let file: string | null = null; let line = 0; let inHunk = false;
  for (const l of out.split('\n')) {
    if (l.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!inHunk && l.startsWith('+++ ')) { const p = l.slice(4).trim(); file = p === '/dev/null' ? null : p.replace(/^b\//, ''); if (file && !map.has(file)) map.set(file, new Set()); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { line = Number(h[1]); inHunk = true; continue; }
    if (!file || !inHunk) continue;
    if (l.startsWith('+') || l.startsWith(' ')) { map.get(file)!.add(line); line++; }
  }
  return map;
}

export async function push(wt: string, remote: string, branch: string, auth?: NetAuth): Promise<void> { await git(wt, ['push', '-u', remote, `refs/heads/${branch}:refs/heads/${branch}`], { env: netEnv(auth) }); }
export async function remoteHasBranch(cwd: string, remote: string, branch: string, auth?: NetAuth): Promise<boolean> { return (await git(cwd, ['ls-remote', '--heads', remote, branch], { allowFail: true, env: netEnv(auth) })) !== ''; }
/** Publish a local branch without changing its upstream (used for a local base branch before a PR). */
export async function pushBranch(cwd: string, remote: string, branch: string, auth?: NetAuth): Promise<void> { await git(cwd, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], { env: netEnv(auth) }); }
