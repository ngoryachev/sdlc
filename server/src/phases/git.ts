import fs from 'node:fs';
import type { PhaseRun } from '@sdlc/shared';
import type { GitPhaseSpec } from '../pipeline/schema.js';
import { renderTemplate } from '../pipeline/template.js';
import { resolvePipelineFile } from '../pipeline/loader.js';
import { commitAll, push } from '../git/git.js';
import { createPr, postReview, prComment } from '../git/gh.js';
import { nowIso } from '../store/ids.js';
import type { PhaseContext, PhaseExecutor, PhaseOutcome } from './executor.js';

export class GitPhaseExecutor implements PhaseExecutor<GitPhaseSpec> {
  async run(phase: GitPhaseSpec, pr: PhaseRun, ctx: PhaseContext): Promise<PhaseOutcome> {
    const { task, events, config } = ctx;
    try {
      if (phase.git === 'commit') {
        const msg = renderTemplate(phase.message ?? 'sdlc({{task.id}}): {{task.title}}', ctx.tpl) + `\n\nTask: ${task.id}`;
        const r = await commitAll(task.worktreePath, msg, config.git_author);
        pr.resultText = r.skipped ? 'nothing to commit' : `committed ${r.sha}`;
        if (r.sha) events.emit('git.committed', { taskId: task.id, sha: r.sha, message: msg.split('\n')[0]! }, { taskId: task.id, phaseRunId: pr.id });
      } else if (phase.git === 'push') {
        const remote = task.baseRemote ?? 'origin';
        await push(task.worktreePath, remote, task.branch);
        pr.resultText = `pushed ${task.branch} to ${remote}`;
        events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id, phaseRunId: pr.id });
      } else {
        const remote = task.baseRemote ?? 'origin';
        await push(task.worktreePath, remote, task.branch);
        events.emit('git.pushed', { taskId: task.id, branch: task.branch }, { taskId: task.id, phaseRunId: pr.id });
        if (task.prNumber) {
          // PR already exists (pr_feedback round): report what was done
          const impl = ctx.store.latestPhaseRun(ctx.run.id, 'implement', ['succeeded']);
          const body = `sdlc addressed the review comments in the latest push.\n\n${impl?.resultText ?? ''}`.slice(0, 60_000);
          await prComment(task.worktreePath, task.prNumber, body);
          pr.resultText = `pushed and commented on PR #${task.prNumber}`;
          pr.endedAt = nowIso();
          return { kind: 'ok' };
        }
        const p = phase.pr ?? { draft: true, post_review: false };
        const draft = typeof p.draft === 'string' ? renderTemplate(p.draft, ctx.tpl) === 'true' : p.draft;
        const title = renderTemplate(p.title ?? '{{task.title}}', ctx.tpl);
        const body = p.body ? renderTemplate(fs.readFileSync(resolvePipelineFile(ctx.loaded, p.body), 'utf8'), ctx.tpl) : `Task: ${task.id}`;
        const created = await createPr({ cwd: task.worktreePath, head: task.branch, base: task.baseBranch, title, body, draft });
        task.prUrl = created.url; task.prNumber = created.number;
        pr.resultText = created.url;
        events.emit('git.pr_created', { taskId: task.id, url: created.url, number: created.number }, { taskId: task.id, phaseRunId: pr.id });
        const wantReview = typeof p.post_review === 'string' ? renderTemplate(p.post_review, ctx.tpl) === 'true' : p.post_review;
        if (wantReview) {
          const review = ctx.tpl.phases && (ctx.tpl.phases as Record<string, { structured?: unknown }>).review?.structured;
          if (review) await postReview({ cwd: task.worktreePath, number: created.number, review: review as never });
        }
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
