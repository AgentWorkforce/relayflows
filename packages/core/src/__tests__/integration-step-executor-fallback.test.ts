import { describe, it, expect } from 'vitest';
import { WorkflowRunner } from '../runner.js';
import type { RelayYamlConfig, RunnerStepExecutor, WorkflowStep } from '../types.js';

/**
 * Integration steps used to be fatal unless the caller supplied an executor
 * implementing `executeIntegrationStep`. Nothing did: the local default has no
 * executor at all, and the cloud runtime's executor implements only
 * `executeAgentStep` and `executeDeterministicStep`. They now resolve a
 * built-in executor per step, the way deterministic steps already did.
 */
function configWithIntegrationStep(integration: string): RelayYamlConfig {
  const step: WorkflowStep = {
    name: 'integration-step',
    type: 'integration',
    integration,
    action: 'listIssues',
    params: { repo: 'owner/repo' },
  } as WorkflowStep;

  return {
    version: '1.0',
    name: 'integration-fallback',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'unused', cli: 'claude' }],
    workflows: [{ name: 'wf', steps: [step] }],
  } as RelayYamlConfig;
}

/** Same shape as cloud's SandboxedStepExecutor: no executeIntegrationStep. */
const cloudShapedExecutor: RunnerStepExecutor = {
  async executeAgentStep() {
    return 'stub';
  },
  async executeDeterministicStep() {
    return { output: 'stub', exitCode: 0 };
  },
};

describe('integration step executor resolution', () => {
  it('does not reject a known integration when no executor is supplied', async () => {
    const runner = new WorkflowRunner();
    const step = configWithIntegrationStep('github').workflows![0].steps[0];
    const resolved = await (
      runner as unknown as {
        resolveBuiltinIntegrationExecutor(s: WorkflowStep): Promise<RunnerStepExecutor | undefined>;
      }
    ).resolveBuiltinIntegrationExecutor(step);

    expect(resolved?.executeIntegrationStep).toBeTypeOf('function');
  });

  it('does NOT resolve a built-in for stateful integrations', async () => {
    // BrowserStepExecutor holds live BrowserClient sessions and needs
    // closeAll() on teardown. Caching it on the runner would leak browser
    // processes across runs, so it is excluded until that lifecycle exists.
    const runner = new WorkflowRunner();
    for (const integration of ['browser', 'slack']) {
      const step = configWithIntegrationStep(integration).workflows![0].steps[0];
      const resolved = await (
        runner as unknown as {
          resolveBuiltinIntegrationExecutor(s: WorkflowStep): Promise<RunnerStepExecutor | undefined>;
        }
      ).resolveBuiltinIntegrationExecutor(step);
      expect(resolved, integration).toBeUndefined();
    }
  });

  it('gives concurrent resolvers the SAME instance', async () => {
    // Caching only completed executors lets two parallel first calls both miss
    // and construct their own.
    const runner = new WorkflowRunner();
    const step = configWithIntegrationStep('github').workflows![0].steps[0];
    const resolve = (
      runner as unknown as {
        resolveBuiltinIntegrationExecutor(s: WorkflowStep): Promise<RunnerStepExecutor | undefined>;
      }
    ).resolveBuiltinIntegrationExecutor.bind(runner);

    const [a, b, c] = await Promise.all([resolve(step), resolve(step), resolve(step)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('memoises the built-in executor per integration', async () => {
    const runner = new WorkflowRunner();
    const step = configWithIntegrationStep('github').workflows![0].steps[0];
    const resolve = (
      runner as unknown as {
        resolveBuiltinIntegrationExecutor(s: WorkflowStep): Promise<RunnerStepExecutor | undefined>;
      }
    ).resolveBuiltinIntegrationExecutor.bind(runner);

    expect(await resolve(step)).toBe(await resolve(step));
  });

  it('returns undefined for an unknown integration so the caller can name the built-ins', async () => {
    const runner = new WorkflowRunner();
    const step = configWithIntegrationStep('not-a-real-integration').workflows![0].steps[0];
    const resolved = await (
      runner as unknown as {
        resolveBuiltinIntegrationExecutor(s: WorkflowStep): Promise<RunnerStepExecutor | undefined>;
      }
    ).resolveBuiltinIntegrationExecutor(step);

    expect(resolved).toBeUndefined();
  });

  it('prefers an injected executor that implements executeIntegrationStep', async () => {
    let called = false;
    const injected: RunnerStepExecutor = {
      ...cloudShapedExecutor,
      async executeIntegrationStep() {
        called = true;
        return { output: 'from-injected', success: true };
      },
    };

    const runner = new WorkflowRunner({ executor: injected });
    const step = configWithIntegrationStep('github').workflows![0].steps[0];
    const result = await injected.executeIntegrationStep!(step, {}, {});

    expect(called).toBe(true);
    expect(result.output).toBe('from-injected');
    // The built-in is still resolvable, but the injected one wins at the call site.
    expect(runner).toBeDefined();
  });
});
