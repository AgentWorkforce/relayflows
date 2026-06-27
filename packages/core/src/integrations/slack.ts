import type { RunnerStepExecutor, WorkflowStep } from '../types.js';

import { SlackClient } from '@relayflows/slack-primitive';
import {
  type PostMessageParams,
  type SlackActionResult,
  type SlackRuntimeConfig,
} from '@relayflows/slack-primitive';

interface AskQuestionParams extends PostMessageParams {
  timeoutMs?: number;
  pollIntervalMs?: number;
  ignoreUserIds?: string[];
}

export type SlackStepOutputMode = 'data' | 'result' | 'summary' | 'raw' | 'none';
export type SlackStepOutputFormat = 'json' | 'text';

export interface SlackStepOutputConfig {
  /** Which action result becomes the workflow step output. Defaults to "data". */
  mode?: SlackStepOutputMode;
  /** Emit JSON for structured chaining or text for simple downstream interpolation. Defaults to "json". */
  format?: SlackStepOutputFormat;
  /** Select a nested field from the projected output, e.g. "ts" or "data.channel". */
  path?: string;
  /** Include adapter metadata such as runtime and timing in JSON output. Defaults false. */
  includeMetadata?: boolean;
  /** Pretty-print JSON output. Defaults false. */
  pretty?: boolean;
}

export interface SlackStepConfig {
  /** Unique step name within the workflow. */
  name: string;
  /** Dependencies in the Relay workflow DAG. */
  dependsOn?: string[];
  /** Slack action to execute. */
  action: 'postMessage' | 'askQuestion';
  /** Slack channel id or #channel-name reference. Falls back to SLACK_DEFAULT_CHANNEL when omitted. */
  channel?: string;
  /** Message text. Values may include workflow templates such as {{steps.plan.output.title}}. */
  text: string;
  /** Optional parent message timestamp for threaded delivery. */
  threadTs?: string;
  /** User mentions to prefix when resolved. Unresolved mentions are soft warnings in output. */
  mentions?: string[];
  /** Slack unfurl setting for links and media. */
  unfurl?: boolean;
  /** Blocking ask timeout in milliseconds. Only used by askQuestion. */
  waitTimeoutMs?: number;
  /** Poll delay in milliseconds while waiting for an answer. Only used by askQuestion. */
  pollIntervalMs?: number;
  /** Slack user IDs to ignore while waiting for an answer. */
  ignoreUserIds?: string[];
  /** Active workflow agent name to inject the answer into after askQuestion completes. */
  injectToAgent?: string;
  /** Optional text template for injection. Use {{answer.text}} and {{question.text}} placeholders. */
  injectTemplate?: string;
  /** Runtime settings for the local Slack Web API runtime. */
  config?: SlackRuntimeConfig;
  /** Controls the string captured as {{steps.<name>.output}}. */
  output?: SlackStepOutputConfig;
  /** Workflow step timeout in milliseconds. */
  timeoutMs?: number;
  /** Number of retry attempts when the workflow runner retries this integration step. */
  retries?: number;
}

export interface SlackStepExecutionContext {
  workspaceId?: string;
  client?: SlackClient;
  config?: SlackRuntimeConfig;
  injectAnswerToAgent?: (input: {
    agentName: string;
    text: string;
    stepName: string;
    source: 'slack';
  }) => Promise<void>;
}

export interface SlackStepExecutionResult<TOutput = unknown> {
  success: boolean;
  output: string;
  result: SlackActionResult<TOutput>;
  error?: string;
}

export interface SlackIntegrationStepResult {
  output: string;
  success: boolean;
}

type ResolvedParams = Record<string, unknown>;

const SLACK_INTEGRATION = 'slack';
const SLACK_POST_MESSAGE_ACTION = 'postMessage';
const SLACK_ASK_QUESTION_ACTION = 'askQuestion';
const RESERVED_PARAM_KEYS = new Set(['action', 'config', 'slackConfig', 'output', 'params']);
const SUPPORTED_SLACK_STEP_ACTIONS = new Set<string>([
  SLACK_POST_MESSAGE_ACTION,
  SLACK_ASK_QUESTION_ACTION,
]);

/**
 * Create a Relay integration step for posting a Slack message.
 * @param config - Slack step configuration.
 * @returns Workflow integration step.
 */
export function createSlackStep(config: SlackStepConfig): WorkflowStep {
  validateSlackStepConfig(config);

  const params: Record<string, string> = {
    text: config.text,
  };

  if (config.channel !== undefined) params.channel = config.channel;
  if (config.threadTs !== undefined) params.threadTs = config.threadTs;
  if (config.mentions !== undefined) params.mentions = JSON.stringify(config.mentions);
  if (config.unfurl !== undefined) params.unfurl = String(config.unfurl);
  if (config.waitTimeoutMs !== undefined) params.waitTimeoutMs = String(config.waitTimeoutMs);
  if (config.pollIntervalMs !== undefined) params.pollIntervalMs = String(config.pollIntervalMs);
  if (config.ignoreUserIds !== undefined) params.ignoreUserIds = JSON.stringify(config.ignoreUserIds);
  if (config.injectToAgent !== undefined) params.injectToAgent = config.injectToAgent;
  if (config.injectTemplate !== undefined) params.injectTemplate = config.injectTemplate;
  if (config.config !== undefined) params.config = JSON.stringify(config.config);
  if (config.output !== undefined) params.output = JSON.stringify(config.output);

  const step: WorkflowStep = {
    name: config.name,
    type: 'integration',
    integration: SLACK_INTEGRATION,
    action: config.action,
    params,
  };

  if (config.dependsOn !== undefined) step.dependsOn = config.dependsOn;
  if (config.timeoutMs !== undefined) step.timeoutMs = config.timeoutMs;
  if (config.retries !== undefined) step.retries = config.retries;

  return step;
}

export class SlackStepExecutor implements RunnerStepExecutor {
  constructor(private readonly options: SlackRuntimeConfig = {}) {}

  async executeAgentStep(): Promise<string> {
    throw new Error('SlackStepExecutor only executes Slack integration steps.');
  }

  async execute<TOutput = unknown>(
    config: SlackStepConfig,
    context: SlackStepExecutionContext = {}
  ): Promise<SlackStepExecutionResult<TOutput>> {
    validateSlackStepConfig(config);

    const runtimeConfig = mergeRuntimeConfig(this.options, context.config, config.config);
    const client = context.client ?? new SlackClient(runtimeConfig);
    const params = buildActionParams(config);
    const result = (await client.executeAction<TOutput>(
      config.action as Parameters<SlackClient['executeAction']>[0],
      params
    )) as SlackActionResult<TOutput>;

    if (result.success && config.action === SLACK_ASK_QUESTION_ACTION && config.injectToAgent) {
      if (!context.injectAnswerToAgent) {
        throw new Error('Slack askQuestion injectToAgent requires a workflow runner injection context');
      }
      await context.injectAnswerToAgent({
        agentName: config.injectToAgent,
        text: formatAnswerInjection(config, result.data),
        stepName: config.name,
        source: 'slack',
      });
    }

    const output = formatStepOutput(config, result);

    return {
      success: result.success,
      output,
      result,
      error: result.error,
    };
  }

  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: SlackStepExecutionContext = {}
  ): Promise<SlackIntegrationStepResult> {
    if (step.integration !== SLACK_INTEGRATION) {
      return {
        success: false,
        output: `SlackStepExecutor only handles "${SLACK_INTEGRATION}" integration steps`,
      };
    }

    try {
      const config = slackStepConfigFromWorkflowStep(step, resolvedParams);
      const result = await this.execute(config, context);

      return {
        success: result.success,
        output: result.success ? result.output : result.output || result.error || 'Slack step failed',
      };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Rebuild a Slack step config from resolved workflow params.
 * @param step - Workflow step.
 * @param resolvedParams - Params after workflow templating.
 * @returns Slack step configuration.
 */
export function slackStepConfigFromWorkflowStep(
  step: WorkflowStep,
  resolvedParams: Record<string, string>
): SlackStepConfig {
  const params = normalizeResolvedParams(resolvedParams);
  const action = step.action;

  if (action !== SLACK_POST_MESSAGE_ACTION && action !== SLACK_ASK_QUESTION_ACTION) {
    throw new Error(`Slack step "${step.name}" requires action "postMessage" or "askQuestion"`);
  }

  const config =
    readJsonParam<SlackRuntimeConfig>(params.config ?? params.slackConfig, 'config') ?? undefined;
  const output = readJsonParam<SlackStepOutputConfig>(params.output, 'output') ?? undefined;
  const actionParams = readActionParams(params);

  return {
    name: step.name,
    dependsOn: step.dependsOn,
    action,
    channel: readOptionalString(actionParams.channel),
    text: readRequiredString(actionParams.text, 'text'),
    threadTs: readOptionalString(actionParams.threadTs),
    mentions: readStringArray(actionParams.mentions),
    unfurl: readOptionalBoolean(actionParams.unfurl, 'unfurl'),
    waitTimeoutMs: readOptionalNumber(
      actionParams.waitTimeoutMs ?? actionParams.timeoutMs,
      'waitTimeoutMs'
    ),
    pollIntervalMs: readOptionalNumber(actionParams.pollIntervalMs, 'pollIntervalMs'),
    ignoreUserIds: readStringArray(actionParams.ignoreUserIds),
    injectToAgent: readOptionalString(actionParams.injectToAgent),
    injectTemplate: readOptionalString(actionParams.injectTemplate),
    config,
    output,
    timeoutMs: step.timeoutMs,
    retries: step.retries,
  };
}

export function renderSlackTemplates(value: string, data: Record<string, unknown>): string {
  return value.replace(
    /\{\{\s*steps\.([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_.-]+))?\s*\}\}/g,
    (_match, step, path) => {
      const stepData = data.steps;
      if (!isRecord(stepData)) return '';
      const entry = stepData[String(step)];
      if (!isRecord(entry)) return '';
      const output = entry.output;
      const resolved = typeof path === 'string' && path.length > 0 ? resolvePath(output, path) : output;
      return projectionToText(resolved);
    }
  );
}

function validateSlackStepConfig(config: SlackStepConfig): void {
  if (!config.name) {
    throw new Error('Slack step requires a non-empty name');
  }
  if (!SUPPORTED_SLACK_STEP_ACTIONS.has(config.action)) {
    throw new Error(`Slack step "${config.name}" uses unsupported action "${config.action}"`);
  }
  if (config.action !== SLACK_POST_MESSAGE_ACTION && config.action !== SLACK_ASK_QUESTION_ACTION) {
    throw new Error(`Slack step "${config.name}" requires action "postMessage" or "askQuestion"`);
  }
  if (typeof config.text !== 'string' || config.text.length === 0) {
    throw new Error(`Slack step "${config.name}" requires message text`);
  }
}

function buildActionParams(config: SlackStepConfig): PostMessageParams | AskQuestionParams {
  const params: PostMessageParams | AskQuestionParams = {
    channel: config.channel,
    text: config.text,
    threadTs: config.threadTs,
    mentions: config.mentions,
    unfurl: config.unfurl,
  };

  if (config.action === SLACK_ASK_QUESTION_ACTION) {
    return {
      ...params,
      timeoutMs: config.waitTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      ignoreUserIds: config.ignoreUserIds,
    };
  }

  return params;
}

function formatAnswerInjection(config: SlackStepConfig, data: unknown): string {
  const answerText = readNestedString(data, ['answer', 'text']) ?? projectionToText(data);
  const questionText = readNestedString(data, ['question', 'text']) ?? config.text;
  const template = config.injectTemplate ?? 'HUMAN_ANSWER: {{answer.text}}';
  return template
    .replace(/\{\{\s*answer\.text\s*\}\}/g, () => answerText)
    .replace(/\{\{\s*question\.text\s*\}\}/g, () => questionText);
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function readActionParams(params: ResolvedParams): Record<string, unknown> {
  const serializedParams = params.params;
  if (serializedParams !== undefined) {
    const parsed = readJsonParam<Record<string, unknown>>(serializedParams, 'params');
    if (parsed === undefined) return {};
    if (!isRecord(parsed)) {
      throw new Error('Slack step params.params must be a JSON object');
    }
    return parsed;
  }

  const actionParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAM_KEYS.has(key)) continue;
    actionParams[key] = value;
  }

  return actionParams;
}

function mergeRuntimeConfig(...configs: Array<SlackRuntimeConfig | undefined>): SlackRuntimeConfig {
  const merged: SlackRuntimeConfig = {};

  for (const config of configs) {
    if (!config) continue;
    const { env, ...flatConfig } = config;
    Object.assign(merged, flatConfig);
    if (env) {
      merged.env = {
        ...merged.env,
        ...env,
      };
    }
  }

  return merged;
}

function formatStepOutput<TOutput>(config: SlackStepConfig, result: SlackActionResult<TOutput>): string {
  const outputConfig = config.output ?? {};
  const mode = outputConfig.mode ?? 'data';
  const format = outputConfig.format ?? 'json';

  if (mode === 'none') {
    return '';
  }

  let projection = buildOutputProjection(mode, result, outputConfig);

  if (outputConfig.path) {
    projection = resolvePath(projection, outputConfig.path);
  }

  if (format === 'text') {
    return projectionToText(projection);
  }

  return JSON.stringify(projection, undefined, outputConfig.pretty ? 2 : undefined);
}

function buildOutputProjection<TOutput>(
  mode: SlackStepOutputMode,
  result: SlackActionResult<TOutput>,
  outputConfig: SlackStepOutputConfig
): unknown {
  if (mode === 'raw') return result.output;
  if (mode === 'summary') {
    return withOptionalMetadata(summarizeResult(result), result, outputConfig);
  }
  if (mode === 'result') {
    const projected: Record<string, unknown> = {
      success: result.success,
      output: result.output,
    };
    if (result.data !== undefined) projected.data = result.data;
    if (result.error !== undefined) projected.error = result.error;
    return withOptionalMetadata(projected, result, outputConfig);
  }

  return withOptionalMetadata(
    result.data ?? (result.output ? result.output : (result.error ?? null)),
    result,
    outputConfig
  );
}

function summarizeResult<TOutput>(result: SlackActionResult<TOutput>): Record<string, unknown> {
  if (!result.success) {
    return {
      success: false,
      error: result.error ?? 'Slack action failed',
    };
  }

  if (isRecord(result.data)) {
    return {
      success: true,
      channel: result.data.channel,
      ts: result.data.ts,
      unresolvedMentions: result.data.unresolvedMentions,
    };
  }

  return {
    success: true,
    value: result.data ?? result.output,
  };
}

function withOptionalMetadata<TOutput>(
  value: unknown,
  result: SlackActionResult<TOutput>,
  outputConfig: SlackStepOutputConfig
): unknown {
  if (!outputConfig.includeMetadata || result.metadata === undefined) {
    return value;
  }

  return {
    value,
    metadata: result.metadata,
  };
}

function projectionToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((entry) => projectionToText(entry)).join('\n');
  if (isRecord(value)) {
    if ('output' in value) return projectionToText(value.output);
    if ('value' in value) return projectionToText(value.value);
    if ('text' in value) return projectionToText(value.text);
    if ('ts' in value) return projectionToText(value.ts);
    if ('channel' in value) return projectionToText(value.channel);
  }
  return JSON.stringify(value);
}

function resolvePath(value: unknown, path: string): unknown {
  if (!path) return value;

  let current = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (isRecord(current)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }

  return current;
}

function normalizeResolvedParams(params: Record<string, string>): ResolvedParams {
  const normalized: ResolvedParams = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[key] = coerceScalar(value);
  }
  return normalized;
}

function coerceScalar(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  return value;
}

function readJsonParam<T>(value: unknown, name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value as T;

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(
      `Slack step params.${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Slack step requires ${name}`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new Error('Slack step mentions must be a string array');
}

function readOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Slack step ${name} must be a boolean`);
}

function readOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Slack step ${name} must be a number`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
