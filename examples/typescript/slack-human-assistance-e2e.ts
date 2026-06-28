import {
  WorkflowRunner,
  createDefaultEventLogger,
  formatDryRunReport,
  workflow,
  type RelayYamlConfig,
} from '@relayflows/core';

const SLACK_CHANNEL_NAME = 'watchdog-test';

async function main(): Promise<void> {
  const config: RelayYamlConfig = workflow('slack-human-assistance-e2e-ts')
    .description('Validates Slack human-question wait and answer injection through Relayfile.')
    .pattern('dag')
    .timeout(600_000)
    .agent('slack-e2e-agent', {
      cli: 'claude',
      role: 'Slack human-assistance E2E validation agent',
      idleThresholdSecs: 5,
      timeoutMs: 600_000,
    })
    .step('ask-human-and-use-answer', {
      agent: 'slack-e2e-agent',
      timeoutMs: 600_000,
      verification: {
        type: 'output_contains',
        value: 'ANSWER_RECEIVED:',
      },
      task: `
Validate Relayflows Slack human assistance.

You need an operator approval code before finishing. Ask the operator by printing
exactly one line with the literal prefix HUMAN_QUESTION: followed by this exact question:
What approval code should I use for the Relayflows TypeScript Slack assistance check?

After the runner provides the operator reply back into this session as HUMAN_ANSWER, print:
ANSWER_RECEIVED: <the approval code from the operator reply>

Then terminate with /exit.
`.trim(),
    })
    .toConfig();

  config.swarm.humanAssistance = {
    slack: {
      channel: SLACK_CHANNEL_NAME,
      timeoutMs: 300_000,
    },
  };
  config.integrations = {
    relayfile: {},
  };

  const runner = new WorkflowRunner({ cwd: process.cwd() });

  if (process.env.DRY_RUN) {
    console.log(formatDryRunReport(runner.dryRun(config)));
    return;
  }

  runner.on(createDefaultEventLogger('normal'));

  const result = await runner.execute(config);

  if (result.status !== 'completed') {
    throw new Error(`Workflow finished with status ${result.status}${result.error ? `: ${result.error}` : ''}`);
  }
}

main().catch((error) => {
  console.error('Fatal error during workflow execution:', error);
  process.exit(1);
});
