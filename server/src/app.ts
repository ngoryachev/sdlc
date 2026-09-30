import path from 'node:path';
import { CONFIG_PATH, loadConfig, saveConfig, type SdlcConfig } from './config/config.js';
import { openDb } from './store/db.js';
import { Store } from './store/repo.js';
import { EventBus } from './store/events.js';
import { SdkClaudeRunner, type ClaudeRunner } from './claude/runner.js';
import { Engine } from './engine/engine.js';
import { GhCli, type GitHub } from './git/gh.js';
import { RepoAccounts } from './git/accounts.js';
import type { Notifier } from './notifiers/types.js';
import { QuotaTracker } from './claude/quota.js';

export interface App {
  config: SdlcConfig; store: Store; events: EventBus; engine: Engine; runner: ClaudeRunner; github: GitHub; accounts: RepoAccounts; quota: QuotaTracker;
  /** Write the in-memory config back to config.yaml (no-op for an injected config without configPath, i.e. tests). */
  persistConfig(): void;
  notifiers?: Notifier[];
}

export function createApp(opts: { config?: SdlcConfig; runner?: ClaudeRunner; dbFile?: string; github?: GitHub; configPath?: string } = {}): App {
  const config = opts.config ?? loadConfig();
  const configPath = opts.configPath ?? (opts.config ? null : CONFIG_PATH);
  const persistConfig = () => { if (configPath) saveConfig(config, configPath); };
  const db = openDb(opts.dbFile ?? path.join(config.data_dir, 'sdlc.db'));
  const store = new Store(db);
  const events = new EventBus(db);
  const runner = opts.runner ?? new SdkClaudeRunner();
  const github = opts.github ?? new GhCli();
  const accounts = new RepoAccounts(config, github, persistConfig);
  const engine = new Engine({ config, store, events, runner, github, accounts, persistConfig });
  // every phase stream reports the plan usage; keep the last value and tell the UI when it moves
  const quota = new QuotaTracker();
  events.onMessage((f) => { const q = quota.ingest(f.sdk); if (q) events.emit('claude.quota', { quota: q }); });
  return { config, store, events, engine, runner, github, accounts, quota, persistConfig };
}
