/**
 * Human-assistance gate validation.
 *
 * Both misconfigurations covered here fail OPEN: the run proceeds past an
 * approval gate without a human ever being asked. On a gate whose whole purpose
 * is to stop a writeback, that is the worst available outcome, so both are
 * errors rather than warnings.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateWorkflow } from '../validator.js';
import { WorkflowRunner, resolveRelayfileBaseUrl } from '../runner.js';
import type { RelayYamlConfig } from '../types.js';

function configWith(overrides: {
  gateAgent: Partial<RelayYamlConfig['agents'][number]>;
  stepHumanAssistance?: unknown;
  swarmHumanAssistance?: unknown;
}): RelayYamlConfig {
  return {
    version: '1.0',
    name: 'gate-fixture',
    swarm: {
      pattern: 'dag',
      channel: 'wf-gate-fixture',
      ...(overrides.swarmHumanAssistance !== undefined
        ? { humanAssistance: overrides.swarmHumanAssistance }
        : {}),
    },
    agents: [{ name: 'release-manager', cli: 'claude', ...overrides.gateAgent }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'approval-gate',
            agent: 'release-manager',
            task: 'Print HUMAN_QUESTION: may I ship?',
            ...(overrides.stepHumanAssistance !== undefined
              ? { humanAssistance: overrides.stepHumanAssistance }
              : {}),
          },
        ],
      },
    ],
  } as unknown as RelayYamlConfig;
}

const SWARM_SLACK = { slack: { channel: 'approvals', timeoutMs: 86_400_000 } };

describe('human-assistance gate validation', () => {
  it('rejects a gate on a non-interactive preset, which would self-approve', () => {
    for (const preset of ['worker', 'reviewer', 'analyst'] as const) {
      const issues = validateWorkflow(
        configWith({ gateAgent: { preset }, swarmHumanAssistance: SWARM_SLACK })
      );
      const issue = issues.find((i) => i.code === 'HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT');
      expect(issue, `preset: ${preset} should be rejected`).toBeDefined();
      expect(issue?.severity).toBe('error');
      expect(issue?.location).toBe('step:approval-gate');
      expect(issue?.message).toContain(preset);
    }
  });

  it('rejects an explicit interactive: false gate agent', () => {
    const issues = validateWorkflow(
      configWith({ gateAgent: { interactive: false }, swarmHumanAssistance: SWARM_SLACK })
    );
    expect(
      issues.find((i) => i.code === 'HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT')?.severity
    ).toBe('error');
  });

  it('accepts a gate on an interactive agent (no preset)', () => {
    const issues = validateWorkflow(configWith({ gateAgent: {}, swarmHumanAssistance: SWARM_SLACK }));
    expect(issues.find((i) => i.code === 'HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT')).toBeUndefined();
  });

  it('stays quiet when no human assistance is configured at all', () => {
    const issues = validateWorkflow(configWith({ gateAgent: { preset: 'worker' } }));
    expect(issues.find((i) => i.code === 'HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT')).toBeUndefined();
  });

  it('honours humanAssistance: false on the step as an opt-out', () => {
    const issues = validateWorkflow(
      configWith({
        gateAgent: { preset: 'worker' },
        swarmHumanAssistance: SWARM_SLACK,
        stepHumanAssistance: false,
      })
    );
    expect(issues.find((i) => i.code === 'HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT')).toBeUndefined();
  });

  it('rejects `slack: true` on a step because it discards the swarm channel and timeout', () => {
    const issues = validateWorkflow(
      configWith({
        gateAgent: {},
        swarmHumanAssistance: SWARM_SLACK,
        stepHumanAssistance: { slack: true },
      })
    );
    const issue = issues.find((i) => i.code === 'HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG');
    expect(issue?.severity).toBe('error');
    // The operator needs to see exactly what would have been silently lost.
    expect(issue?.message).toContain('approvals');
    expect(issue?.message).toContain('86400000');
  });

  it('allows a step that restates the full slack object', () => {
    const issues = validateWorkflow(
      configWith({
        gateAgent: {},
        swarmHumanAssistance: SWARM_SLACK,
        stepHumanAssistance: { slack: { channel: 'other-channel', timeoutMs: 3_600_000 } },
      })
    );
    expect(
      issues.find((i) => i.code === 'HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG')
    ).toBeUndefined();
  });

  it('allows `slack: true` when the swarm slack object carries nothing to lose', () => {
    // `humanAssistance: { slack: {} }` upstream has identical effective defaults,
    // so the override discards nothing and erroring would be noise.
    const issues = validateWorkflow(
      configWith({
        gateAgent: {},
        swarmHumanAssistance: { slack: {} },
        stepHumanAssistance: { slack: true },
      })
    );
    expect(
      issues.find((i) => i.code === 'HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG')
    ).toBeUndefined();
  });

  it('still reports the override when only mentions or ignoreUserIds would be lost', () => {
    const issues = validateWorkflow(
      configWith({
        gateAgent: {},
        swarmHumanAssistance: { slack: { mentions: ['@oncall'] } },
        stepHumanAssistance: { slack: true },
      })
    );
    const issue = issues.find((i) => i.code === 'HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('@oncall');
  });

  it('does not warn about a step override when the swarm has no slack config to lose', () => {
    const issues = validateWorkflow(
      configWith({ gateAgent: {}, stepHumanAssistance: { slack: true } })
    );
    expect(
      issues.find((i) => i.code === 'HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG')
    ).toBeUndefined();
  });
});

describe('resolveRelayfileBaseUrl', () => {
  // The resolver consults process.env, so every case here pins it explicitly.
  // Without this the default-value assertions pass or fail depending on whether
  // the developer happens to have RELAYFILE_BASE_URL exported.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the hosted service, not localhost', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', '');
    expect(resolveRelayfileBaseUrl({})).toBe('https://file.agentrelay.com');
  });

  it('falls back to process.env when there is no config or supplied env', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', 'https://from-process-env');
    expect(resolveRelayfileBaseUrl({})).toBe('https://from-process-env');
  });

  it('prefers a supplied env value over process.env', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', 'https://from-process-env');
    expect(resolveRelayfileBaseUrl({ env: { RELAYFILE_BASE_URL: 'https://from-supplied' } })).toBe(
      'https://from-supplied'
    );
  });

  it('prefers explicit workflow config over the environment', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', 'https://from-process-env');
    expect(
      resolveRelayfileBaseUrl({
        configBaseUrl: 'https://relayfile.internal',
        env: { RELAYFILE_BASE_URL: 'https://from-env' },
      })
    ).toBe('https://relayfile.internal');
  });

  it('falls back to the supplied env before the default', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', '');
    expect(resolveRelayfileBaseUrl({ env: { RELAYFILE_BASE_URL: 'https://from-env' } })).toBe(
      'https://from-env'
    );
  });

  it('ignores blank values rather than treating them as configured', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', '');
    expect(resolveRelayfileBaseUrl({ configBaseUrl: '   ', env: { RELAYFILE_BASE_URL: '' } })).toBe(
      'https://file.agentrelay.com'
    );
  });

  it('trims a configured value', () => {
    vi.stubEnv('RELAYFILE_BASE_URL', '');
    expect(resolveRelayfileBaseUrl({ configBaseUrl: '  https://trimmed  ' })).toBe(
      'https://trimmed'
    );
  });
});

/**
 * The checks above are worthless if they only run under `--validate`.
 * `WorkflowRunner.validateConfig` is on the normal execution path, so a
 * fail-open gate has to be refused there too.
 */
describe('gate validation is enforced on the normal execution path', () => {
  const runner = () => new WorkflowRunner({ cwd: process.cwd() });

  it('refuses to run a config whose gate agent is non-interactive', () => {
    const config = configWith({
      gateAgent: { preset: 'worker' },
      swarmHumanAssistance: SWARM_SLACK,
    });
    expect(() => runner().validateConfig(config)).toThrow(
      /HUMAN_ASSISTANCE_NON_INTERACTIVE_AGENT/
    );
  });

  it('refuses a step override that would discard the swarm slack config', () => {
    const config = configWith({
      gateAgent: {},
      swarmHumanAssistance: SWARM_SLACK,
      stepHumanAssistance: { slack: true },
    });
    expect(() => runner().validateConfig(config)).toThrow(
      /HUMAN_ASSISTANCE_STEP_OVERRIDE_DROPS_CONFIG/
    );
  });

  it('accepts a correctly configured gate', () => {
    const config = configWith({ gateAgent: {}, swarmHumanAssistance: SWARM_SLACK });
    expect(() => runner().validateConfig(config)).not.toThrow();
  });

  it('leaves configs without human assistance alone', () => {
    const config = configWith({ gateAgent: { preset: 'worker' } });
    expect(() => runner().validateConfig(config)).not.toThrow();
  });
});
