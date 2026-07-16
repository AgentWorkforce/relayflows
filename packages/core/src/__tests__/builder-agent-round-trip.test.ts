import { describe, expect, it } from 'vitest';

import { workflow } from '../builder.js';
import type { AgentDefinition } from '../types.js';

describe('WorkflowBuilder.agent()', () => {
  it('preserves every AgentDefinition field in toConfig()', () => {
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
      cwd: './packages/core',
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
    } satisfies Required<AgentDefinition>;
    const { name, constraints, ...options } = input;

    const config = workflow('agent-round-trip')
      .agent(name, { ...options, ...constraints })
      .step('noop', { type: 'deterministic', command: 'true' })
      .toConfig();

    expect(config.agents[0]).toEqual(input);
  });
});
