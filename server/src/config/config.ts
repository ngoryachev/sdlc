import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { RepoConfigSchema, type RepoConfig } from '../pipeline/schema.js';

export const SDLC_HOME = process.env.SDLC_HOME ?? path.join(os.homedir(), '.sdlc');
export const CONFIG_PATH = path.join(SDLC_HOME, 'config.yaml');
/** Version of the shipped defaults. A file without it was written by a saveConfig that froze every default in (see migrate). */
export const CONFIG_VERSION = 1;

export const ConfigSchema = z.object({
  config_version: z.number().int().min(0).default(0),
  data_dir: z.string().default(path.join(SDLC_HOME, 'data')),
  repos_dir: z.string().default(path.join(SDLC_HOME, 'repos')),
  worktrees_dir: z.string().optional(), // default: <repo>/../.sdlc-worktrees/<basename>
  pipelines_dirs: z.array(z.string()).default([]),
  default_pipeline: z.string().default('standard'),
  max_parallel_tasks: z.number().int().positive().default(10),
  task_budget_usd: z.union([z.number().positive(), z.literal('off')]).default(100),   // 'off' = no task-level budget
  max_loops: z.number().int().min(0).default(15),   // cap on every on_fail back_to loop (test→implement, review→implement); overrides the pipelines' max_loops
  recheck_scope: z.enum(['delta', 'full']).default('delta'),   // a repeat pass of review/test/qa looks only at what changed since its previous pass (delta) or at everything again (full)
  limits: z.object({
    phases: z.enum(['pipeline', 'off']).default('off'),   // off: ignore max_turns / max_budget_usd from pipelines; task_budget_usd is the guard
  }).default({ phases: 'off' }),
  merge_method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  models: z.object({
    default: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    phases: z.record(z.string(), z.object({ model: z.string().optional(), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }).strict()).default({}),
  }).default({ phases: {} }),
  question_timeout: z.string().regex(/^\d+(m|h|d)$/).default('2h'),
  auto_resume_on_restart: z.boolean().default(true),
  cleanup: z.enum(['on_pr', 'on_approve', 'never']).default('never'),   // never: worktrees are removed explicitly (UI button / `sdlc cleanup`)
  pr_feedback_from: z.enum(['collaborators', 'anyone']).default('collaborators'),
  env_allow: z.array(z.string()).default([]),
  git_author: z.string().default('SDLC <sdlc@local>'),
  repos: z.array(z.object({ name: z.string(), path: z.string(), gh_user: z.string().optional() })).default([]),   // gh_user: GitHub account used for this repo
  pr_sync_interval: z.union([z.string().regex(/^\d+(m|h)$/), z.literal('off')]).default('3m'),   // background check of PR state and merged branches
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7337),
    public_url: z.string().optional(),
    token: z.string().optional(),
    token_in_url: z.boolean().default(true),   // false for public deployments: login only via the form / Bearer
  }).default({ host: '127.0.0.1', port: 7337, token_in_url: true }),
  telegram: z.object({
    enabled: z.boolean().default(false),
    bot_token: z.string().optional(),
    chat_id: z.string().optional(),
  }).default({ enabled: false }),
});
export type SdlcConfig = z.infer<typeof ConfigSchema>;

/** The shipped defaults: what a config file does not have to say. */
const schemaDefaults = (): SdlcConfig => ConfigSchema.parse({});

/** Root of this checkout (where pipelines/ and prompts/ live). */
export function sdlcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/src/config -> repo root; server/dist/config -> repo root
  return path.resolve(here, '..', '..', '..');
}

export function loadConfig(configPath = CONFIG_PATH): SdlcConfig {
  let raw: Record<string, unknown> = {};
  const exists = fs.existsSync(configPath);
  if (exists) raw = (YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>;
  const cfg = ConfigSchema.parse(raw);
  const migrated = exists && migrate(cfg, raw);
  if (process.env.SDLC_TELEGRAM_TOKEN) cfg.telegram.bot_token = process.env.SDLC_TELEGRAM_TOKEN;
  if (process.env.SDLC_TOKEN) cfg.server.token = process.env.SDLC_TOKEN;
  // the migration counts only once it is on disk: without the stamped version a deliberately chosen 'pipeline' would be reset on every load
  if (migrated) { try { saveConfig(cfg, configPath); } catch (e) { console.error('[sdlc] could not persist the migrated config:', e); } }
  cfg.pipelines_dirs = [...cfg.pipelines_dirs, path.join(sdlcRoot(), 'pipelines')];
  fs.mkdirSync(cfg.data_dir, { recursive: true });
  return cfg;
}

/**
 * Migrations of an older file, each gated on the version it belongs to, so a later bump of CONFIG_VERSION never
 * replays an earlier rule over a value the user has since chosen. Returns whether the file has to be rewritten.
 */
function migrate(cfg: SdlcConfig, raw: Record<string, unknown>): boolean {
  if (cfg.config_version >= CONFIG_VERSION) return false;
  // < 1: written by a saveConfig that wrote every default, so the limits and the task budget it records are the old defaults, not choices
  if (cfg.config_version < 1) {
    if ((raw.limits as { phases?: unknown } | undefined)?.phases === 'pipeline') cfg.limits.phases = 'off';
    if (raw.task_budget_usd === 20) cfg.task_budget_usd = schemaDefaults().task_budget_usd;
  }
  cfg.config_version = CONFIG_VERSION;
  return true;
}

export function saveConfig(cfg: SdlcConfig, configPath = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const { pipelines_dirs, ...rest } = cfg;
  const own = pipelines_dirs.filter((d) => d !== path.join(sdlcRoot(), 'pipelines'));
  // secrets loadConfig took from the environment stay there: the file keeps whatever it had for them
  const onDisk = ((fs.existsSync(configPath) ? YAML.parse(fs.readFileSync(configPath, 'utf8')) : null) ?? {}) as { server?: { token?: string }; telegram?: { bot_token?: string } };
  const server = { ...rest.server, token: fromEnv('SDLC_TOKEN', rest.server.token, onDisk.server?.token) };
  const telegram = { ...rest.telegram, bot_token: fromEnv('SDLC_TELEGRAM_TOKEN', rest.telegram.bot_token, onDisk.telegram?.bot_token) };
  const { config_version, ...full } = { ...rest, server, telegram, pipelines_dirs: own };
  // only what differs from the shipped defaults, so a later change of a default reaches every installation that ever pressed Save
  const kept = prune(full, schemaDefaults() as unknown as Record<string, unknown>);
  // a file from a newer sdlc keeps its version: downgrading it would replay that version's migration on the next upgrade
  fs.writeFileSync(configPath, YAML.stringify({ config_version: Math.max(CONFIG_VERSION, config_version), ...(kept === DROP ? {} : (kept as Record<string, unknown>)) }));
}

const fromEnv = (name: string, value: string | undefined, onDisk: string | undefined) => (value !== undefined && value === process.env[name] ? onDisk : value);

/** Nothing to write for this key. */
const DROP = Symbol('drop');
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drops everything that equals its default; nested objects (server, models, telegram, limits) key by key, arrays and records as whole values. */
function prune(value: unknown, def: unknown): unknown {
  if (isPlainObject(value) && isPlainObject(def)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const kept = prune(v, def[k]);
      if (kept !== DROP) out[k] = kept;
    }
    return Object.keys(out).length ? out : DROP;
  }
  return deepEqual(value, def) ? DROP : value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => deepEqual(a[k], b[k])); }
  return false;
}

export function loadRepoConfig(repoPath: string): RepoConfig {
  const p = path.join(repoPath, '.sdlc.yaml');
  if (!fs.existsSync(p)) return RepoConfigSchema.parse({});
  const parsed = RepoConfigSchema.safeParse(YAML.parse(fs.readFileSync(p, 'utf8')) ?? {});
  if (!parsed.success) throw new Error(`invalid ${p}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

export function parseDuration(s: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  return n * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2] as 'm' | 'h' | 'd'];
}
