import { describe, it, expect, afterEach } from 'vitest';
import { filteredEnv, sdkOptions } from '../../server/src/claude/runner.js';

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
  const keys = ['JIRA_API_TOKEN', 'FIGMA_API_KEY', 'SDLC_HOME', 'SDLC_TELEGRAM_TOKEN'];
  afterEach(() => { for (const k of keys) delete process.env[k]; });
  it('passes API keys to phases (skills, MCP servers) and keeps only sdlc\'s own SDLC_* out', () => {
    for (const k of keys) process.env[k] = 'v';
    const env = filteredEnv({ EXTRA: '1' });
    expect([env.JIRA_API_TOKEN, env.FIGMA_API_KEY, env.EXTRA]).toEqual(['v', 'v', '1']);
    expect([env.SDLC_HOME, env.SDLC_TELEGRAM_TOKEN]).toEqual([undefined, undefined]);
    expect(filteredEnv({}, ['SDLC_HOME']).SDLC_HOME).toBe('v');
  });
});
