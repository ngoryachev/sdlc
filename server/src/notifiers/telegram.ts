import type { HilRequest, Task } from '@sdlc/shared';
import type { App } from '../app.js';
import type { Notifier } from './types.js';

interface TgUpdate { update_id: number; message?: { chat: { id: number }; text?: string; from?: { id: number; username?: string } }; callback_query?: { id: string; from: { id: number; username?: string }; message?: { chat: { id: number }; message_id: number }; data?: string } }

/** Telegram Bot API notifier: HIL cards with inline buttons, long polling for callbacks (no public URL needed). */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  private running = false;
  private offset = 0;
  constructor(private app: App, private o: { botToken: string; chatId?: string; token: string | null }) {}

  private async api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.o.botToken}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json() as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result;
  }

  async start() { this.running = true; void this.poll(); }
  async stop() { this.running = false; }
  async test() { if (!this.o.chatId) throw new Error('telegram.chat_id is not set (send the bot a message; the id is logged)'); await this.api('sendMessage', { chat_id: this.o.chatId, text: 'sdlc: test message ✅' }); }

  async onHilCreated(req: HilRequest, task: Task, link: string) {
    if (!this.o.chatId) return;
    const text = `<b>[${esc(req.kind)}]</b> ${esc(task.title)}\n<i>${esc(req.summary)}</i>`;
    // approving refine from here sends no answers: legal (each question falls to the implementer), but the label has to say so, as only the web UI can type them
    const noAnswers = req.payload.kind === 'refine_prompt' && req.payload.questions.length > 0;
    // a phase stopped by its cap is worth continuing, not restarting: its work so far is in the session
    const capped = req.payload.kind === 'escalation' && (req.payload.resultSubtype === 'error_max_budget_usd' || req.payload.resultSubtype === 'error_max_turns');
    const positive = capped ? 'resume' : req.allowedDecisions.find((d) => ['approve', 'allow', 'retry'].includes(d));
    const negative = req.allowedDecisions.find((d) => ['abort', 'deny'].includes(d));
    const row: { text: string; callback_data?: string; url?: string }[] = [];
    if (positive) row.push({ text: `✅ ${positive}${noAnswers && positive === 'approve' ? ' (no answers)' : ''}`, callback_data: `h:${req.id}:${positive}` });
    if (req.allowedDecisions.includes('skip')) row.push({ text: '⏭ skip', callback_data: `h:${req.id}:skip` });
    if (negative) row.push({ text: `✖ ${negative}`, callback_data: `h:${req.id}:${negative}` });
    const withToken = this.o.token ? (link.includes('?') ? `${link}&t=${this.o.token}` : `${link}?t=${this.o.token}`) : link;
    const r = await this.api<{ message_id: number }>('sendMessage', { chat_id: this.o.chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [row, [{ text: '🔗 Open', url: withToken }]] } });
    this.app.store.setNotificationRef(req.id, this.name, String(r.message_id));
  }

  async onHilAnswered(req: HilRequest, task: Task) {
    if (!this.o.chatId) return;
    const ref = this.app.store.getNotificationRef(req.id, this.name);
    if (!ref) return;
    const status = req.status === 'answered' ? `${req.response?.decision} via ${req.answeredVia}` : req.status;
    await this.api('editMessageText', { chat_id: this.o.chatId, message_id: Number(ref), parse_mode: 'HTML', text: `<b>[${esc(req.kind)}]</b> ${esc(task.title)}\n<i>${esc(req.summary)}</i>\n\n<b>→ ${esc(status)}</b>` }).catch(() => {});
  }

  async onTaskStatus(task: Task, _from: string, to: string, link: string) {
    if (!this.o.chatId) return;
    const { icon, text } = to === 'pr_open' ? this.prOpenLine(task)
      : { icon: to === 'succeeded' || to === 'merged' ? '🎉' : to === 'failed' ? '💥' : to === 'aborted' || to === 'closed' ? '🛑' : '⏸', text: to };
    await this.api('sendMessage', { chat_id: this.o.chatId, parse_mode: 'HTML', text: `${icon} <b>${esc(task.title)}</b> → ${text}${task.prUrl ? `\n${task.prUrl}` : ''}`, reply_markup: { inline_keyboard: [[{ text: '🔗 Open', url: this.o.token ? `${link}?t=${this.o.token}` : link }]] } });
  }

  /**
   * Who owns the pull request decides the wording: only a PR this task opened itself is news, a reviewer task merely
   * starts tracking somebody else's, and an author task on an existing PR (or on its own PR again, after a round of
   * requested changes) has pushed fixes into it. Read from the task's own history, not from the pipeline name.
   */
  private prOpenLine(task: Task): { icon: string; text: string } {
    const pr = task.prNumber ? `PR #${task.prNumber}` : 'the PR';
    const events = this.app.events.ofType(task.id, ['git.pr_created', 'git.pushed', 'task.status']);
    const ownPr = events.some((e) => e.type === 'git.pr_created'
      && (task.prNumber == null || (e.payload as { number: number }).number === task.prNumber));
    // a task that waits for review comments (fix-pr) is set to pr_open at creation, before any phase has run:
    // until it has pushed, nothing of its own is in that pull request yet
    const author = events.some((e) => e.type === 'git.pushed')
      ? { icon: '🔧', text: `fixes pushed to ${pr}` }
      : { icon: '🔧', text: `attached to ${pr}` };
    if (ownPr) {
      // the transition is already persisted when the hub fans it out, so the first pr_open means exactly one such event
      const opens = events.filter((e) => e.type === 'task.status' && (e.payload as { to: string }).to === 'pr_open').length;
      return opens <= 1 ? { icon: '🎉', text: 'pr_open' } : author;
    }
    if (this.app.engine.roleOfTask(task.id) === 'reviewer') return { icon: '✅', text: `review done, tracking ${pr}` };
    return author;
  }

  private async poll() {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['callback_query', 'message'] });
        backoff = 1000;
        for (const u of updates) { this.offset = u.update_id + 1; await this.handle(u).catch((e) => this.app.events.emit('notifier.error', { channel: this.name, message: String(e) })); }
      } catch (e) {
        this.app.events.emit('notifier.error', { channel: this.name, message: `poll: ${e instanceof Error ? e.message : String(e)}` });
        await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private async handle(u: TgUpdate) {
    if (u.message) {
      const chat = String(u.message.chat.id);
      if (!this.o.chatId) { console.log(`[telegram] message from chat ${chat} (${u.message.from?.username ?? ''}); set telegram.chat_id in config to enable`); return; }
      if (chat !== this.o.chatId) return;
      const text = u.message.text?.trim() ?? '';
      if (text.startsWith('/status')) {
        const tasks = this.app.store.listTasks(['running', 'waiting_hil', 'paused', 'pr_open']);
        const open = this.app.store.listHil({ status: 'open' }).length;
        await this.api('sendMessage', { chat_id: chat, text: tasks.length ? tasks.map((t) => `${t.status.padEnd(11)} ${t.title}`).join('\n') + `\n\nopen HIL: ${open}` : 'no active tasks' });
      } else if (text.startsWith('/pr ')) {
        const id = text.slice(4).trim();
        try { const r = await this.app.engine.pollPrFeedback(id); await this.api('sendMessage', { chat_id: chat, text: r.new ? `${r.new} new comment(s); HIL created` : `no new comments (PR ${r.state})` }); }
        catch (e) { await this.api('sendMessage', { chat_id: chat, text: `error: ${e instanceof Error ? e.message : String(e)}` }); }
      }
      return;
    }
    const cq = u.callback_query;
    if (!cq?.data) return;
    const from = String(cq.message?.chat.id ?? cq.from.id);
    if (!this.o.chatId || from !== this.o.chatId) { await this.api('answerCallbackQuery', { callback_query_id: cq.id, text: 'not authorized' }); return; }
    const m = /^h:([^:]+):(\w+)$/.exec(cq.data);
    if (!m) return;
    try {
      await this.app.engine.respondHil(m[1]!, { decision: m[2] as never }, 'telegram');
      await this.api('answerCallbackQuery', { callback_query_id: cq.id, text: `${m[2]} ✓` });
    } catch (e) {
      await this.api('answerCallbackQuery', { callback_query_id: cq.id, text: e instanceof Error ? e.message : String(e), show_alert: true });
    }
  }
}

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
