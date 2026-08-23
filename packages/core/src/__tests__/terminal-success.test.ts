import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkflowRunner, type WorkflowDb } from '../runner.js';
import type {
  RelayYamlConfig,
  WorkflowRunRow,
  WorkflowStep,
  WorkflowStepRow,
} from '../types.js';

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (run) => runs.set(run.id, { ...run })),
    updateRun: vi.fn(async (id, patch) => {
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, ...patch });
    }),
    getRun: vi.fn(async (id) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step) => steps.set(step.id, { ...step })),
    updateStep: vi.fn(async (id, patch) => {
      const step = steps.get(id);
      if (step) steps.set(id, { ...step, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId) =>
      [...steps.values()].filter((step) => step.runId === runId).map((step) => ({ ...step }))
    ),
  };
}

function terminalStep(exitCode: number, configuredCodes: number[]): WorkflowStep {
  return {
    name: 'gate',
    type: 'deterministic',
    command: `exit ${exitCode}`,
    terminalSuccessExitCodes: configuredCodes,
  };
}

function configWithSteps(steps: WorkflowStep[]): RelayYamlConfig {
  return {
    version: '1',
    name: 'terminal-success-test',
    swarm: { pattern: 'dag' },
    agents: [],
    workflows: [{ name: 'default', steps }],
    errorHandling: { strategy: 'fail-fast' },
    trajectories: false,
  };
}

describe('terminal-success deterministic exits', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { codes: [] as number[], message: 'non-empty array' },
    { codes: [78, 78], message: 'must not contain duplicates' },
    { codes: [256], message: 'from 0 to 255' },
  ])('rejects invalid terminal-success exit code lists: $codes', async ({ codes, message }) => {
    const db = makeDb();
    const runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });

    await expect(
      runner.execute(configWithSteps([terminalStep(0, codes)]), 'default')
    ).rejects.toThrow(message);
  });

  it('ends the run as completed_early and skips all not-started work', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-success-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const runner = new WorkflowRunner({ db, cwd, workspaceId: 'ws-test' });
    const events: string[] = [];
    runner.on((event) => events.push(event.type));

    const run = await runner.execute(
      configWithSteps([
        {
          name: 'ready-sibling',
          type: 'deterministic',
          command: 'touch ready-sibling-ran',
        },
        terminalStep(78, [78]),
        {
          name: 'downstream',
          type: 'deterministic',
          command: 'touch downstream-ran',
          dependsOn: ['gate'],
        },
      ]),
      'default'
    );

    expect(run.status).toBe('completed_early');
    expect(events).toContain('run:completed-early');
    expect(events).not.toContain('run:completed');
    expect(events).not.toContain('run:failed');
    expect(existsSync(path.join(cwd, 'ready-sibling-ran'))).toBe(false);
    expect(existsSync(path.join(cwd, 'downstream-ran'))).toBe(false);

    const steps = await db.getStepsByRunId(run.id);
    expect(steps.find((step) => step.stepName === 'gate')).toMatchObject({
      status: 'completed',
      completionReason: 'completed_early_exit',
    });
    expect(steps.find((step) => step.stepName === 'ready-sibling')?.status).toBe('skipped');
    expect(steps.find((step) => step.stepName === 'downstream')?.status).toBe('skipped');
  });

  it('still fails for an unlisted non-zero exit code', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-failure-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const runner = new WorkflowRunner({ db, cwd, workspaceId: 'ws-test' });

    const run = await runner.execute(
      configWithSteps([
        terminalStep(79, [78]),
        {
          name: 'downstream',
          type: 'deterministic',
          command: 'touch downstream-ran',
          dependsOn: ['gate'],
        },
      ]),
      'default'
    );

    expect(run.status).toBe('failed');
    expect(existsSync(path.join(cwd, 'downstream-ran'))).toBe(false);
    const steps = await db.getStepsByRunId(run.id);
    expect(steps.find((step) => step.stepName === 'gate')?.status).toBe('failed');
    expect(steps.find((step) => step.stepName === 'downstream')?.status).toBe('skipped');
  });

  it('does not let terminal-success classification hide a verification failure', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-verification-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const runner = new WorkflowRunner({ db, cwd, workspaceId: 'ws-test' });
    const gate = {
      ...terminalStep(78, [78]),
      command: 'printf no-work; exit 78',
      verification: { type: 'output_contains', value: 'verified' } as const,
    };

    const run = await runner.execute(configWithSteps([gate]), 'default');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('output does not contain "verified"');
    const steps = await db.getStepsByRunId(run.id);
    expect(steps[0]).toMatchObject({
      status: 'failed',
      completionReason: 'failed_verification',
    });
  });

  it('continues normally when a terminal-capable gate exits with an unlisted success code', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-continue-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const runner = new WorkflowRunner({ db, cwd, workspaceId: 'ws-test' });

    const run = await runner.execute(
      configWithSteps([
        terminalStep(0, [78]),
        {
          name: 'ready-sibling',
          type: 'deterministic',
          command: 'touch ready-sibling-ran',
        },
      ]),
      'default'
    );

    expect(run.status).toBe('completed');
    expect(existsSync(path.join(cwd, 'ready-sibling-ran'))).toBe(true);
  });

  it('honors terminal-success exits returned by an injected executor', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-executor-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const executeDeterministicStep = vi.fn(async () => ({ output: 'nothing to do', exitCode: 78 }));
    const runner = new WorkflowRunner({
      db,
      cwd,
      workspaceId: 'ws-test',
      executor: { executeDeterministicStep },
    });

    const run = await runner.execute(
      configWithSteps([
        terminalStep(78, [78]),
        { name: 'ready-sibling', type: 'deterministic', command: 'echo should-not-run' },
      ]),
      'default'
    );

    expect(run.status).toBe('completed_early');
    expect(executeDeterministicStep).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret exit 78 without the opt-in field', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relayflows-terminal-compat-'));
    tempDirs.push(cwd);
    const db = makeDb();
    const runner = new WorkflowRunner({ db, cwd, workspaceId: 'ws-test' });

    const run = await runner.execute(
      configWithSteps([
        { name: 'gate', type: 'deterministic', command: 'exit 78' },
        {
          name: 'downstream',
          type: 'deterministic',
          command: 'touch downstream-ran',
          dependsOn: ['gate'],
        },
      ]),
      'default'
    );

    expect(run.status).toBe('failed');
    expect(existsSync(path.join(cwd, 'downstream-ran'))).toBe(false);
    const steps = await db.getStepsByRunId(run.id);
    expect(steps.find((step) => step.stepName === 'gate')?.status).toBe('failed');
    expect(steps.find((step) => step.stepName === 'downstream')?.status).toBe('skipped');
  });
});
