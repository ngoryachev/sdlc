import { execFile } from 'node:child_process';
import fs from 'node:fs';
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

export async function repoToplevel(p: string): Promise<string> { return git(p, ['rev-parse', '--show-toplevel']); }

export async function remotes(repo: string): Promise<string[]> { const s = await git(repo, ['remote']); return s ? s.split('\n') : []; }

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

export async function createWorktree(opts: { repo: string; worktreesDir: string; taskId: string; baseRemote: string | null; baseBranch: string; copyUntracked?: string[] }): Promise<WorktreeInfo> {
  const { repo, taskId } = opts;
  if (opts.baseRemote) await git(repo, ['fetch', opts.baseRemote, opts.baseBranch], { allowFail: true });
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

/** Re-attach a worktree for an existing task branch (after cleanup), e.g. for a PR feedback round. */
export async function recreateWorktree(o: { repo: string; worktreePath: string; branch: string; remote: string | null }): Promise<void> {
  if (fs.existsSync(path.join(o.worktreePath, '.git'))) return;
  await git(o.repo, ['worktree', 'prune'], { allowFail: true });
  if (o.remote) await git(o.repo, ['fetch', o.remote, o.branch], { allowFail: true });
  const local = await git(o.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${o.branch}`], { allowFail: true });
  fs.mkdirSync(path.dirname(o.worktreePath), { recursive: true });
  if (local) await git(o.repo, ['worktree', 'add', o.worktreePath, o.branch]);
  else await git(o.repo, ['worktree', 'add', '-b', o.branch, o.worktreePath, `${o.remote}/${o.branch}`]);
  if (o.remote) await git(o.worktreePath, ['reset', '--hard', `${o.remote}/${o.branch}`], { allowFail: true });
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
  const m = /^(.*) <(.*)>$/.exec(author);
  const env = m ? { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2] } : {};
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

export async function push(wt: string, remote: string, branch: string): Promise<void> { await git(wt, ['push', '-u', remote, branch]); }
