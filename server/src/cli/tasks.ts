import fs from 'node:fs';
import path from 'node:path';
const require_resolve = (p: string) => path.resolve(p);
import type { Command } from 'commander';
import type { SdlcEvent, HilRequest } from '@sdlc/shared';
import { createApp } from '../app.js';
import { ServerClient, untilTaskSettles } from './client.js';
import type { Task, HilRequest as Hil } from '@sdlc/shared';
import { summarize } from '../claude/render.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function printEvent(e: SdlcEvent) {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'task.status': console.log(`[task] ${(p.from as string)} → ${(p.to as string)}`); break;
    case 'phase.started': { const pr = p.phaseRun as { phaseName: string; attempt: number }; console.log(`\n=== phase ${pr.phaseName} (attempt ${pr.attempt}) ===`); break; }
    case 'phase.finished': { const pr = p.phaseRun as { phaseName: string; status: string; costUsd: number; error?: string }; console.log(`=== ${pr.phaseName}: ${pr.status}${pr.costUsd ? ` $${pr.costUsd.toFixed(3)}` : ''}${pr.error ? ` — ${pr.error}` : ''}`); break; }
    case 'phase.progress': break; // shown via messages
    case 'hil.requested': { const h = p.hil as HilRequest; console.log(`\n>>> HIL ${h.kind} [${h.id}] ${h.summary}`); break; }
    case 'git.committed': console.log(`[git] committed ${(p.sha as string).slice(0, 8)} ${p.message}`); break;
    case 'git.pr_created': console.log(`[git] PR ${p.url}`); break;
    case 'task.worktree': console.log(`[worktree] ${p.action as string}${p.branchDeleted ? ' (branch deleted)' : ''}`); break;
    case 'task.branch': console.log(`[branch] ${p.from as string} → ${p.to as string}`); break;
    case 'task.updated': console.log(`[task] ${p.change as string}`); break;
    case 'git.merged': console.log(`[git] merged into ${p.into as string} (${p.method as string}, via ${p.via as string})`); break;
    case 'engine.error': console.error(`[error] ${p.message}`); break;
    case 'engine.warning': console.error(`[warn] ${p.message}`); break;
    default: break;
  }
}

/** Runs the engine in-process and prints events until the task blocks (HIL) or finishes. */
export function registerTaskCommands(program: Command) {
  program.command('new <prompt>')
    .description('Create a task and run it in-process until it needs a human or finishes')
    .requiredOption('--repo <path>', 'target repository')
    .option('--pipeline <name>', 'pipeline name or path')
    .option('--base <remote/branch>', 'base ref, e.g. origin/main')
    .option('--review-mode <mode>', 'conceptual|line')
    .option('--post-review', 'post line review to GitHub')
    .option('--branch <name>', 'work on an existing branch instead of creating one')
    .option('--start-at <phase>', 'start the pipeline at this phase (earlier phases are skipped)')
    .option('--quiet', 'do not print the Claude stream')
    .action(async (prompt: string, o) => {
      let baseRemote: string | null | undefined; let baseBranch: string | undefined;
      if (o.base) { const [r, ...rest] = String(o.base).split('/'); if (rest.length) { baseRemote = r; baseBranch = rest.join('/'); } else { baseRemote = null; baseBranch = r; } }
      const remote = await ServerClient.detect();
      if (remote) {
        const task = await remote.call<Task>('POST', '/tasks', { prompt, repoPath: require_resolve(o.repo), pipeline: o.pipeline, baseRemote, baseBranch, reviewMode: o.reviewMode, postReview: o.postReview, branch: o.branch, startAt: o.startAt });
        console.log(`[server ${remote.base}] task ${task.id} branch ${task.branch}`);
        await remote.tail(task.id, printEvent, (m) => { if (!o.quiet) { const s = summarize(m.sdk as SDKMessage); if (s) console.log(s); } }, untilTaskSettles);
        const t = await remote.call<{ task: Task; openHil: Hil[] }>('GET', `/tasks/${task.id}`);
        console.log(`\nstatus: ${t.task.status}  cost: $${t.task.totalCostUsd.toFixed(3)}`);
        for (const h of t.openHil) console.log(`open HIL: ${h.kind} ${h.id} — ${remote.base}/hil/${h.id}`);
        return;
      }
      const app = createApp();
      app.events.on(printEvent);
      if (!o.quiet) app.events.onMessage((m) => { const s = summarize(m.sdk as SDKMessage); if (s) console.log(s); });
      const task = await app.engine.createTask({ prompt, repoPath: o.repo, pipeline: o.pipeline, baseRemote, baseBranch, reviewMode: o.reviewMode, postReview: o.postReview, branch: o.branch, startAt: o.startAt });
      console.log(`task ${task.id} branch ${task.branch}\nworktree ${task.worktreePath}`);
      await app.engine.advance(task.id);
      const t = app.store.getTask(task.id)!;
      console.log(`\nstatus: ${t.status}  cost: $${t.totalCostUsd.toFixed(3)}`);
      for (const h of app.store.openHilForTask(t.id)) console.log(`open HIL: ${h.kind} ${h.id} — respond with: sdlc approve ${h.id} | sdlc changes ${h.id} -m "..."`);
    });

  program.command('list').description('List tasks').option('--status <s>', 'filter by status').action((o) => {
    const app = createApp();
    for (const t of app.store.listTasks(o.status ? [o.status] : undefined)) console.log(`${t.id}  ${t.status.padEnd(12)} $${t.totalCostUsd.toFixed(2).padStart(6)}  ${t.pipelineName.padEnd(8)} ${t.title}`);
  });

  program.command('show <taskId>').description('Show a task').action((id) => {
    const app = createApp();
    const t = app.store.getTask(id); if (!t) throw new Error('not found');
    console.log(JSON.stringify({ task: t, run: app.store.latestRunForTask(id), phases: app.store.phaseRunsForTask(id).map((p) => ({ name: p.phaseName, attempt: p.attempt, status: p.status, cost: p.costUsd, error: p.error })), hil: app.store.openHilForTask(id) }, null, 2));
  });

  program.command('hil').description('List open HIL requests').action(() => {
    const app = createApp();
    for (const h of app.store.listHil({ status: 'open' })) console.log(`${h.id}  ${h.kind.padEnd(14)} ${h.taskId}  ${h.summary}`);
  });

  program.command('adopt').description('Create a task from an existing pull request; it waits for PR feedback (`sdlc pr <task>`)').requiredOption('--repo <path>').requiredOption('--pr <number>').option('--pipeline <name>').action(async (o) => {
    const remote = await ServerClient.detect();
    const body = { repoPath: require_resolve(o.repo), number: Number(o.pr), pipeline: o.pipeline };
    const t = remote ? await remote.call<Task>('POST', '/tasks/import-pr', body) : await createApp().engine.importPr(body);
    console.log(`task ${t.id} (${t.status}) branch ${t.branch} ← ${t.baseRemote ? `${t.baseRemote}/` : ''}${t.baseBranch}\n${t.prUrl}`);
  });
  program.command('land <taskId>').description('Merge the task branch into its base (via the PR when present), restack tasks built on it, remove worktree and branch').option('--method <m>', 'merge|squash|rebase (default from config)').action(async (id, o) => {
    const remote = await ServerClient.detect();
    const r = remote ? await remote.call<{ method: string; via: string; notes: string[] }>('POST', `/tasks/${id}/land`, { method: o.method }) : await createApp().engine.landTask(id, o.method);
    console.log(`merged (${r.method}, via ${r.via}); worktree and branch removed`);
    for (const n of r.notes ?? []) console.log(`  ${n}`);
  });
  program.command('create-pr <taskId>').description('Open a pull request for a finished task that has none').option('--title <t>').option('--draft').action(async (id, o) => {
    const remote = await ServerClient.detect();
    const t = remote ? await remote.call<Task>('POST', `/tasks/${id}/pr`, { title: o.title, draft: !!o.draft }) : await createApp().engine.createPrForTask(id, { title: o.title, draft: !!o.draft });
    console.log(`PR #${t.prNumber} ${t.prUrl}`);
  });
  program.command('close <taskId>').description('Close a task without merging (worktree removed; PR closed unless --keep-pr)').option('--delete-branch', 'also delete the branch (local, and remote for sdlc branches)').option('--keep-pr', 'leave the PR open').action(async (id, o) => {
    const remote = await ServerClient.detect();
    const body = { deleteBranch: !!o.deleteBranch, closePr: !o.keepPr };
    const t = remote ? await remote.call<Task>('POST', `/tasks/${id}/close`, body) : await createApp().engine.closeTask(id, body);
    console.log(`task ${t.id} ${t.status}`);
  });
  program.command('sync').description('Reconcile tasks with GitHub now: merged/closed PRs, base changes, branches merged outside sdlc').action(async () => {
    const remote = await ServerClient.detect();
    const r = remote ? await remote.call<{ checked: number; changes: { taskId: string; title: string; change: string }[]; errors: string[] }>('POST', '/tasks/sync') : await createApp().engine.syncTasks();
    console.log(`checked ${r.checked} task(s)`);
    for (const ch of r.changes) console.log(`  ${ch.taskId} ${ch.title}: ${ch.change}`);
    for (const e of r.errors) console.error(`  error ${e}`);
  });
  program.command('hil-show <hilId>').alias('show-hil').description('Show a HIL request with its payload (prompt, plan, review, tests, QA, diff stat)').option('--diff', 'also print the patch').action(async (id, o) => {
    const remote = await ServerClient.detect();
    const h = remote ? await remote.call<Hil>('GET', `/hil/${id}`) : createApp().store.getHil(id);
    if (!h) throw new Error('hil not found');
    console.log(`${h.id}  ${h.kind}  task ${h.taskId}  [${h.status}]\n${h.summary}\nallowed: ${h.allowedDecisions.join(', ')}\n`);
    printHilPayload(h.payload, !!o.diff);
  });
  program.command('cleanup <taskId>').description('Remove the task worktree (branch is kept; a PR feedback round re-creates it)').action(async (id) => {
    const remote = await ServerClient.detect();
    const r = remote ? await remote.call<{ removed: boolean }>('POST', `/tasks/${id}/worktree/remove`) : await createApp().engine.removeTaskWorktree(id);
    console.log(r.removed ? 'worktree removed' : 'no worktree to remove');
  });

  const respond = async (hilId: string, decision: string, o: { message?: string; prompt?: string; title?: string; plan?: string; answer?: string[] }, run = true) => {
    const answers0: Record<string, string> = {};
    for (const a of o.answer ?? []) { const i = a.indexOf('='); if (i > 0) answers0[a.slice(0, i)] = a.slice(i + 1); }
    const remote = await ServerClient.detect();
    if (remote) {
      const since = (await remote.call<{ id: number }>('GET', '/events/last')).id;
      const h = await remote.call<Hil>('POST', `/hil/${hilId}/respond`, { decision, comment: o.message, edited: { prompt: o.prompt, planMd: o.plan, title: o.title }, answers: answers0 });
      console.log(`[server] ${h.kind} → ${decision}`);
      if (run) await remote.tail(h.taskId, printEvent, (m) => { const s = summarize(m.sdk as SDKMessage); if (s) console.log(s); }, untilTaskSettles, since);
      return;
    }
    const app = createApp();
    app.events.on(printEvent);
    app.events.onMessage((m) => { const s = summarize(m.sdk as SDKMessage); if (s) console.log(s); });
    const answers: Record<string, string> = {};
    for (const a of o.answer ?? []) { const i = a.indexOf('='); if (i > 0) answers[a.slice(0, i)] = a.slice(i + 1); }
    const hil = await app.engine.respondHil(hilId, { decision: decision as never, comment: o.message, edited: { prompt: o.prompt, planMd: o.plan, title: o.title }, answers }, 'cli');
    if (run) { await app.engine.advance(hil.taskId); const t = app.store.getTask(hil.taskId)!; console.log(`\nstatus: ${t.status}  cost: $${t.totalCostUsd.toFixed(3)}`); for (const h of app.store.openHilForTask(t.id)) console.log(`open HIL: ${h.kind} ${h.id}`); }
  };
  program.command('approve <hilId>').description('Approve a HIL request').option('-m, --message <text>').option('--prompt <text>', 'edited prompt (refine)').option('--title <text>', 'task title (refine)').option('--plan <file>', 'edited plan file (approve_plan)').action((id, o) => respond(id, 'approve', { ...o, plan: o.plan ? fs.readFileSync(o.plan, 'utf8') : undefined }));
  program.command('changes <hilId>').description('Request changes with a comment').requiredOption('-m, --message <text>').action((id, o) => respond(id, 'request_changes', o));
  program.command('answer <hilId>').description('Answer a question HIL: --answer "question=label"').option('--answer <q=a>', 'answer', (v: string, acc: string[]) => { acc.push(v); return acc; }, [] as string[]).option('-m, --message <text>').action((id, o) => respond(id, 'answer', o));
  program.command('decide <hilId> <decision>').description('Respond with any decision (retry|resume|skip|abort|approve|request_changes)').option('-m, --message <text>').action((id, d, o) => respond(id, d, o));
  const control = (action: 'pause' | 'resume' | 'abort', body?: unknown) => async (id: string, o: { message?: string } = {}) => {
    const remote = await ServerClient.detect();
    if (remote) { await remote.call('POST', `/tasks/${id}/${action}`, action === 'resume' ? { guidance: o.message } : body); console.log(`[server] ${action} ok`); return; }
    const app = createApp(); app.events.on(printEvent);
    if (action === 'pause') await app.engine.pause(id); else if (action === 'abort') await app.engine.abort(id); else { await app.engine.resume(id, o.message); await app.engine.advance(id); }
  };
  program.command('resume <taskId>').description('Resume a paused task').option('-m, --message <text>', 'guidance').action(control('resume'));
  program.command('pause <taskId>').action(control('pause'));
  program.command('abort <taskId>').action(control('abort'));
  program.command('inject <taskId> <text>').action(async (id, text) => { const remote = await ServerClient.detect(); if (remote) return console.log(await remote.call('POST', `/tasks/${id}/inject`, { text })); const app = createApp(); console.log(app.engine.inject(id, text)); });
  program.command('pr <taskId>').description('Pull new PR comments via gh and open a pr_feedback HIL').action(async (id) => { const remote = await ServerClient.detect(); if (remote) return console.log(await remote.call('POST', `/tasks/${id}/pr/poll`)); const app = createApp(); console.log(await app.engine.pollPrFeedback(id)); });
  program.command('tail <taskId>').description('Stream events of a task from the server').action(async (id) => { const remote = await ServerClient.detect(); if (!remote) throw new Error('server not running'); await remote.tail(id, printEvent, (m) => { const s = summarize(m.sdk as SDKMessage); if (s) console.log(s); }, () => false); });
}

function printHilPayload(p: Hil['payload'], withDiff: boolean) {
  const hr = (t: string) => console.log(`\n--- ${t} ---`);
  switch (p.kind) {
    case 'refine_prompt':
      if (p.suggestedTitle) console.log(`title: ${p.suggestedTitle}`);
      if (p.questions.length) { hr('questions'); for (const q of p.questions) console.log(`- [${q.header}] ${q.question}${q.options?.length ? `\n    options: ${q.options.join(' | ')}` : ''}`); }
      hr('suggested prompt'); console.log(p.suggestedPrompt ?? '(none)');
      if (p.assumptions.length) { hr('assumptions'); for (const a of p.assumptions) console.log(`- ${a}`); }
      hr('original prompt'); console.log(p.prompt);
      break;
    case 'approve_plan':
      if (p.summary) console.log(p.summary);
      hr('plan'); console.log(p.planMd || '(empty)');
      break;
    case 'approve_result':
      hr(`commits (${p.commits.length}) on ${p.branch}`); for (const c of p.commits) console.log(`  ${c}`);
      hr('diff stat'); console.log(p.diffStat || '(empty)');
      hr('tests'); console.log(p.testOutput ?? '(not run)');
      hr(`review: ${p.review?.verdict ?? '(none)'}`); if (p.review) { console.log(p.review.summary); for (const f of p.review.findings) console.log(`- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n    ${f.description}${f.suggestion ? `\n    → ${f.suggestion}` : ''}`); }
      if (p.qa) { hr(`qa: ${p.qa.verdict}`); console.log(p.qa.summary); for (const c of p.qa.checks) console.log(`- ${c.result.padEnd(7)} ${c.name} (${c.method})`); for (const i of p.qa.issues) console.log(`- [${i.severity}] ${i.title}\n    ${i.description}`); }
      if (withDiff) { hr('diff'); console.log(p.diff); }
      break;
    case 'pr_feedback':
      console.log(p.prUrl); for (const c of p.comments) console.log(`- ${c.author}${c.path ? ` ${c.path}${c.line ? `:${c.line}` : ''}` : ''}${c.reviewState ? ` [${c.reviewState}]` : ''}: ${c.body}`);
      break;
    case 'question':
      for (const q of p.questions) console.log(`- [${q.header}] ${q.question}${q.options.length ? `\n    options: ${q.options.map((o) => o.label).join(' | ')}` : ''}`);
      break;
    case 'escalation':
      console.log(`${p.phaseName} failed${p.resultSubtype ? ` (${p.resultSubtype})` : ''}:\n${p.error}`);
      break;
  }
}
