import path from 'node:path';
import { loadConfig, type SdlcConfig } from './config/config.js';
import { openDb } from './store/db.js';
import { Store } from './store/repo.js';
import { EventBus } from './store/events.js';
import { SdkClaudeRunner, type ClaudeRunner } from './claude/runner.js';
import { Engine } from './engine/engine.js';
import type { Notifier } from './notifiers/types.js';

export interface App { config: SdlcConfig; store: Store; events: EventBus; engine: Engine; runner: ClaudeRunner; notifiers?: Notifier[] }

export function createApp(opts: { config?: SdlcConfig; runner?: ClaudeRunner; dbFile?: string } = {}): App {
  const config = opts.config ?? loadConfig();
  const db = openDb(opts.dbFile ?? path.join(config.data_dir, 'sdlc.db'));
  const store = new Store(db);
  const events = new EventBus(db);
  const runner = opts.runner ?? new SdkClaudeRunner();
  const engine = new Engine({ config, store, events, runner });
  return { config, store, events, engine, runner };
}
