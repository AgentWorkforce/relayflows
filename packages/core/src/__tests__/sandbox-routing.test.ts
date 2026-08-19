/**
 * Does a real workload actually run inside the sandbox?
 *
 * These tests deliberately do not assert on a mock. A mock backend proves only
 * that the runner called something; it cannot tell "routed into a sandbox" apart
 * from "quietly fell back to a local child process", which is the exact
 * regression this seam can suffer. So the workload here is real — a real
 * `WorkflowRunner.execute` over a real deterministic step, running a real `sh`
 * command as a real OS process — and the evidence is a fact only the sandbox can
 * produce: `RELAYFLOWS_SANDBOX_ENV_ID` is injected by the runtime at exec time
 * and exists nowhere in the parent process, so a command that prints it was
 * provably executed inside an environment the provider created.
 *
 * Each must-fire has a paired must-not-fire control on the same assertion, so a
 * change that routes everything (or nothing) into the sandbox turns one of the
 * pair red rather than sliding through.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InMemoryWorkflowDb } from '../memory-db.js';
import { SANDBOX_ENV_ID_VAR, createLocalProcessSandboxRuntime } from '../sandbox-local-runtime.js';
import { createSandboxProcessBackend } from '../sandbox-backend.js';
import type { RelayYamlConfig, WorkflowStepRow } from '../types.js';
import { WorkflowRunner } from '../runner.js';
import { workflow } from '../builder.js';

/**
 * Prints the two facts only a sandbox can supply: the environment id the
 * provider minted, and the HOME it repointed at the environment root. Neither
 * exists in the parent process, so neither can be produced by a fallback to a
 * local child process.
 */
const PROBE_COMMAND = `echo "env_id=\${${SANDBOX_ENV_ID_VAR}:-ABSENT}"; echo "home=$HOME"`;

function probeConfig(command = PROBE_COMMAND): RelayYamlConfig {
  // Built through the public builder so the probe config stays valid the same
  // way a user's workflow does, rather than by hand-rolling schema fields.
  return workflow('sandbox-routing-probe')
    .pattern('pipeline')
    .step('probe', { type: 'deterministic', command })
    .toConfig();
}

async function runProbe(
  options: ConstructorParameters<typeof WorkflowRunner>[0],
  command?: string
): Promise<{ status: string; step: WorkflowStepRow }> {
  const db = new InMemoryWorkflowDb();
  const runner = new WorkflowRunner({ ...options, db });
  const run = await runner.execute(probeConfig(command), 'sandbox-routing-probe-workflow');
  const steps = await db.getStepsByRunId(run.id);
  const step = steps.find((s) => s.stepName === 'probe');
  if (!step) throw new Error('probe step missing from run');
  return { status: run.status, step };
}

function parseEnvId(output: string | undefined): string {
  return /env_id=(\S+)/.exec(output ?? '')?.[1] ?? '';
}

function parseHome(output: string | undefined): string {
  return /home=(\S+)/.exec(output ?? '')?.[1] ?? '';
}

describe('sandbox routing — real workload through the abstraction', () => {
  let workspace: string;
  let savedProvider: string | undefined;

  beforeEach(async () => {
    // realpath because macOS resolves the temp dir through a /private symlink,
    // and the probe prints the resolved path a shell actually sees.
    workspace = realpathSync(await mkdtemp(path.join(tmpdir(), 'relayflows-routing-')));
    savedProvider = process.env.RELAYFLOWS_SANDBOX_PROVIDER;
    delete process.env.RELAYFLOWS_SANDBOX_PROVIDER;
  });

  afterEach(async () => {
    if (savedProvider === undefined) delete process.env.RELAYFLOWS_SANDBOX_PROVIDER;
    else process.env.RELAYFLOWS_SANDBOX_PROVIDER = savedProvider;
    await rm(workspace, { recursive: true, force: true });
  });

  // ── MUST FIRE ─────────────────────────────────────────────────────────────

  it('MUST FIRE: a deterministic step runs inside a sandbox the provider created', async () => {
    const { status, step } = await runProbe({
      cwd: workspace,
      sandbox: { provider: 'local-process' },
    });

    expect(status).toBe('completed');
    const envId = parseEnvId(step.output);
    // Not merely "present" — it must name a real environment this provider
    // minted, which the parent process has no way to produce.
    expect(envId).not.toBe('ABSENT');
    expect(envId).toMatch(/^relayflows-probe-/);
    expect(process.env[SANDBOX_ENV_ID_VAR]).toBeUndefined();

    // Second independent signal: HOME was repointed at the environment root,
    // so the process really lived inside the sandbox rather than merely being
    // handed an env var.
    const home = parseHome(step.output);
    expect(path.basename(home)).toBe(envId);
    expect(path.resolve(home)).not.toBe(path.resolve(workspace));
  });

  it('MUST FIRE: the env flag alone flips routing on, with no code change', async () => {
    process.env.RELAYFLOWS_SANDBOX_PROVIDER = 'local-process';
    const { status, step } = await runProbe({ cwd: workspace });

    expect(status).toBe('completed');
    expect(parseEnvId(step.output)).toMatch(/^relayflows-probe-/);
  });

  it('MUST FIRE: a real non-zero exit inside the sandbox fails the real step', async () => {
    // Proves the exit code is the sandboxed process's own, not a synthesized
    // one: a backend that swallowed exit codes would report success here.
    const { status, step } = await runProbe(
      { cwd: workspace, sandbox: { provider: 'local-process' } },
      `echo "env_id=\${${SANDBOX_ENV_ID_VAR}:-ABSENT}"; exit 17`
    );

    expect(status).toBe('failed');
    expect(step.status).toBe('failed');
    // Both halves matter: the code is the sandboxed process's own (a backend
    // that swallowed exit codes would report success), and the marker proves
    // the process that produced it ran inside the sandbox.
    expect(step.error ?? '').toContain('17');
    expect(step.error ?? '').toContain('relayflows-probe-');
  });

  it('MUST FIRE: the sandbox is torn down after the step', async () => {
    const { step } = await runProbe({
      cwd: workspace,
      sandbox: { provider: 'local-process' },
    });

    const home = parseHome(step.output);
    expect(home).toContain('relayflows-probe-');
    // The directory existed while the command ran — it is where the command's
    // own HOME pointed — and must not survive the step.
    expect(existsSync(home)).toBe(false);
  });

  // ── MUST NOT FIRE (controls) ──────────────────────────────────────────────

  it('MUST NOT FIRE: the default path never enters a sandbox', async () => {
    const { status, step } = await runProbe({ cwd: workspace });

    expect(status).toBe('completed');
    // Same workflow, same assertion target as the must-fire — only the flag
    // differs. If the default ever started routing, this goes red.
    expect(parseEnvId(step.output)).toBe('ABSENT');
    expect(parseHome(step.output)).not.toContain('relayflows-probe-');
  });

  it('MUST NOT FIRE: provider "none" is inert even when spelled out', async () => {
    const { step } = await runProbe({ cwd: workspace, sandbox: { provider: 'none' } });
    expect(parseEnvId(step.output)).toBe('ABSENT');
  });

  it('MUST NOT FIRE: explicit sandbox config beats the env flag, so opting out works', async () => {
    process.env.RELAYFLOWS_SANDBOX_PROVIDER = 'local-process';
    const { step } = await runProbe({ cwd: workspace, sandbox: { provider: 'none' } });

    // Reversibility is the whole promise of the flag: a caller that says "none"
    // must not be dragged into a sandbox by ambient environment.
    expect(parseEnvId(step.output)).toBe('ABSENT');
  });

  it('MUST NOT FIRE: an injected processBackend still wins over sandbox config', async () => {
    const calls: string[] = [];
    const backend = {
      createEnvironment: async (label: string) => {
        calls.push(label);
        return {
          id: 'injected',
          homeDir: '/injected',
          exec: async () => ({ output: 'env_id=INJECTED\nhome=/injected\n', exitCode: 0 }),
          uploadFile: async () => undefined,
          destroy: async () => undefined,
        };
      },
    };

    const { step } = await runProbe({
      cwd: workspace,
      sandbox: { provider: 'local-process' },
      processBackend: backend,
    });

    // An existing caller who injects a backend must keep it — this is what
    // makes the change safe for the router that does exactly that today.
    expect(calls).toEqual(['probe']);
    expect(parseEnvId(step.output)).toBe('INJECTED');
  });

  // ── Broken-routing control ────────────────────────────────────────────────

  it('goes red when routing is broken: a backend that drops the sandbox loses the marker', async () => {
    // Simulates the regression the must-fire tests exist to catch — a backend
    // that reports success while executing outside the environment it claimed
    // to create. The marker assertion is what turns red, proving those tests
    // are load-bearing rather than trivially green.
    const runtime = createLocalProcessSandboxRuntime();
    const honest = createSandboxProcessBackend(runtime);
    const broken = {
      createEnvironment: async (label: string) => {
        const env = await honest.createEnvironment(label);
        return {
          ...env,
          // The break: run in the parent instead of the sandbox.
          exec: async (command: string) => {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const { stdout } = await promisify(execFile)('sh', ['-c', command], {
              cwd: workspace,
            });
            return { output: stdout, exitCode: 0 };
          },
        };
      },
    };

    const { step } = await runProbe({ cwd: workspace, processBackend: broken });

    expect(parseEnvId(step.output)).toBe('ABSENT');
    expect(parseHome(step.output)).not.toContain('relayflows-probe-');
  });
});
