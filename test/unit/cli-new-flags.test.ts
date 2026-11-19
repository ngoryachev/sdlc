import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerTaskCommands } from '../../server/src/cli/tasks.js';

/**
 * `sdlc new` passes `o.approveOnClean` straight into the task: a flag whose name does not produce that key
 * is simply `undefined`, which silently falls back to the default and can never be turned off from the CLI.
 */
describe('sdlc new flags', () => {
  const newCmd = () => {
    const program = new Command();
    registerTaskCommands(program);
    return program.commands.find((c) => c.name() === 'new')!;
  };

  it('--no-approve-on-clean lands on approveOnClean', () => {
    const cmd = newCmd();
    expect(cmd.options.map((o) => o.attributeName())).toContain('approveOnClean');

    cmd.parseOptions(['--no-approve-on-clean']);
    expect(cmd.opts().approveOnClean).toBe(false);
  });

  it('defaults to approving (the flag is the only way to opt out)', () => {
    const cmd = newCmd();
    cmd.parseOptions([]);
    expect(cmd.opts().approveOnClean).toBe(true);
  });
});
