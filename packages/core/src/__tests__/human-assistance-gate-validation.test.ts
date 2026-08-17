/**
 * Human-assistance gate validation.
 *
 * Both misconfigurations covered here fail OPEN: the run proceeds past an
 * approval gate without a human ever being asked. On a gate whose whole purpose
 * is to stop a writeback, that is the worst available outcome, so both are
 * errors rather than warnings.
 */
import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../validator.js';
import { resolveRelayfileBaseUrl } from '../runner.js';
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
  it('defaults to the hosted service, not localhost', () => {
    expect(resolveRelayfileBaseUrl({})).toBe('https://file.agentrelay.com');
  });

  it('prefers explicit workflow config over the environment', () => {
    expect(
      resolveRelayfileBaseUrl({
        configBaseUrl: 'https://relayfile.internal',
        env: { RELAYFILE_BASE_URL: 'https://from-env' },
      })
    ).toBe('https://relayfile.internal');
  });

  it('falls back to the supplied env before the default', () => {
    expect(resolveRelayfileBaseUrl({ env: { RELAYFILE_BASE_URL: 'https://from-env' } })).toBe(
      'https://from-env'
    );
  });

  it('ignores blank values rather than treating them as configured', () => {
    expect(resolveRelayfileBaseUrl({ configBaseUrl: '   ', env: { RELAYFILE_BASE_URL: '' } })).toBe(
      'https://file.agentrelay.com'
    );
  });

  it('trims a configured value', () => {
    expect(resolveRelayfileBaseUrl({ configBaseUrl: '  https://trimmed  ' })).toBe(
      'https://trimmed'
    );
  });
});
