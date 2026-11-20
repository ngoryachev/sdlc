import { describe, it, expect, afterEach } from 'vitest';
import { filteredEnv, sdkOptions } from '../../server/src/claude/runner.js';
import { setShellEnv } from '../../server/src/claude/shell-env.js';

describe('phase session options', () => {
  it('load the whole Claude Code setup: user/project/local settings, project .mcp.json approved, no strict MCP', () => {
    const o = sdkOptions({ cwd: '/wt', prompt: 'x', permissionMode: 'bypassPermissions' }, new AbortController());
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.settings).toEqual({ enableAllProjectMcpServers: true });
    expect(o.strictMcpConfig).toBeUndefined();
    expect(sdkOptions({ cwd: '/wt', prompt: 'x', permissionMode: 'bypassPermissions', settingSources: ['project'] }, new AbortController()).settingSources).toEqual(['project']);
  });
});

describe('filteredEnv', () => {
  const keys = ['JIRA_API_TOKEN', 'FIGMA_API_KEY', 'SDLC_HOME', 'SDLC_TELEGRAM_TOKEN', 'JAVA_HOME'];
  afterEach(() => { for (const k of keys) delete process.env[k]; setShellEnv(null); });
  it('passes API keys to phases (skills, MCP servers) and keeps only sdlc\'s own SDLC_* out', () => {
    for (const k of keys) process.env[k] = 'v';
    const env = filteredEnv({ EXTRA: '1' });
    expect([env.JIRA_API_TOKEN, env.FIGMA_API_KEY, env.EXTRA]).toEqual(['v', 'v', '1']);
    expect([env.SDLC_HOME, env.SDLC_TELEGRAM_TOKEN]).toEqual([undefined, undefined]);
    expect(filteredEnv({}, ['SDLC_HOME']).SDLC_HOME).toBe('v');
  });

  it('layers the login shell under the service environment, and the repository files on top', () => {
    setShellEnv({ JAVA_HOME: '/opt/jdk-from-bashrc', ANDROID_HOME: '/home/u/Android/Sdk', KEYSTORE: '/shell/key.jks' });
    process.env.JAVA_HOME = '/opt/jdk-from-unit';
    const env = filteredEnv({ KEYSTORE: '/files/key.jks' });
    expect(env.ANDROID_HOME).toBe('/home/u/Android/Sdk');   // only the shell knows about it
    expect(env.JAVA_HOME).toBe('/opt/jdk-from-unit');       // ~/.sdlc/env and the unit win over the shell
    expect(env.KEYSTORE).toBe('/files/key.jks');            // the repository's files win over both
  });

  it('merges PATH instead of replacing it: the service entries first, then the shell ones, no duplicates', () => {
    const service = [...new Set(process.env.PATH!.split(':'))];
    setShellEnv({ PATH: `${service[0]}:/home/u/.sdkman/bin:/home/u/.local/bin:/home/u/.sdkman/bin` });
    expect(filteredEnv().PATH!.split(':')).toEqual([...service, '/home/u/.sdkman/bin', '/home/u/.local/bin']);
  });

  it('never takes SDLC_* from the shell, not even one named in env_allow', () => {
    setShellEnv({ SDLC_HOME: '/the/users/own/sdlc' });   // a denylisted name cannot even get this far in practice
    expect(filteredEnv({}, ['SDLC_HOME']).SDLC_HOME).toBeUndefined();
  });

  it('leaves PATH alone when the shell has none, and takes the shell PATH when the service has none', () => {
    setShellEnv({ JAVA_HOME: '/opt/jdk' });
    expect(filteredEnv().PATH).toBe(process.env.PATH);
    const saved = process.env.PATH;
    delete process.env.PATH;
    try {
      setShellEnv({ PATH: '/shell/bin' });
      expect(filteredEnv().PATH).toBe('/shell/bin');
    } finally { process.env.PATH = saved; }
  });

  it('reaches a Claude phase session: sdkOptions carries the three layers, not just the files', () => {
    setShellEnv({ ANDROID_HOME: '/home/u/Android/Sdk' });
    const o = sdkOptions({ cwd: '/wt', prompt: 'x', permissionMode: 'bypassPermissions', env: { KEYSTORE: '/files/key.jks' } }, new AbortController());
    expect(o.env!.ANDROID_HOME).toBe('/home/u/Android/Sdk');
    expect(o.env!.KEYSTORE).toBe('/files/key.jks');
    expect(o.env!.PATH).toBe(process.env.PATH);
  });
});
