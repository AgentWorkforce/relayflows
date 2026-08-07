import { describe, expect, it } from 'vitest';

import { workflow } from '../builder.js';
import type { AgentDefinition } from '../types.js';

describe('WorkflowBuilder.agent()', () => {
  it('preserves every compatible AgentDefinition field in toConfig()', () => {
    const input = {
      name: 'reviewer',
      cli: 'codex',
      role: 'Reviews implementation quality',
      task: 'Review the proposed changes',
      channels: ['reviews'],
      constraints: {
        model: 'gpt-5',
        maxTokens: 4096,
        timeoutMs: 120_000,
        retries: 2,
        idleThresholdSecs: 45,
      },
      permissions: { access: 'readonly', network: false, exec: ['git diff'] },
      interactive: false,
      workdir: 'core',
      additionalPaths: ['docs', 'fixtures'],
      preset: 'reviewer',
      credentials: { proxy: true, provider: 'openai' },
      watch: [
        {
          paths: ['/github/repos/acme/relayflows/pulls/**'],
          events: ['created', 'updated'],
          debounceMs: 250,
          match: 'pull_request',
        },
      ],
      subscriptions: [
        {
          name: 'pull-request-updates',
          paths: ['/github/repos/acme/relayflows/pulls/**'],
          provider: 'github',
          events: ['file.created', 'file.updated'],
          debounceMs: 500,
          match: 'pull_request',
        },
      ],
      skills: 'Review TypeScript changes for correctness.',
    } satisfies Omit<Required<AgentDefinition>, 'cwd' | 'persona'>;
    const { name, constraints, ...options } = input;

    const config = workflow('agent-round-trip')
      .agent(name, { ...options, ...constraints })
      .step('noop', { type: 'deterministic', command: 'true' })
      .toConfig();

    expect(config.agents[0]).toEqual(input);
  });

  it('preserves cwd when workdir is omitted', () => {
    const config = workflow('agent-cwd')
      .agent('worker', { cli: 'claude', cwd: './packages/core' })
      .step('noop', { type: 'deterministic', command: 'true' })
      .toConfig();

    expect(config.agents[0]).toMatchObject({ cwd: './packages/core' });
    expect(config.agents[0]?.workdir).toBeUndefined();
  });

  it('accepts a persona in place of cli and role', () => {
    const config = workflow('persona-agent')
      .agent('integrations', { persona: 'nango-integrations' })
      .step('sync', { agent: 'integrations', task: 'Fix the failed sync' })
      .toConfig();

    expect(config.agents[0]).toEqual({
      name: 'integrations',
      persona: 'nango-integrations',
    });
  });

  it('rejects mutually exclusive cwd and workdir options', () => {
    expect(() =>
      workflow('invalid-agent').agent('worker', {
        cli: 'claude',
        cwd: './packages/core',
        workdir: 'core',
      })
    ).toThrow('Agent "worker" cannot define both "cwd" and "workdir"; they are mutually exclusive');
  });
});
