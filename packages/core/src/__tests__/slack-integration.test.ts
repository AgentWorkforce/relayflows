import { describe, expect, it } from 'vitest';

import { createSlackStep, SlackStepExecutor, slackStepConfigFromWorkflowStep } from '../integrations/slack.js';

describe('Slack integration step helpers', () => {
  it('creates blocking askQuestion workflow steps', () => {
    const step = createSlackStep({
      name: 'ask-human',
      dependsOn: ['investigate'],
      action: 'askQuestion',
      channel: '#eng',
      text: 'Which path should I take?',
      waitTimeoutMs: 120_000,
      pollIntervalMs: 2_000,
      ignoreUserIds: ['UBOT'],
      injectToAgent: 'builder-runtime',
      injectTemplate: 'Decision: {{answer.text}}',
      output: { format: 'text', path: 'answer.text' },
    });

    expect(step).toMatchObject({
      name: 'ask-human',
      type: 'integration',
      integration: 'slack',
      action: 'askQuestion',
      dependsOn: ['investigate'],
      params: {
        channel: '#eng',
        text: 'Which path should I take?',
        waitTimeoutMs: '120000',
        pollIntervalMs: '2000',
        ignoreUserIds: '["UBOT"]',
        injectToAgent: 'builder-runtime',
        injectTemplate: 'Decision: {{answer.text}}',
        output: '{"format":"text","path":"answer.text"}',
      },
    });
  });

  it('parses askQuestion params from resolved YAML values', () => {
    const config = slackStepConfigFromWorkflowStep(
      {
        name: 'ask-human',
        type: 'integration',
        integration: 'slack',
        action: 'askQuestion',
        params: {},
      },
      {
        channel: '#eng',
        text: 'Question from {{steps.worker.output}}',
        timeoutMs: '60000',
        pollIntervalMs: '1000',
      ignoreUserIds: '["UBOT"]',
        injectToAgent: 'builder-runtime',
        injectTemplate: 'Decision: {{answer.text}}',
        output: '{"format":"text","path":"answer.text"}',
      }
    );

    expect(config).toEqual({
      name: 'ask-human',
      dependsOn: undefined,
      action: 'askQuestion',
      channel: '#eng',
      text: 'Question from {{steps.worker.output}}',
      threadTs: undefined,
      mentions: undefined,
      unfurl: undefined,
      waitTimeoutMs: 60_000,
      pollIntervalMs: 1_000,
      ignoreUserIds: ['UBOT'],
      injectToAgent: 'builder-runtime',
      injectTemplate: 'Decision: {{answer.text}}',
      config: undefined,
      output: { format: 'text', path: 'answer.text' },
      timeoutMs: undefined,
      retries: undefined,
    });
  });

  it('injects askQuestion answers into the requested active agent', async () => {
    const injected: Array<{ agentName: string; text: string; stepName: string; source: 'slack' }> = [];
    const client = {
      executeAction: async () => ({
        success: true,
        output: '',
        data: {
          question: { text: 'Choose A or B?' },
          answer: { text: 'Use B', ts: '1.2' },
        },
      }),
    };

    const result = await new SlackStepExecutor().execute(
      {
        name: 'ask-human',
        action: 'askQuestion',
        text: 'Choose A or B?',
        injectToAgent: 'builder-runtime',
        injectTemplate: 'Decision: {{answer.text}}',
        output: { format: 'text', path: 'answer.text' },
      },
      {
        client: client as any,
        injectAnswerToAgent: async (input) => {
          injected.push(input);
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Use B');
    expect(injected).toEqual([
      {
        agentName: 'builder-runtime',
        text: 'Decision: Use B',
        stepName: 'ask-human',
        source: 'slack',
      },
    ]);
  });

  it('does not inject askQuestion output when the Slack action fails', async () => {
    const injected: Array<{ agentName: string; text: string; stepName: string; source: 'slack' }> = [];
    const client = {
      executeAction: async () => ({
        success: false,
        output: 'Slack step failed',
        error: 'timeout',
        data: {
          question: { text: 'Choose A or B?' },
          answer: { text: 'Use B' },
        },
      }),
    };

    const result = await new SlackStepExecutor().execute(
      {
        name: 'ask-human',
        action: 'askQuestion',
        text: 'Choose A or B?',
        injectToAgent: 'builder-runtime',
      },
      {
        client: client as any,
        injectAnswerToAgent: async (input) => {
          injected.push(input);
        },
      }
    );

    expect(result.success).toBe(false);
    expect(injected).toEqual([]);
  });

  it('preserves replacement metacharacters when formatting injected answers', async () => {
    const injected: Array<{ agentName: string; text: string; stepName: string; source: 'slack' }> = [];
    const client = {
      executeAction: async () => ({
        success: true,
        output: '',
        data: {
          question: { text: 'Use $1 or $&?' },
          answer: { text: 'Use $$ literal' },
        },
      }),
    };

    await new SlackStepExecutor().execute(
      {
        name: 'ask-human',
        action: 'askQuestion',
        text: 'Use $1 or $&?',
        injectToAgent: 'builder-runtime',
        injectTemplate: 'Answer={{answer.text}} Question={{question.text}}',
      },
      {
        client: client as any,
        injectAnswerToAgent: async (input) => {
          injected.push(input);
        },
      }
    );

    expect(injected[0]?.text).toBe('Answer=Use $$ literal Question=Use $1 or $&?');
  });
});
