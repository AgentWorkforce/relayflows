#!/usr/bin/env node
import { Command } from 'commander';
import { runWorkflow } from '@relayflows/core';

const program = new Command();

program
  .name('relayflows')
  .description('Run Agent Relay workflows from the command line')
  .version('0.1.0');

program
  .command('run <workflow>')
  .description('Run a workflow YAML file')
  .option('--dry-run', 'parse and validate without executing')
  .action(async (workflow, opts) => {
    await runWorkflow({ file: workflow, dryRun: opts.dryRun });
  });

program.parseAsync(process.argv);
