import fs from 'node:fs';
import type { PhaseRun, ReviewFinding } from '@sdlc/shared';
import type { GitPhaseSpec } from '../pipeline/schema.js';
import { renderTemplate } from '../pipeline/template.js';
import { resolvePipelineFile } from '../pipeline/loader.js';
import { commitAll, diffRightLines, push, pushBranch, remoteHasBranch } from '../git/git.js';
import type { ReviewEventName } from '../git/gh.js';
import { nowIso } from '../store/ids.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export class GitPhaseExecutor implements PhaseExecutor<GitPhaseSpec> {
  async run(phase: GitPhaseSpec, pr: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome> {
    const { task, events, config, github } = ctx;
    try {
      if (phase.git === 'commit') {
        const msg = renderTemplate(phase.message ?? 'sdlc({{task.id}}): {{task.title}}', ctx.tpl) + `\n\nTask: ${task.id}`;
        const r = await commitAll(task.worktreePath, msg, config.git_author);
        pr.resultText = r.skipped ? 'nothing to commit' : `committed ${r.sha}`;
        if (r.sha) events.emit('git.committed', { taskId: task.id, sha: r.sha, message: msg.split('\n')[0]! }, { taskId: task.id, phaseRunId: pr.id });
        pr.endedAt = nowIso();
        return { kind: 'ok' };
      }
      const auth = await ctx.accounts.forRepo(task.repoPath);
      if (phase.git === 'push') {
        const remote = task.baseRemote ?? 'origin';
        await push(task.worktreePath, remote, task.branch, auth);
        pr.resultText = `pushed ${task.branch} to ${remote}${auth.user ? ` as ${auth.user}` : ''}`;
        events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id, phaseRunId: pr.id });
      } else if (phase.git === 'comment') {
        if (!task.prNumber) { pr.resultText = 'no pull request; nothing to comment on'; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        const body = phase.body ? renderTemplate(fs.readFileSync(resolvePipelineFile(ctx.loaded, phase.body), 'utf8'), ctx.tpl) : renderTemplate(phase.message ?? '', ctx.tpl);
        if (!body.trim()) { pr.resultText = 'empty comment; skipped'; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        await github.prComment(task.repoPath, task.prNumber, body.slice(0, 60_000), auth);
        pr.resultText = `commented on PR #${task.prNumber}`;
      } else if (phase.git === 'review') {
        // publish what the human marked `post` at the latest approved result checkpoint
        if (!task.prNumber) { pr.resultText = 'no pull request; nothing to publish'; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        const hil = ctx.store.listHil({ taskId: task.id, status: 'answered' }).find((h) => h.payload.kind === 'approve_result' && h.payload.focus === 'review' && h.response?.decision === 'approve');
        if (!hil || hil.payload.kind !== 'approve_result' || !hil.response) { pr.resultText = 'no approved review; nothing to publish'; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        if (ctx.store.phaseRunsForRun(ctx.run.id).some((p) => p.phaseName === phase.name && p.status === 'succeeded' && p.resultText?.includes(hil.id))) { pr.resultText = `already published (${hil.id})`; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        const resp = hil.response;
        const chosen = (hil.payload.review?.findings ?? []).filter((_, i) => resp.findings?.[`review:${i}`] === 'post');
        // approving or requesting changes on your own pull request is rejected by GitHub: the author side only comments
        const event = (ctx.role === 'reviewer' ? (resp.reviewEvent ?? 'comment') : 'comment').toUpperCase() as ReviewEventName;
        const note = resp.comment?.trim() ?? '';
        if (!chosen.length && !note && event === 'COMMENT') { pr.resultText = 'nothing marked to publish'; pr.endedAt = nowIso(); return { kind: 'skipped' }; }
        const text = (f: ReviewFinding) => `**${f.severity}: ${f.title}**\n\n${f.description}${f.suggestion ? `\n\nSuggestion: ${f.suggestion}` : ''}`;
        const anchors = await diffRightLines(task.worktreePath, (ctx.tpl.task as { base_ref: string }).base_ref);
        const inline = chosen.filter((f) => f.file && f.line && anchors.get(f.file)?.has(f.line));
        const loose = chosen.filter((f) => !inline.includes(f));
        const body = [note, ...loose.map((f) => `${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${text(f)}`)].filter(Boolean).join('\n\n---\n\n');
        await github.postReview({ cwd: task.repoPath, number: task.prNumber, event, body, comments: inline.map((f) => ({ path: f.file!, line: f.line!, body: text(f) })) }, auth);
        pr.resultText = `published ${chosen.length} finding(s) on PR #${task.prNumber} as ${event} (${inline.length} inline, ${loose.length} in the review text) from ${hil.id}`;
      } else {
        const remote = task.baseRemote ?? 'origin';
        // a local-only base branch cannot be the base of a PR: publish it first
        if (!task.baseRemote && !task.prNumber && !(await remoteHasBranch(task.worktreePath, remote, task.baseBranch, auth))) {
          await pushBranch(task.worktreePath, remote, task.baseBranch, auth);
          events.emit('git.pushed', { taskId: task.id, branch: task.baseBranch }, { taskId: task.id, phaseRunId: pr.id });
        }
        await push(task.worktreePath, remote, task.branch, auth);
        events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id, phaseRunId: pr.id });
        if (task.prNumber) {
          // the PR exists: every loop only pushes; reviewers hear back once per round of their comments that was taken into work
          const prevPush = ctx.store.phaseRunsForRun(ctx.run.id).filter((p) => p.phaseName === phase.name && p.status === 'succeeded').at(-1);
          const round = ctx.store.listHil({ taskId: task.id, status: 'answered' }).find((h) => h.kind === 'pr_feedback' && h.response?.decision === 'approve');
          if (round?.answeredAt && round.answeredAt > (prevPush?.endedAt ?? '')) {
            const impl = ctx.store.latestPhaseRun(ctx.run.id, 'implement', ['succeeded']);
            await github.prComment(task.repoPath, task.prNumber, `sdlc addressed the review comments in the latest push.\n\n${impl?.resultText ?? ''}`.slice(0, 60_000), auth);
            pr.resultText = `pushed and commented on PR #${task.prNumber}`;
          } else pr.resultText = `pushed to PR #${task.prNumber}`;
          pr.endedAt = nowIso();
          return { kind: 'ok' };
        }
        const p = phase.pr ?? { draft: false, post_review: false };
        const draft = typeof p.draft === 'string' ? renderTemplate(p.draft, ctx.tpl) === 'true' : p.draft;
        const title = renderTemplate(p.title ?? '{{task.title}}', ctx.tpl);
        const body = p.body ? renderTemplate(fs.readFileSync(resolvePipelineFile(ctx.loaded, p.body), 'utf8'), ctx.tpl) : `Task: ${task.id}`;
        const created = await github.prCreate({ cwd: task.repoPath, head: task.branch, base: task.baseBranch, title, body, draft }, auth);
        task.prUrl = created.url; task.prNumber = created.number;
        pr.resultText = created.url;
        events.emit('git.pr_created', { taskId: task.id, url: created.url, number: created.number }, { taskId: task.id, phaseRunId: pr.id });
      }
      pr.endedAt = nowIso();
      return { kind: 'ok' };
    } catch (e) {
      pr.error = e instanceof Error ? e.message : String(e);
      pr.endedAt = nowIso();
      return { kind: 'failed', error: pr.error };
    }
  }
}
