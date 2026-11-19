import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ClarifyQuestion } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { TelegramNotifier } from '../../server/src/notifiers/telegram.js';
import { NO_ANSWER } from '../../server/src/engine/engine.js';

/** The HIL card: a refine checkpoint with open questions can be approved from Telegram, but the label has to admit no answers are sent. */
async function cardFor(prefix: string, questions: ClarifyQuestion[]) {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  // without questions the refine checkpoint only opens when clarify failed: a clean clarify output is auto-approved
  const runner = new FakeRunner(() => ({ act: () => (questions.length ? { structured: { questions, suggestedPrompt: 'p', assumptions: [] } } : { subtype: 'error_during_execution' as const }) }));
  const app = testApp(dir, runner);
  const task = await app.engine.createTask({ prompt: 'x', repoPath: repo, pipeline: 'standard', baseRemote: null });
  await app.engine.advance(task.id);
  const hil = app.store.openHilForTask(task.id)[0]!;
  const sent: { reply_markup: { inline_keyboard: { text: string; callback_data?: string }[][] } }[] = [];
  const original = global.fetch;
  global.fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
  }) as unknown as typeof global.fetch;
  try {
    await new TelegramNotifier(app, { botToken: 'bot', chatId: '42', token: null }).onHilCreated(hil, task, `http://x/hil/${hil.id}`);
  } finally { global.fetch = original; }
  return { hil, buttons: sent[0]!.reply_markup.inline_keyboard[0]! };
}

describe('TelegramNotifier: the refine card', () => {
  it('offers approve for open questions, labelled so it is clear no answers are sent', async () => {
    const { hil, buttons } = await cardFor('sdlc-tg-q-', [{ question: 'Which file?', header: 'File' }]);
    expect(buttons.map((b) => b.text)).toEqual(['✅ approve (no answers)', '✖ abort']);
    expect(buttons[0]!.callback_data).toBe(`h:${hil.id}:approve`);
  });

  it('keeps the plain approve label when clarify asked nothing', async () => {
    const { buttons } = await cardFor('sdlc-tg-noq-', []);
    expect(buttons.map((b) => b.text)).toEqual(['✅ approve', '✖ abort']);
  });
});

/**
 * The label is only half of it: the button it sits on has to work. Tapping approve on a refine card
 * sends `{ decision: 'approve' }` with no answers at all, which the engine used to refuse with a 400 —
 * from Telegram that came back as an error alert and the checkpoint stayed open.
 */
describe('TelegramNotifier: approving a refine card with open questions from Telegram', () => {
  it('answers the checkpoint, leaving every question to the implementer', async () => {
    const dir = tmpDir('sdlc-tg-tap-');
    const repo = makeRepo(dir, { 'a.txt': 'x\n' });
    const runner = new FakeRunner((spec) => ({
      act: () => {
        const p = spec.prompt;
        if (p.includes('Phase: clarify')) return { structured: { questions: [{ question: 'Which file?', header: 'File' }, { question: 'Keep the old path?', header: 'Old path' }], suggestedPrompt: 'Change a.txt', assumptions: [] } };
        if (p.includes('Phase: implement')) { fs.writeFileSync(path.join(spec.cwd, 'a.txt'), 'y\n'); return { text: 'implemented' }; }
        if (p.includes('Phase: self_check')) return { text: 'checked' };
        if (p.includes('Phase: test')) return { structured: { verdict: 'skipped', summary: 'n/a', commands: [], tests_added: [], failures: [], notes: '' } };
        if (p.includes('Phase: review')) return { structured: { verdict: 'approve', summary: 'ok', findings: [] } };
        if (p.includes('Phase: QA')) return { structured: { verdict: 'skipped', summary: 'n/a', checks: [], issues: [] } };
        throw new Error('unexpected prompt: ' + p.slice(0, 80));
      },
    }));
    const app = testApp(dir, runner);
    const task = await app.engine.createTask({ prompt: 'change a', repoPath: repo, pipeline: 'quick', baseRemote: null });
    await app.engine.advance(task.id);
    const hil = app.store.openHilForTask(task.id)[0]!;
    const notifier = new TelegramNotifier(app, { botToken: 'bot', chatId: '42', token: null });

    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const original = global.fetch;
    global.fetch = (async (url: string, init: { body: string }) => {
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }) as unknown as typeof global.fetch;
    try {
      await notifier.onHilCreated(hil, task, `http://x/hil/${hil.id}`);
      const data = (calls[0]!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard[0]![0]!.callback_data!;
      // the tap, as Telegram delivers it: the private update handler is the only entry point for a button press
      await (notifier as unknown as { handle(u: unknown): Promise<void> }).handle({ update_id: 1, callback_query: { id: 'cb1', from: { id: 42 }, message: { chat: { id: 42 }, message_id: 7 }, data } });
    } finally { global.fetch = original; }

    const ack = calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(ack.body).toMatchObject({ text: 'approve ✓' });   // an error would come back as show_alert with the engine's message
    expect(ack.body.show_alert).toBeUndefined();
    const answered = app.store.getHil(hil.id)!;
    expect([answered.status, answered.answeredVia]).toEqual(['answered', 'telegram']);
    await app.engine.advance(task.id);
    expect(app.store.getTask(task.id)!.refinedPrompt).toBe([
      'Change a.txt', '', '## Clarifying questions',
      `- **File**: Which file?\n  → ${NO_ANSWER}`,
      `- **Old path**: Keep the old path?\n  → ${NO_ANSWER}`,
    ].join('\n'));
  });
});
