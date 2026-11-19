import { describe, it, expect } from 'vitest';
import type { ClarifyQuestion } from '@sdlc/shared';
import { FakeRunner } from '../fakes/fake-runner.js';
import { makeRepo, testApp, tmpDir } from '../helpers.js';
import { TelegramNotifier } from '../../server/src/notifiers/telegram.js';

/** The HIL card: a refine checkpoint with open questions can be approved from Telegram, but the label has to admit no answers are sent. */
async function cardFor(prefix: string, questions: ClarifyQuestion[]) {
  const dir = tmpDir(prefix);
  const repo = makeRepo(dir, { 'a.txt': 'x\n' });
  const runner = new FakeRunner(() => ({ act: () => ({ structured: { questions, suggestedPrompt: 'p', assumptions: [] } }) }));
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
