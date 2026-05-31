import type { SlackRuntimeConfig } from './types.js';

export type SlackStepOutputMode = 'data' | 'result' | 'summary' | 'raw' | 'none';
export type SlackStepOutputFormat = 'json' | 'text';

export interface SlackStepOutputConfig {
  mode?: SlackStepOutputMode;
  format?: SlackStepOutputFormat;
  path?: string;
  includeMetadata?: boolean;
  pretty?: boolean;
}

export interface SlackStepConfig {
  name: string;
  dependsOn?: string[];
  action: 'postMessage';
  channel?: string;
  text: string;
  threadTs?: string;
  mentions?: string[];
  unfurl?: boolean;
  config?: SlackRuntimeConfig;
  output?: SlackStepOutputConfig;
  timeoutMs?: number;
  retries?: number;
}

export interface SlackWorkflowStep {
  name: string;
  type: 'integration';
  integration: 'slack';
  action: string;
  params: Record<string, string>;
  dependsOn?: string[];
  timeoutMs?: number;
  retries?: number;
}

export function createSlackStep(config: SlackStepConfig): SlackWorkflowStep {
  const params: Record<string, string> = {
    text: config.text,
  };

  if (config.channel !== undefined) params.channel = config.channel;
  if (config.threadTs !== undefined) params.threadTs = config.threadTs;
  if (config.mentions !== undefined) params.mentions = JSON.stringify(config.mentions);
  if (config.unfurl !== undefined) params.unfurl = String(config.unfurl);
  if (config.config !== undefined) params.config = JSON.stringify(config.config);
  if (config.output !== undefined) params.output = JSON.stringify(config.output);

  const step: SlackWorkflowStep = {
    name: config.name,
    type: 'integration',
    integration: 'slack',
    action: config.action,
    params,
  };

  if (config.dependsOn !== undefined) step.dependsOn = config.dependsOn;
  if (config.timeoutMs !== undefined) step.timeoutMs = config.timeoutMs;
  if (config.retries !== undefined) step.retries = config.retries;

  return step;
}
