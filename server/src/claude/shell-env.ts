import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * The environment of the user's interactive login shell, read once at server startup and used as the bottom layer of
 * every phase's environment (`filteredEnv`). The point is a toolchain that only `~/.bashrc` knows about — `JAVA_HOME`,
 * `ANDROID_HOME`, sdkman/nvm entries on `PATH`: in a terminal a build works, and a phase started by the service used
 * to see none of it. Any failure (no such shell, an rc file that hangs, empty output) falls back to the service's own
 * environment, which is exactly how phases behaved before this existed.
 */

/** Marker printed before `env -0`, so whatever an rc file echoes on startup is discarded instead of parsed as variables. */
const MARKER = '__SDLC_ENV_7f3a__';
/** `-i` so `~/.bashrc` is sourced at all: a non-interactive shell returns at the top of it ("If not running interactively, return"). */
const READ_CMD = `printf '%s' '${MARKER}'; env -0`;
const TIMEOUT_MS = 5_000;

/** Never from the shell, whatever `env_allow` says: these are sdlc's own settings, and the service's must win. */
const SDLC_ENV = /^SDLC_/;
/** A POSIX environment variable name; `env -0` can also report entries like `BASH_FUNC_x%%` that are not assignable. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables that describe the interactive session that read them, not the user's toolchain: a prompt string, the
 * shell's own bookkeeping, the directory the reader shell happened to sit in. `TERM` too — a phase is not a terminal.
 * `LANG`/`LC_*` are deliberately kept: a build tool should see the user's locale.
 */
const DENY = new Set([
  'PWD', 'OLDPWD', 'SHLVL', '_', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT_COMMAND', 'PROMPT_DIRTRIM',
  'BASHOPTS', 'SHELLOPTS', 'IFS', 'OPTIND', 'OPTARG', 'OPTERR', 'LINES', 'COLUMNS', 'TERM',
  'BASH_ARGC', 'BASH_ARGV', 'BASH_LINENO', 'BASH_SOURCE', 'BASH_EXECUTION_STRING', 'BASH_COMMAND', 'BASH_SUBSHELL',
  'HISTFILE', 'HISTSIZE', 'HISTFILESIZE', 'HISTCONTROL', 'HISTIGNORE', 'HISTTIMEFORMAT',
  'RANDOM', 'SECONDS', 'EPOCHSECONDS', 'EPOCHREALTIME', 'LINENO', 'FUNCNAME', 'PIPESTATUS', 'REPLY',
]);

export type ShellEnvReader = () => string;

/**
 * `$SHELL -ilc '<marker + env -0>'` from `$HOME`, with a short timeout. stdin is /dev/null (`ignore`), so an rc file
 * that prompts cannot block the startup, and stderr is dropped rather than piped: its noise is not the server's log.
 * `killSignal` has to be SIGKILL for the timeout to bound anything: an interactive bash (`-i`) ignores SIGTERM, which
 * is what spawnSync sends by default, so an rc file running `sleep 20` kept the call blocked for the whole 20 s.
 */
const defaultShellEnvReader: ShellEnvReader = () => {
  const shell = process.env.SHELL || 'bash';
  return execFileSync(shell, ['-ilc', READ_CMD], {
    cwd: process.env.HOME || os.homedir(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
};

/**
 * Variables out of the reader's output: everything before the last marker is an rc file talking to its terminal and is
 * thrown away, the rest is `env -0` output — NUL-separated `KEY=VALUE`, so a value may hold newlines and `=` freely.
 */
export function parseShellEnv(raw: string): Record<string, string> {
  const at = raw.lastIndexOf(MARKER);
  if (at < 0) return {};
  const out: Record<string, string> = {};
  for (const chunk of raw.slice(at + MARKER.length).split('\0')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq);
    if (!ENV_NAME.test(key) || SDLC_ENV.test(key) || DENY.has(key)) continue;
    out[key] = chunk.slice(eq + 1);
  }
  return out;
}

let cached: Record<string, string> | null = null;

/**
 * Read the login shell's environment once per process. Called from `sdlc serve` at startup, never from `createApp()`:
 * the unit and e2e suites must not spawn a shell, and without this call `shellEnv()` stays empty — today's behaviour.
 */
export function initShellEnv(reader: ShellEnvReader = defaultShellEnvReader): Record<string, string> {
  if (cached) return cached;
  let env: Record<string, string> = {};
  let reason = '';
  try {
    const raw = reader();
    env = parseShellEnv(raw ?? '');
    if (!Object.keys(env).length) reason = raw && raw.includes(MARKER) ? 'it reported no variables' : 'no output';
  } catch (e) {
    reason = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    env = {};
  }
  if (reason) console.warn(`[sdlc] could not read the login shell environment (${reason}); phases run with the service environment only`);
  cached = env;
  return cached;
}

/** For tests: set what `shellEnv()` returns without spawning anything; `null` puts the process back to "not read yet". */
export function setShellEnv(env: Record<string, string> | null): void { cached = env ? { ...env } : null; }

/** The login shell's variables, already denylisted; `{}` until `initShellEnv()` ran. */
export function shellEnv(): Record<string, string> { return cached ?? {}; }
