// run.mjs — the exact reproducer driver, identical for baseline and candidate.
// Runs INSIDE the outer Daytona sandbox. Exit 0 iff the run completed.
import { runWorkflow, JsonFileWorkflowDb } from '@relayflows/core';

const fixtureDir = process.argv[2] ?? '/home/daytona/reproducer';
const result = await runWorkflow(`${fixtureDir}/reproducer.yaml`, { cwd: fixtureDir });

console.log(`RUN_STATUS=${result.status}`);
if (result.error) console.log(`RUN_ERROR=${result.error.slice(0, 500)}`);

const db = new JsonFileWorkflowDb(`${fixtureDir}/.agent-relay/workflow-runs.jsonl`);
const steps = await db.getStepsByRunId(result.id);
for (const step of steps) {
  console.log(`STEP ${step.stepName} status=${step.status}`);
  if (step.output) {
    console.log(`STEP ${step.stepName} OUTPUT BEGIN`);
    console.log(step.output);
    console.log(`STEP ${step.stepName} OUTPUT END`);
  }
  if (step.error) console.log(`STEP ${step.stepName} ERROR: ${String(step.error).slice(0, 500)}`);
}

process.exit(result.status === 'completed' ? 0 : 1);
