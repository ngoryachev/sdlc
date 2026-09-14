import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { RepoConfigSchema, type RepoConfig } from '../pipeline/schema.js';

export const SDLC_HOME = process.env.SDLC_HOME ?? path.join(os.homedir(), '.sdlc');
export const CONFIG_PATH = path.join(SDLC_HOME, 'config.yaml');

export const ConfigSchema = z.object({
  data_dir: z.string().default(path.join(SDLC_HOME, 'data')),
  repos_dir: z.string().default(path.join(SDLC_HOME, 'repos')),
  worktrees_dir: z.string().optional(), // default: <repo>/../.sdlc-worktrees/<basename>
  pipelines_dirs: z.array(z.string()).default([]),
  default_pipeline: z.string().default('standard'),
  max_parallel_tasks: z.number().int().positive().default(2),
  task_budget_usd: z.number().positive().default(20),
  question_timeout: z.string().regex(/^\d+(m|h|d)$/).default('2h'),
  auto_resume_on_restart: z.boolean().default(true),
  cleanup: z.enum(['on_pr', 'on_approve', 'never']).default('on_pr'),
  env_allow: z.array(z.string()).default([]),
  git_author: z.string().default('SDLC <sdlc@local>'),
  repos: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  server: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7337),
    public_url: z.string().optional(),
    token: z.string().optional(),
  }).default({ host: '127.0.0.1', port: 7337 }),
  telegram: z.object({
    enabled: z.boolean().default(false),
    bot_token: z.string().optional(),
    chat_id: z.string().optional(),
  }).default({ enabled: false }),
});
export type SdlcConfig = z.infer<typeof ConfigSchema>;

/** Root of this checkout (where pipelines/ and prompts/ live). */
export function sdlcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/src/config -> repo root; server/dist/config -> repo root
  return path.resolve(here, '..', '..', '..');
}

export function loadConfig(configPath = CONFIG_PATH): SdlcConfig {
  let raw: unknown = {};
  if (fs.existsSync(configPath)) raw = YAML.parse(fs.readFileSync(configPath, 'utf8')) ?? {};
  const cfg = ConfigSchema.parse(raw);
  if (process.env.SDLC_TELEGRAM_TOKEN) cfg.telegram.bot_token = process.env.SDLC_TELEGRAM_TOKEN;
  if (process.env.SDLC_TOKEN) cfg.server.token = process.env.SDLC_TOKEN;
  cfg.pipelines_dirs = [...cfg.pipelines_dirs, path.join(sdlcRoot(), 'pipelines')];
  fs.mkdirSync(cfg.data_dir, { recursive: true });
  return cfg;
}

export function saveConfig(cfg: SdlcConfig, configPath = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const { pipelines_dirs, ...rest } = cfg;
  const own = pipelines_dirs.filter((d) => d !== path.join(sdlcRoot(), 'pipelines'));
  fs.writeFileSync(configPath, YAML.stringify({ ...rest, pipelines_dirs: own }));
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
