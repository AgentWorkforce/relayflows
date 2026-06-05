#!/usr/bin/env node
import { createRequire } from 'node:module';
import path from 'node:path';
import { Command } from 'commander';
import {
  runWorkflow,
  runScriptWorkflow,
  type WorkflowEvent,
} from '@relayflows/core';

type RunWorkflowOptions = {
  workflow?: string;
  dryRun?: boolean;
  resume?: string;
  startFrom?: string;
  previousRunId?: string;
};

type WorkflowRunResult = {
  id?: string;
  status: string;
  error?: string;
};

function logWorkflowEvent(event: WorkflowEvent): void {
  if (event.type === 'broker:event') return;
  const prefix = event.type.startsWith('run:') ? '[run]' : '[step]';
  const name = 'stepName' in event ? `${event.stepName} ` : '';
  const status = event.type.split(':')[1];
  const detail = 'error' in event ? `: ${event.error}` : '';
  console.log(`${prefix} ${name}${status}${detail}`);
}

async function runYamlWorkflow(
  filePath: string,
  options: RunWorkflowOptions & { onEvent: (event: WorkflowEvent) => void }
): Promise<WorkflowRunResult> {
  const result = await runWorkflow(filePath, options);
  if ('valid' in result) {
    const report = result as unknown as { valid: boolean; errors: string[] };
    return {
      status: report.valid ? 'dry-run' : 'failed',
      error: report.errors.join('; ') || undefined,
    };
  }
  return result;
}

// Read the version from package.json at runtime so it stays in sync with the
// version the publish workflow bumps. `../package.json` resolves to the package
// root from both src/cli.ts (dev) and dist/cli.js (published). createRequire
// avoids a static JSON import, which would fall outside tsconfig's rootDir.
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('relayflows')
  .description('Run Agent Relay workflows from the command line')
  .version(version);

program
  .command('run <file>')
  .description('Run a workflow file (YAML, TypeScript, or Python)')
  .option('-w, --workflow <name>', 'Run a specific workflow by name (default: first, YAML only)')
  .option('--dry-run', 'Validate workflow and show execution plan without running')
  .option('--resume <runId>', 'Resume a previously failed workflow run from where it left off')
  .option('--start-from <step>', 'Start from a specific step and skip predecessor steps')
  .option('--previous-run-id <runId>', 'Use cached outputs from a previous run when starting from a step')
  .action(async (filePath: string, options: RunWorkflowOptions) => {
    const ext = path.extname(filePath).toLowerCase();

    try {
      if (ext === '.yaml' || ext === '.yml') {
        if (options.resume) {
          console.log(`Resuming workflow run ${options.resume} from ${filePath}...`);
          const result = await runYamlWorkflow(filePath, {
            workflow: options.workflow,
            resume: options.resume,
            onEvent: logWorkflowEvent,
          });
          if (result.status === 'completed') {
            console.log('\nWorkflow resumed and completed successfully.');
            return;
          }
          console.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
          if (result.id) {
            console.error(`Run ID: ${result.id} — resume with: relayflows run ${filePath} --resume ${result.id}`);
          }
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(`Dry run: validating workflow from ${filePath}...`);
        } else {
          console.log(`Running workflow from ${filePath}...`);
        }

        const result = await runYamlWorkflow(filePath, {
          workflow: options.workflow,
          dryRun: options.dryRun,
          startFrom: options.startFrom,
          previousRunId: options.previousRunId,
          onEvent: logWorkflowEvent,
        });

        if (options.dryRun) return;

        if (result.status === 'completed') {
          console.log('\nWorkflow completed successfully.');
          return;
        }
        console.error(`\nWorkflow ${result.status}${result.error ? `: ${result.error}` : ''}`);
        if (result.id) {
          console.error(`Run ID: ${result.id} — resume with: relayflows run ${filePath} --resume ${result.id}`);
        }
        process.exit(1);
      }

      if (ext === '.ts' || ext === '.tsx' || ext === '.py') {
        console.log(`Running workflow script ${filePath}...`);
        await runScriptWorkflow(filePath, {
          dryRun: options.dryRun,
          resume: options.resume,
          startFrom: options.startFrom,
          previousRunId: options.previousRunId,
        });
        return;
      }

      console.error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
      process.exit(1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
