/**
 * The two outward links a task carries: its Jira issue and its branch on GitHub. Composed here and nowhere else, so
 * the task page, the HIL card, the Telegram buttons and the pull request body cannot disagree — and so that a missing
 * input (no `jira_url` for the repository, no issue key, no slug, a branch that was never pushed) means no link at
 * all rather than one that leads nowhere. Sibling of jira.ts, which finds the key itself.
 */
import path from 'node:path';
import type { Task } from '@sdlc/shared';
import type { SdlcConfig } from '../config/config.js';
import type { EventBus } from '../store/events.js';

export interface TaskLinks {
  /** `<jira_url>/browse/<KEY>`, or null. */
  jiraUrl: string | null;
  /** `https://github.com/<slug>/tree/<branch>`, or null. */
  branchUrl: string | null;
}

/** What `taskLinks` needs: structural, so the engine's deps, an `App` and the notifiers all fit. */
export interface LinkDeps { config: SdlcConfig; events: Pick<EventBus, 'ofType'> }

export const NO_LINKS: TaskLinks = { jiraUrl: null, branchUrl: null };

/**
 * The issue page of a key on a Jira base URL. The stored value is normalised rather than trusted: a trailing slash is
 * dropped, and a base that already ends in `/browse` (what one gets by copying an issue URL) does not grow a second one.
 */
export function jiraIssueUrl(base: string | null | undefined, key: string | null | undefined): string | null {
  if (!base || !key) return null;
  let b = base.trim().replace(/\/+$/, '');
  if (b.endsWith('/browse')) b = b.slice(0, -'/browse'.length).replace(/\/+$/, '');
  return b ? `${b}/browse/${key}` : null;
}

/** The branch page on GitHub. The slashes of a branch name are path separators there, everything else is escaped. */
export function branchTreeUrl(slug: string | null | undefined, branch: string | null | undefined): string | null {
  if (!slug || !branch) return null;
  return `https://github.com/${slug}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Whether the branch is on the remote, as far as sdlc knows without asking git: it pushed it at some point, or the task
 * hangs on a pull request (whose head branch is on GitHub by definition) — and sdlc has not swept it since. Delivery
 * (land, close with --delete-branch, the cleanup of an aborted task) deletes the branch, and a link to a branch that is
 * gone is a 404, so a `task.worktree` event reporting the deletion retracts it; a later push brings it back, which is
 * why the history is walked in order. `branchDeleted` is also set when only the local copy went while the remote
 * survived: hiding a link that would have worked beats offering one that does not. Same source as the pr_open wording.
 */
export function branchPushed(events: Pick<EventBus, 'ofType'>, task: Task): boolean {
  let onRemote = task.prNumber != null;
  for (const e of events.ofType(task.id, ['git.pushed', 'task.worktree'])) {
    if (e.type === 'git.pushed') { if ((e.payload as { branch?: string }).branch === task.branch) onRemote = true; }
    else if ((e.payload as { branchDeleted?: boolean }).branchDeleted) onRemote = false;
  }
  return onRemote;
}

/** Both links of a task, each null unless everything it needs is there. */
export function taskLinks(d: LinkDeps, task: Task): TaskLinks {
  const repoPath = path.resolve(task.repoPath);
  const repo = d.config.repos.find((r) => path.resolve(r.path) === repoPath);
  return {
    jiraUrl: jiraIssueUrl(repo?.jira_url, task.jiraKey),
    branchUrl: branchPushed(d.events, task) ? branchTreeUrl(task.repoSlug, task.branch) : null,
  };
}

/** The `task.jira_url` / `task.branch_url` template variables: a missing link is the empty string, as `{{x?}}` renders it. */
export function linkTemplateVars(d: LinkDeps, task: Task): { jira_url: string; branch_url: string } {
  const { jiraUrl, branchUrl } = taskLinks(d, task);
  return { jira_url: jiraUrl ?? '', branch_url: branchUrl ?? '' };
}

/** The template variables that own a line of their own in a body template (see `renderBody`). */
export const LINK_VARS = ['task.jira_url', 'task.branch_url'];
