/**
 * `errorHandling.strategy` validation.
 *
 * An unrecognized strategy is not a harmless typo: applyReliabilityDefaults()
 * treats anything other than 'fail-fast' / 'continue' as an opt-in to 'retry',
 * which attaches an LLM repair agent with write access to the workspace. The
 * validator has to reject the value rather than let it select the most
 * permissive mode silently.
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../validator.js';
import { WorkflowRunner } from '../runner.js';
import type { RelayYamlConfig } from '../types.js';

const baseConfig = (strategy?: string): RelayYamlConfig =>
  ({
    version: '1.0',
    name: 'strategy-fixture',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude', role: 'Does the work' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'gate', type: 'deterministic', command: 'true' }],
      },
    ],
    ...(strategy !== undefined ? { errorHandling: { strategy } } : {}),
  }) as unknown as RelayYamlConfig;

const strategyErrors = (strategy?: string) =>
  validateWorkflow(baseConfig(strategy)).filter((i) => i.code === 'INVALID_ERROR_STRATEGY');

describe('errorHandling.strategy validation', () => {
  it.each(['fail-fast', 'continue', 'retry'])('accepts "%s"', (strategy) => {
    expect(strategyErrors(strategy)).toHaveLength(0);
  });

  it('accepts a config with no errorHandling block', () => {
    expect(strategyErrors(undefined)).toHaveLength(0);
  });

  it('rejects "fail", which reads as the strictest option but selects retry', () => {
    const issues = strategyErrors('fail');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('fail-fast');
    expect(issues[0].location).toBe('errorHandling:strategy');
  });

  it('rejects an arbitrary unknown strategy', () => {
    expect(strategyErrors('halt-and-catch-fire')).toHaveLength(1);
  });

  it('rejects an explicitly empty strategy', () => {
    expect(strategyErrors('')).toHaveLength(1);
  });
});

describe('errorHandling.strategy on the execution path', () => {
  // validateWorkflow() only runs under `--validate`. Every normal path —
  // packages/cli, runWorkflow(), and resume — goes through
  // WorkflowRunner.validateConfig() straight into applyReliabilityDefaults(),
  // so the check has to be refused there or the repair agent still fires.
  const runner = () => new WorkflowRunner({ cwd: process.cwd() });

  it.each(['fail-fast', 'continue', 'retry'])('admits "%s"', (strategy) => {
    expect(() => runner().validateConfig(baseConfig(strategy))).not.toThrow();
  });

  it('admits a config with no errorHandling block', () => {
    expect(() => runner().validateConfig(baseConfig(undefined))).not.toThrow();
  });

  it('refuses to run a config with strategy "fail"', () => {
    expect(() => runner().validateConfig(baseConfig('fail'))).toThrow(
      /errorHandling\.strategy "fail" is not valid/
    );
  });

  it('names the mode the invalid value would have selected', () => {
    expect(() => runner().validateConfig(baseConfig('halt'))).toThrow(/treated as "retry"/);
  });
});
