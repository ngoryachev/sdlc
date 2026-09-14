import type { Command } from 'commander';
import { serve } from '@hono/node-server';
import { createApp } from '../app.js';
import { createHttpApp, ensureToken } from '../http/app.js';
import { startNotifierHub, ConsoleNotifier } from '../notifiers/hub.js';
import type { Notifier } from '../notifiers/types.js';
import { TelegramNotifier } from '../notifiers/telegram.js';

export function registerServe(program: Command) {
  program.command('serve').description('Start the orchestrator: engine + API + UI')
    .option('--port <n>', 'port').option('--host <h>', 'bind address')
    .action(async (o) => {
      const app = createApp();
      if (o.port) app.config.server.port = Number(o.port);
      if (o.host) app.config.server.host = o.host;
      const token = ensureToken(app);
      const publicUrl = app.config.server.public_url ?? `http://${app.config.server.host === '0.0.0.0' ? 'localhost' : app.config.server.host}:${app.config.server.port}`;
      const notifiers: Notifier[] = [new ConsoleNotifier()];
      if (app.config.telegram.enabled && app.config.telegram.bot_token) notifiers.push(new TelegramNotifier(app, { botToken: app.config.telegram.bot_token, chatId: app.config.telegram.chat_id, token: app.config.server.token_in_url ? token : null }));
      app.notifiers = notifiers;
      const stop = startNotifierHub(app, notifiers, publicUrl);
      const hono = createHttpApp(app);
      const server = serve({ fetch: hono.fetch, hostname: app.config.server.host, port: app.config.server.port }, (info) => {
        console.log(`sdlc serve listening on http://${info.address}:${info.port}`);
        if (app.config.server.token_in_url) console.log(`open: ${publicUrl}/?t=${token}`);
        else console.log(`open: ${publicUrl}/  (token login via URL disabled; paste the token from config.yaml into the login form once per device)`);
      });
      await app.engine.recover();
      const shutdown = () => { console.log('\n[sdlc] shutting down'); stop(); server.close(); setTimeout(() => process.exit(0), 500); };
      process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    });
}
