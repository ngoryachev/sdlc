import { describe, it, expect, afterEach, vi } from 'vitest';
import { initShellEnv, parseShellEnv, setShellEnv, shellEnv } from '../../server/src/claude/shell-env.js';
import { filteredEnv } from '../../server/src/claude/runner.js';

const MARKER = '__SDLC_ENV_7f3a__';
/** What the reader gets back: whatever the rc files printed to the terminal, then the marker, then `env -0`. */
const output = (noise: string, vars: Record<string, string>) =>
  noise + MARKER + Object.entries(vars).map(([k, v]) => `${k}=${v}\0`).join('');

describe('login shell environment', () => {
  afterEach(() => { setShellEnv(null); vi.restoreAllMocks(); });

  it('parses env -0 after the marker and drops whatever .bashrc echoed before it', () => {
    const raw = output('Welcome to the machine\nnvm: v20\n', { JAVA_HOME: '/opt/jdk21', PATH: '/usr/bin' });
    expect(parseShellEnv(raw)).toEqual({ JAVA_HOME: '/opt/jdk21', PATH: '/usr/bin' });
  });

  it('keeps values that contain = and newlines, and ignores names that are not assignable', () => {
    const raw = output('', { KEY: 'a=b=c', MULTI: 'line1\nline2', 'BASH_FUNC_x%%': '() { :; }', '': 'nameless' });
    expect(parseShellEnv(raw)).toEqual({ KEY: 'a=b=c', MULTI: 'line1\nline2' });
  });

  it('never carries over SDLC_* or variables of the interactive session that read them', () => {
    const raw = output('', {
      SDLC_HOME: '/other/home', PWD: '/home/u', OLDPWD: '/tmp', SHLVL: '2', _: '/usr/bin/env',
      PS1: '\\u@\\h', PROMPT_COMMAND: 'history -a', BASHOPTS: 'checkwinsize', SHELLOPTS: 'braceexpand',
      IFS: ' ', OPTIND: '1', LINES: '50', COLUMNS: '211', TERM: 'xterm-256color', HISTSIZE: '1000',
      LANG: 'en_US.UTF-8', ANDROID_HOME: '/home/u/Android/Sdk',
    });
    expect(parseShellEnv(raw)).toEqual({ LANG: 'en_US.UTF-8', ANDROID_HOME: '/home/u/Android/Sdk' });
  });

  it('reads once per process and caches the result', () => {
    const reader = vi.fn(() => output('', { ANDROID_HOME: '/sdk' }));
    expect(initShellEnv(reader)).toEqual({ ANDROID_HOME: '/sdk' });
    expect(initShellEnv(reader)).toEqual({ ANDROID_HOME: '/sdk' });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(shellEnv()).toEqual({ ANDROID_HOME: '/sdk' });
  });

  it.each([
    ['the reader throws (no such shell, a timeout)', () => { throw new Error('spawnSync /bin/fish ETIMEDOUT'); }],
    ['the shell printed nothing', () => ''],
    ['the output never reached the marker', () => 'bashrc noise only'],
  ])('falls back to the service environment when %s', (_name, reader) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.SERVICE_ONLY = 'yes';
    try {
      expect(initShellEnv(reader as () => string)).toEqual({});
      expect(shellEnv()).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/could not read the login shell environment/);
      // exactly today's behaviour: process.env plus the extra layer, nothing else
      const env = filteredEnv({ KEYSTORE: '/files/key.jks' });
      expect(env.SERVICE_ONLY).toBe('yes');
      expect(env.KEYSTORE).toBe('/files/key.jks');
      expect(env.PATH).toBe(process.env.PATH);
    } finally { delete process.env.SERVICE_ONLY; }
  });

  it('ignores what a timed-out read already printed: a partial answer is no answer', () => {
    // what execFileSync throws when it kills the shell: the error carries whatever reached stdout so far
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const killed = Object.assign(new Error('spawnSync /bin/bash ETIMEDOUT'), { signal: 'SIGKILL', stdout: output('', { JAVA_HOME: '/opt/jdk21' }) });
    expect(initShellEnv(() => { throw killed; })).toEqual({});
    expect(String(warn.mock.calls[0]![0])).toMatch(/ETIMEDOUT/);
  });

  it('does not spawn a shell unless initShellEnv() is called: shellEnv() starts empty', () => {
    expect(shellEnv()).toEqual({});
  });

  it('discards noise that looks like env output itself: only what follows the marker counts', () => {
    expect(parseShellEnv(output('FAKE=1\0NOISE=2\0', { REAL: '3' }))).toEqual({ REAL: '3' });
  });

  it('skips a chunk with no name and keeps an empty value', () => {
    expect(parseShellEnv(MARKER + 'NO_EQUALS\0=novalue\0EMPTY=\0OK=1\0')).toEqual({ EMPTY: '', OK: '1' });
  });

  it('falls back when every variable the shell reported is one that never carries over', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(initShellEnv(() => output('', { PWD: '/x', SDLC_HOME: '/y', PS1: '$' }))).toEqual({});
    expect(String(warn.mock.calls[0]![0])).toMatch(/it reported no variables/);
  });
});
