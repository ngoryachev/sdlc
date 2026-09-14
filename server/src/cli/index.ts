#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunPhase } from './run-phase.js';
import { registerTaskCommands } from './tasks.js';
import { registerServe } from './serve.js';

const program = new Command();
program.name('sdlc').description('Thin SDLC orchestration on top of Claude Code').version('0.1.0');
registerRunPhase(program);
registerTaskCommands(program);
registerServe(program);
program.parseAsync(process.argv).catch((e) => { console.error(e); process.exit(1); });
