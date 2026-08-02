/**
 * WorkflowRunner — parses relay.yaml, validates config, resolves templates,
 * executes steps (sequential/parallel/DAG), runs verification checks,
 * persists state to DB, and supports pause/resume/abort with retries.
 */

import { spawn as cpSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import type { Dirent, WriteStream } from 'node:fs';
import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import ignore from 'ignore';

import { parse as parseYaml } from 'yaml';
import stripAnsiFn from 'strip-ansi';
import type { BrokerEvent } from '@agent-relay/harness-driver';
import { resolveSpawnPolicy } from './cli-registry.js';
import { getCliDefinition } from './cli-registry.js';
import { resolveCliSync } from './cli-registry.js';
import {
  buildNormalizedProxyEnv,
  getStrippedApiKeyVars,
  resolveProxyEnv,
  resolveProxyTokenFromEnv,
  resolveProxyUrlFromEnv,
} from './proxy-env.js';

import {
  loadCustomSteps,
  resolveAllCustomSteps,
  validateCustomStepsUsage,
  CustomStepsParseError,
  CustomStepResolutionError,
} from './custom-steps.js';
import { provisionWorkflowAgents } from './provisioner.js';
import {
  authorizedApiFetch,
  createLocalJwksKeyPair,
  importPrivateKeyPem,
  readStoredAuth,
  RELAYAUTH_JWT_KID_ENV,
  RELAYAUTH_JWT_PRIVATE_KEY_PEM_ENV,
  resolveAgentPermissions,
  type LocalJwksSigningKey,
  type StoredAuth,
} from '@agent-relay/cloud';
import { ensureRelayfileMount, type MountHandle } from '@relayfile/sdk/workspace-mount';
import { collectCliSession, type CliSessionReport } from './cli-session-collector.js';
import { executeApiStep } from './api-executor.js';
import { BudgetExceededError, BudgetTracker } from './budget-tracker.js';
import {
  ChannelMessenger,
  formatObserverGuidance,
  scrubForChannel as scrubWorkflowOutputForChannel,
} from './channel-messenger.js';
import { InMemoryWorkflowDb } from './memory-db.js';
import { buildCommand as buildProcessCommand, spawnProcess } from './process-spawner.js';
import { createProcessBackendExecutor } from './process-backend-executor.js';
import { formatRunSummaryTable } from './run-summary-table.js';
import {
  StepExecutor as WorkflowStepLifecycleExecutor,
  type StepExecutorDeps as WorkflowStepLifecycleExecutorDeps,
} from './step-executor.js';
import {
  interpolateStepTask as interpolateStepTaskTemplate,
  resolveDotPath as resolveTemplateDotPath,
  resolveTemplate,
  TemplateResolver,
  type VariableContext,
} from './template-resolver.js';
import type {
  AccessPreset,
  AgentCli,
  AgentDefinition,
  AgentPermissions,
  AgentPreset,
  CompletionEvidenceChannelOrigin,
  CompletionEvidenceChannelPost,
  CompletionEvidenceFileChange,
  CompletionEvidenceSignal,
  CompletionEvidenceSignalKind,
  CompletionEvidenceToolSideEffect,
  DryRunReport,
  DryRunWave,
  ErrorHandlingConfig,
  IdleNudgeConfig,
  HumanAssistanceConfig,
  PathDefinition,
  PermissionProfileDefinition,
  PreflightCheck,
  RelayYamlConfig,
  StepCompletionDecision,
  StepCompletionEvidence,
  SwarmPattern,
  VerificationCheck,
  WorkflowDefinition,
  WorkflowOwnerDecision,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowExecuteOptions,
  WorkflowStepCompletionReason,
  WorkflowStepRow,
  WorkflowStepStatus,
  ProcessBackend,
  RunnerStepExecutor,
} from './types.js';
import { WorkflowTrajectory, type StepOutcome } from './trajectory.js';
import {
  runVerification,
  stripInjectedTaskEcho,
  type VerificationOptions,
  type VerificationResult,
  WorkflowCompletionError,
} from './verification.js';

// ── Broker client / messaging imports ───────────────────────────────────────

// Broker / PTY / lifecycle is driven by the harness-driver client; messaging
// uses @relaycast/sdk (below).
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import type { RuntimeSpawnOptions, SpawnPtyInput } from '@agent-relay/harness-driver';
import { WorkflowAgentHandle } from './agent-handle.js';
import { RelayCast, RelayError, type AgentClient } from '@relaycast/sdk';
import { SlackClient } from '@relayflows/slack-primitive';
import { RelayfileSetup, RelayFileClient, type ChangeEvent, type FilesystemEvent, type Subscription } from '@relayfile/sdk';

// ── Environment filtering ──────────────────────────────────────────────────

/** Keys explicitly allowed to propagate to spawned child processes. */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TZ',
  'NODE_ENV',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'RUST_LOG',
  'RUST_BACKTRACE',
  'RELAY_API_KEY',
  'RELAYCAST_BASE_URL',
  'RELAY_LLM_PROXY',
  'RELAY_LLM_PROXY_URL',
  'CREDENTIAL_PROXY_TOKEN',
  'RELAY_LLM_PROXY_TOKEN',
  'AGENT_RELAY_DASHBOARD_PORT',
  'AGENT_RELAY_RUN_ID_FILE',
  'EDITOR',
  'VISUAL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
]);

type ProxyProvider = 'openai' | 'anthropic' | 'openrouter';

interface ProxyModeConfig {
  token: string;
  url: string;
}

interface ProxyTokenClaims {
  sub: string;
  aud: 'relay-llm-proxy';
  provider: ProxyProvider;
  credentialId: string;
  budget?: number;
  exp?: number;
}

interface CredentialProxyModule {
  mintProxyToken: (claims: ProxyTokenClaims, secret: string) => Promise<string>;
}

/** Return a filtered copy of process.env containing only allowlisted keys. */
function filteredEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

// ── Shared broker coordination ──────────────────────────────────────────────

const BROKER_CONNECTION_FILENAME = 'connection.json';
const SHARED_BROKER_LOCK_DIRNAME = '.relayflows-start.lock';
const SHARED_BROKER_LEASE_DIRNAME = 'relayflows-runs';
const SHARED_BROKER_OWNER_FILENAME = 'relayflows-owner.json';
const SHARED_BROKER_LOCK_POLL_MS = 200;
const SHARED_BROKER_DEFAULT_STARTUP_TIMEOUT_MS = 45_000;

interface BrokerConnectionFile {
  url: string;
  api_key: string;
  pid: number;
  port?: number;
}

interface SharedBrokerLease {
  stateDir: string;
  connectionPath: string;
  ownerPath: string;
  leasePath: string;
  startedBroker: boolean;
}

function parseBrokerConnectionFile(raw: string): BrokerConnectionFile | null {
  try {
    const conn = JSON.parse(raw);
    if (
      typeof conn.url === 'string' &&
      typeof conn.api_key === 'string' &&
      typeof conn.pid === 'number' &&
      conn.pid > 0
    ) {
      return conn as BrokerConnectionFile;
    }
  } catch {
    // Invalid JSON is handled as no reusable broker.
  }
  return null;
}

function readBrokerConnectionFile(connectionPath: string): BrokerConnectionFile | null {
  try {
    return parseBrokerConnectionFile(readFileSync(connectionPath, 'utf-8'));
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeUnlinkSync(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Best-effort cleanup.
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── DB adapter interface ────────────────────────────────────────────────────

/** Minimal DB adapter so the runner is not coupled to a specific driver. */
export interface WorkflowDb {
  insertRun(run: WorkflowRunRow): Promise<void>;
  updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRow | null>;

  insertStep(step: WorkflowStepRow): Promise<void>;
  updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void>;
  getStepsByRunId(runId: string): Promise<WorkflowStepRow[]>;
}

/** Result returned by spawnAndWait / execNonInteractive with optional process exit info. */
interface SpawnResult {
  output: string;
  exitCode?: number;
  exitSignal?: string;
  promptTaskText?: string;
}

/** Error carrying exit code/signal from a failed subprocess spawn. */
class SpawnExitError extends Error {
  exitCode?: number;
  exitSignal?: string;
  constructor(message: string, exitCode?: number, exitSignal?: string | null) {
    super(message);
    this.name = 'SpawnExitError';
    this.exitCode = exitCode;
    this.exitSignal = exitSignal ?? undefined;
  }
}

interface CompletionDecisionResult {
  completionReason: WorkflowStepCompletionReason;
  ownerDecision?: WorkflowOwnerDecision;
  reason?: string;
}

// ── Events ──────────────────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: 'run:started'; runId: string }
  | { type: 'run:completed'; runId: string }
  | { type: 'run:failed'; runId: string; error: string }
  | { type: 'run:needs-human'; runId: string; error: string; stepName: string }
  | { type: 'run:cancelled'; runId: string }
  | { type: 'broker:event'; runId: string; event: BrokerEvent }
  | { type: 'step:started'; runId: string; stepName: string }
  | {
      type: 'step:owner-assigned';
      runId: string;
      stepName: string;
      ownerName: string;
      specialistName: string;
    }
  | {
      type: 'step:completed';
      runId: string;
      stepName: string;
      output?: string;
      exitCode?: number;
      exitSignal?: string;
    }
  | {
      type: 'step:review-completed';
      runId: string;
      stepName: string;
      reviewerName: string;
      decision: 'approved' | 'rejected';
    }
  | { type: 'step:owner-timeout'; runId: string; stepName: string; ownerName: string }
  | { type: 'step:agent-report'; runId: string; stepName: string; report: CliSessionReport }
  | {
      type: 'step:failed';
      runId: string;
      stepName: string;
      error: string;
      exitCode?: number;
      exitSignal?: string;
    }
  | { type: 'step:skipped'; runId: string; stepName: string }
  | { type: 'step:retrying'; runId: string; stepName: string; attempt: number }
  | { type: 'step:nudged'; runId: string; stepName: string; nudgeCount: number }
  | { type: 'step:force-released'; runId: string; stepName: string };

export type WorkflowEventListener = (event: WorkflowEvent) => void;

// ── Runner options ──────────────────────────────────────────────────────────

export interface WorkflowRunnerOptions {
  db?: WorkflowDb;
  workspaceId?: string;
  relay?: RuntimeSpawnOptions;
  cwd?: string;
  summaryDir?: string;
  executor?: RunnerStepExecutor;
  envSecrets?: Record<string, string>;
  /**
   * Process backend for remote execution environments.
   * When set without an explicit executor, the runner wraps it in a
   * RunnerStepExecutor that creates isolated environments for agent and
   * deterministic steps. The runner builds CLI commands and passes auth env,
   * cwd, and timeout; the backend provides create/exec/destroy primitives.
   *
   * When both executor and processBackend are set, executor takes precedence.
   * When neither is set, the broker spawns local child processes (default).
   */
  processBackend?: ProcessBackend;
}

// ── Internal step state ─────────────────────────────────────────────────────

interface StepState {
  row: WorkflowStepRow;
  agent?: WorkflowAgentHandle;
}

interface SupervisedStep {
  specialist: AgentDefinition;
  owner: AgentDefinition;
  reviewer?: AgentDefinition;
}

interface SpawnedAgentInfo {
  requestedName: string;
  actualName: string;
  agent: WorkflowAgentHandle;
}

interface SpawnAndWaitOptions {
  agentNameSuffix?: string;
  retryAttempt?: number;
  evidenceStepName?: string;
  evidenceRole?: string;
  logicalName?: string;
  preserveOnIdle?: boolean;
  onSpawned?: (info: SpawnedAgentInfo) => void | Promise<void>;
  onChunk?: (info: { agentName: string; chunk: string }) => void;
}

interface SupervisedRuntimeAgent {
  stepName: string;
  role: 'owner' | 'specialist';
  logicalName: string;
}

interface RuntimeStepAgent {
  stepName: string;
  role: string;
  logicalName: string;
}

interface RelayfileRuntimeConfig {
  baseUrl: string;
  workspaceId: string;
  token: string;
  source?: 'config' | 'local-creds';
}

interface ResolvedRelayfileSubscription {
  name: string;
  paths: string[];
  events?: string[];
  provider?: string;
  targetAgents?: string[];
  source: 'workflow' | 'agent';
  ownerAgent?: string;
}

interface NormalizedRelayfileEvent {
  eventId: string;
  type: string;
  path: string;
  revision?: string;
  provider?: string;
  timestamp?: string;
  resourceKind?: string;
  summary?: Record<string, unknown>;
  raw: ChangeEvent | FilesystemEvent;
}

interface RelayfileEventWaiter {
  name: string;
  subscription: ResolvedRelayfileSubscription;
  resolve: (event: NormalizedRelayfileEvent) => void;
}

interface FileSnapshotEntry {
  mtimeMs: number;
  size: number;
}

interface StepEvidenceRecord {
  evidence: StepCompletionEvidence;
  baselineSnapshots: Map<string, Map<string, FileSnapshotEntry>>;
  filesCaptured: boolean;
}

interface StepSignalParticipants {
  ownerSenders: Set<string>;
  workerSenders: Set<string>;
}

interface CustomVerificationFailure {
  command: string;
  output: string;
}

interface DiagnosticResult {
  analysis: string;
  metadata: {
    agentName: string;
    elapsedMs: number;
    tokenCount: number;
  };
}

interface DeterministicRepairContext {
  step: WorkflowStep;
  agentDef: AgentDefinition;
  attempt: number;
  maxRetries: number;
  command: string;
  cwd: string;
  error: string;
  output: string;
  exitCode?: number;
  exitSignal?: string;
}

interface AgentStepRepairContext {
  step: WorkflowStep;
  agentDef: AgentDefinition;
  attempt: number;
  maxRetries: number;
  cwd: string;
  error: string;
  output: string;
  exitCode?: number;
  exitSignal?: string;
  completionReason?: WorkflowStepCompletionReason;
}

type DiagnosticVerificationCheck = VerificationCheck & {
  diagnosticAgent?: string;
  diagnosticTimeout?: number;
};

const DEFAULT_WORKFLOW_MAX_RETRIES = 2;
const DEFAULT_WORKFLOW_REPAIR_RETRIES = 2;
const DEFAULT_WORKFLOW_RETRY_DELAY_MS = 1000;
const BROKER_OPERATION_MAX_ATTEMPTS = 3;
const BROKER_OPERATION_RETRY_DELAY_MS = 1_000;
const AGENT_TRANSIENT_NETWORK_MAX_ATTEMPTS = 3;
const AGENT_TRANSIENT_NETWORK_RETRY_DELAY_MS = 1_000;

interface ChannelEvidenceOptions {
  stepName?: string;
  sender?: string;
  actor?: string;
  role?: string;
  target?: string;
  origin?: CompletionEvidenceChannelOrigin;
}

interface BrokerRunContext {
  runId: string;
  brokerName: string;
  channel: string;
  relaycastDisabled: boolean;
}

// ── CLI resolution ───────────────────────────────────────────────────────────

/**
 * Resolve `cursor` to the concrete cursor agent binary available in PATH.
 * Delegates to the consolidated cli-resolver which checks PATH + well-known
 * install directories. Falls back to `agent` if nothing found.
 */
function resolveCursorCli(): 'cursor-agent' | 'agent' {
  const resolved = resolveCliSync('cursor');
  return (resolved?.binary as 'cursor-agent' | 'agent') ?? 'agent';
}

function resolveWorkflowTokenSigningKey(env: NodeJS.ProcessEnv): LocalJwksSigningKey {
  const privateKeyPem = env[RELAYAUTH_JWT_PRIVATE_KEY_PEM_ENV];
  const kid = env[RELAYAUTH_JWT_KID_ENV];
  if (privateKeyPem && kid) {
    return {
      privateKey: importPrivateKeyPem(privateKeyPem),
      kid,
    };
  }

  const generated = createLocalJwksKeyPair();
  return {
    privateKey: generated.privateKey,
    kid: generated.kid,
  };
}

// ── WorkflowRunner ──────────────────────────────────────────────────────────

export class WorkflowRunner {
  private readonly db: WorkflowDb;
  private readonly workspaceId: string;
  private readonly relayOptions: RuntimeSpawnOptions;
  private readonly cwd: string;
  private readonly summaryDir: string;
  private executor?: RunnerStepExecutor;
  private readonly envSecrets?: Record<string, string>;
  private readonly templateResolver: TemplateResolver;
  private readonly channelMessenger: ChannelMessenger;

  /** @internal exposed for CLI signal-handler shutdown only */
  relay?: HarnessDriverClient;
  private currentBrokerContext?: BrokerRunContext;
  private brokerRecoveryPromise?: Promise<void>;
  private relaycast?: RelayCast;
  private relaycastAgent?: AgentClient;
  private relayApiKey?: string;
  private relayApiKeyAutoCreated = false;
  private channel?: string;
  private trajectory?: WorkflowTrajectory;
  private abortController?: AbortController;
  private paused = false;
  private pauseResolver?: () => void;
  private listeners: WorkflowEventListener[] = [];

  /** Current config for the active run, so spawnAndWait can access swarm config. */
  private currentConfig?: RelayYamlConfig;
  /** Current run ID for event emission from spawnAndWait context. */
  private currentRunId?: string;
  /** Live Agent handles keyed by name, for hub-mediated nudging. */
  private readonly activeAgentHandles = new Map<string, WorkflowAgentHandle>();
  /** Pending Slack-backed human questions keyed by runtime agent name. */
  private readonly pendingHumanQuestions = new Map<string, Promise<void>>();
  /** Debounced Slack human-question drafts keyed by runtime agent name. */
  private readonly pendingHumanQuestionDrafts = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      agentName: string;
      step: WorkflowStep;
      config: HumanAssistanceConfig;
      question: string;
    }
  >();
  /** Dedupes repeated PTY renders of the same human question marker. */
  private readonly seenHumanQuestionKeys = new Map<string, Array<{ fingerprint: string; at: number }>>();
  /** Suppresses stale PTY re-renders of questions that already received a human answer. */
  private readonly answeredHumanQuestionKeys = new Map<string, Array<{ fingerprint: string; at: number }>>();
  private relayfileClient?: RelayFileClient;
  private relayfileRuntimeConfig?: RelayfileRuntimeConfig;
  private relayfileEventStream?: { ready: Promise<void>; unsubscribe: () => Promise<void> };
  private readonly relayfileEventSubscriptionHandles: Subscription[] = [];
  private readonly relayfileEventSubscriptions: ResolvedRelayfileSubscription[] = [];
  private readonly relayfileEventWaiters: RelayfileEventWaiter[] = [];
  private readonly seenRelayfileEventIds = new Set<string>();
  private relayfileIntegrationMount?: MountHandle;
  /** Per-agent workflow tokens for relay/relayfile auth across spawn modes. */
  private readonly agentTokens = new Map<string, string>();
  /** Per-agent credential proxy tokens keyed by logical agent definition name. */
  private readonly proxyTokens = new Map<string, string>();
  /** Per-agent relayfile mounts keyed by logical agent definition name. */
  private readonly agentMounts = new Map<string, MountHandle>();

  // PTY-based output capture: accumulate terminal output per-agent
  private readonly ptyOutputBuffers = new Map<string, string[]>();
  /** Snapshot of PTY output from the most recent failed attempt, keyed by step name. */
  private readonly lastFailedStepOutput = new Map<string, string>();
  /** Most recent custom verification failure details, keyed by step name. */
  private readonly lastCustomVerificationFailure = new Map<string, CustomVerificationFailure>();
  private readonly ptyListeners = new Map<string, (chunk: string) => void>();
  private readonly ptyLogStreams = new Map<string, WriteStream>();
  /** Path to workers.json so `agents:kill` can find workflow-spawned agents */
  private readonly workersPath: string;
  /** In-memory tracking of active workers to avoid race conditions on workers.json */
  private readonly activeWorkers = new Map<
    string,
    { cli: string; task: string; spawnedAt: number; pid?: number; logFile: string }
  >();
  /** Mutex for serializing workers.json file access */
  private workersFileLock: Promise<void> = Promise.resolve();
  /** Timestamp when the current workflow run started, for elapsed-time logging. */
  private runStartTime?: number;
  /** Unsubscribe handle for broker stderr listener wired during a run. */
  private unsubBrokerStderr?: () => void;
  private unsubRelayListeners: Array<() => void> = [];
  /** Local lease metadata for the shared workflow broker, when broker init was needed. */
  private sharedBrokerLease?: SharedBrokerLease;
  /** Tracks last idle log time per agent to debounce idle warnings (30s multiples). */
  private readonly lastIdleLog = new Map<string, number>();
  /** Tracks last logged activity type per agent to avoid duplicate status lines. */
  private readonly lastActivity = new Map<string, string>();
  /** Runtime-name lookup for agents participating in supervised owner flows. */
  private readonly supervisedRuntimeAgents = new Map<string, SupervisedRuntimeAgent>();
  /** Runtime-name lookup for active step agents so channel messages can be attributed to a step. */
  private readonly runtimeStepAgents = new Map<string, RuntimeStepAgent>();
  /** Per-step completion evidence collected across output, channel, files, and tool side-effects. */
  private readonly stepCompletionEvidence = new Map<string, StepEvidenceRecord>();
  /** Expected owner/worker identities per step so coordination signals can be validated by sender. */
  private readonly stepSignalParticipants = new Map<string, StepSignalParticipants>();
  /** Resolved named paths from the top-level `paths` config, keyed by name → absolute directory. */
  private resolvedPaths = new Map<string, string>();
  /** Tracks agent names currently assigned as reviewers (ref-counted to handle concurrent usage). */
  private readonly activeReviewers = new Map<string, number>();
  /** Structured CLI session reports captured during the current run, keyed by step name. */
  private readonly agentReports = new Map<string, CliSessionReport>();
  /** Optional per-run token budget tracker; only created when budgets are configured. */
  private budgetTracker?: BudgetTracker;
  private static readonly PTY_TASK_ARG_SIZE_LIMIT = 2 * 1024 * 1024; // 2 MB
  private readonly processBackend?: ProcessBackend;

  constructor(options: WorkflowRunnerOptions = {}) {
    this.db = options.db ?? new InMemoryWorkflowDb();
    this.workspaceId = options.workspaceId ?? 'local';
    this.relayOptions = options.relay ?? {};
    this.cwd = options.cwd ?? process.cwd();
    this.summaryDir = options.summaryDir ?? path.join(this.cwd, '.relay', 'summaries');
    this.workersPath = path.join(this.cwd, '.agent-relay', 'team', 'workers.json');
    this.executor = options.executor;
    this.processBackend = options.processBackend;
    this.envSecrets = options.envSecrets;
    if (!this.executor && this.processBackend) {
      this.executor = createProcessBackendExecutor(this.processBackend, {
        env: this.envSecrets,
      });
    }
    this.templateResolver = new TemplateResolver();
    this.channelMessenger = new ChannelMessenger({ postFn: (text) => this.postToChannel(text) });
  }

  // ── Path resolution ─────────────────────────────────────────────────────

  /** Expand environment variables like $HOME or $VAR in a path string. */
  private static resolveEnvVars(p: string): string {
    return p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => {
      return process.env[varName] ?? _match;
    });
  }

  /**
   * Resolve and validate the top-level `paths` definitions from the config.
   * Returns a map of name → absolute directory path.
   * Throws if a required path does not exist.
   */
  private resolvePathDefinitions(
    pathDefs: PathDefinition[] | undefined,
    baseCwd: string
  ): { resolved: Map<string, string>; errors: string[]; warnings: string[] } {
    const resolved = new Map<string, string>();
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!pathDefs || pathDefs.length === 0) return { resolved, errors, warnings };

    const seenNames = new Set<string>();
    for (const pd of pathDefs) {
      if (seenNames.has(pd.name)) {
        errors.push(`Duplicate path name "${pd.name}"`);
        continue;
      }
      seenNames.add(pd.name);

      const expanded = WorkflowRunner.resolveEnvVars(pd.path);
      const abs = path.resolve(baseCwd, expanded);
      resolved.set(pd.name, abs);

      const isRequired = pd.required !== false; // default true
      if (!existsSync(abs)) {
        if (isRequired) {
          errors.push(`Path "${pd.name}" resolves to "${abs}" which does not exist (required)`);
        } else {
          warnings.push(`Path "${pd.name}" resolves to "${abs}" which does not exist (optional)`);
        }
      }
    }

    return { resolved, errors, warnings };
  }

  private initializeBudgetTracker(config: RelayYamlConfig, workflow: WorkflowDefinition): void {
    const agentMap = new Map(
      config.agents.map((agent) => [agent.name, WorkflowRunner.resolveAgentDef(agent)])
    );
    const stepConfigs = workflow.steps.flatMap((step) => {
      if (
        step.type === 'deterministic' ||
        step.type === 'worktree' ||
        step.type === 'integration' ||
        !step.agent
      ) {
        return [];
      }

      const agentDef = agentMap.get(step.agent);
      return [
        {
          stepName: step.name,
          agentName: step.agent,
          maxTokens: agentDef?.constraints?.maxTokens,
        },
      ];
    });

    const hasWorkflowBudget = config.swarm.tokenBudget !== undefined;
    const hasAgentBudgets = stepConfigs.some((step) => step.maxTokens !== undefined);

    this.budgetTracker =
      hasWorkflowBudget || hasAgentBudgets
        ? new BudgetTracker({
            workflowBudget: config.swarm.tokenBudget,
            steps: stepConfigs,
          })
        : undefined;
  }

  private ensureBudgetAllowsSpawn(stepName: string, agentName: string): void {
    if (!this.budgetTracker) return;

    const budgetCheck = this.budgetTracker.checkCanSpawn(stepName);
    if (budgetCheck.allowed) return;

    const workflowBudget = this.budgetTracker.getRunSummaryBudgetData()?.workflow;
    const used = workflowBudget?.used.toLocaleString('en-US') ?? '0';
    const limit = workflowBudget?.limit?.toLocaleString('en-US') ?? '--';
    this.log(`[budget] Skipping step ${stepName} — workflow budget exhausted (used ${used} of ${limit})`);
    throw new BudgetExceededError(
      stepName,
      'workflow',
      workflowBudget?.limit ?? 0,
      workflowBudget?.used ?? 0
    );
  }

  private getTotalReportTokens(report: CliSessionReport): number | undefined {
    if (!report.tokens) return undefined;
    return report.tokens.input + report.tokens.output + report.tokens.cacheRead;
  }

  private validatePermissions(
    agents: AgentDefinition[] | undefined,
    permissionProfiles: RelayYamlConfig['permission_profiles'],
    source = '<config>'
  ): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const accessPresets = new Set<AccessPreset>(['readonly', 'readwrite', 'restricted', 'full']);
    const profiles = permissionProfiles ?? {};
    const profileNames = new Set(Object.keys(profiles));

    const validateStringArray = (value: unknown, label: string): string[] | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (!Array.isArray(value)) {
        errors.push(`${label} must be an array of strings`);
        return undefined;
      }

      const normalized: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string') {
          errors.push(`${label} must be an array of strings`);
          continue;
        }
        normalized.push(entry);
      }
      return normalized;
    };

    const validateGlobPattern = (pattern: string, label: string): void => {
      const trimmed = pattern.trim();
      if (trimmed === '') {
        errors.push(`${label} must not contain empty glob patterns`);
        return;
      }
      if (trimmed.includes('\0')) {
        errors.push(`${label} contains an invalid glob pattern "${pattern}" (NUL byte)`);
        return;
      }

      let escaped = false;
      let bracketDepth = 0;
      let braceDepth = 0;

      for (const ch of trimmed) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '[') {
          bracketDepth += 1;
          continue;
        }
        if (ch === ']' && bracketDepth > 0) {
          bracketDepth -= 1;
          continue;
        }
        if (ch === '{') {
          braceDepth += 1;
          continue;
        }
        if (ch === '}' && braceDepth > 0) {
          braceDepth -= 1;
        }
      }

      if (escaped) {
        errors.push(`${label} contains an invalid glob pattern "${pattern}" (dangling escape)`);
        return;
      }
      if (bracketDepth > 0) {
        errors.push(`${label} contains an invalid glob pattern "${pattern}" (unclosed character class)`);
        return;
      }
      if (braceDepth > 0) {
        errors.push(`${label} contains an invalid glob pattern "${pattern}" (unclosed brace expansion)`);
        return;
      }

      try {
        ignore().add([trimmed]);
      } catch (err) {
        errors.push(
          `${label} contains an invalid glob pattern "${pattern}" (${err instanceof Error ? err.message : String(err)})`
        );
      }
    };

    const validatePermissionObject = (
      permissions: unknown,
      label: string,
      options: { allowProfileReference: boolean }
    ): void => {
      if (typeof permissions === 'string') {
        const shorthand = permissions.trim();
        if (shorthand === '') {
          errors.push(`${label} must not be empty`);
          return;
        }

        if (accessPresets.has(shorthand as AccessPreset)) {
          return;
        }

        if (options.allowProfileReference) {
          if (!profileNames.has(shorthand)) {
            errors.push(`${label} references unknown permission profile "${shorthand}"`);
          }
          return;
        }

        errors.push(`${label} must be an object when provided`);
        return;
      }

      if (typeof permissions !== 'object' || permissions === null) {
        errors.push(`${label} must be an object when provided`);
        return;
      }

      const permissionRecord = permissions as Record<string, unknown>;

      if (permissionRecord.description !== undefined && typeof permissionRecord.description !== 'string') {
        errors.push(`${label}.description must be a string when provided`);
      }

      if (permissionRecord.profile !== undefined) {
        if (!options.allowProfileReference) {
          errors.push(`${label}.profile is only supported on agent permissions`);
        } else if (typeof permissionRecord.profile !== 'string') {
          errors.push(`${label}.profile must be a string when provided`);
        } else if (permissionRecord.profile.trim() === '') {
          errors.push(`${label}.profile must not be empty`);
        } else if (!profileNames.has(permissionRecord.profile)) {
          errors.push(`${label}.profile references unknown permission profile "${permissionRecord.profile}"`);
        }
      }

      if (permissionRecord.why !== undefined && typeof permissionRecord.why !== 'string') {
        errors.push(`${label}.why must be a string when provided`);
      }

      if (
        permissionRecord.access !== undefined &&
        !accessPresets.has(permissionRecord.access as AccessPreset)
      ) {
        errors.push(`${label}.access must be one of readonly, readwrite, restricted, full`);
      }

      if (permissionRecord.inherit !== undefined && typeof permissionRecord.inherit !== 'boolean') {
        errors.push(`${label}.inherit must be a boolean when provided`);
      }

      if (permissionRecord.network !== undefined) {
        if (typeof permissionRecord.network === 'boolean') {
          // valid: boolean form
        } else if (
          typeof permissionRecord.network === 'object' &&
          permissionRecord.network !== null &&
          !Array.isArray(permissionRecord.network)
        ) {
          const net = permissionRecord.network as Record<string, unknown>;
          validateStringArray(net.allow, `${label}.network.allow`);
          validateStringArray(net.deny, `${label}.network.deny`);
        } else {
          errors.push(`${label}.network must be a boolean or an object with allow/deny arrays`);
        }
      }

      if (permissionRecord.files !== undefined) {
        if (
          typeof permissionRecord.files !== 'object' ||
          permissionRecord.files === null ||
          Array.isArray(permissionRecord.files)
        ) {
          errors.push(`${label}.files must be an object when provided`);
        } else {
          const files = permissionRecord.files as Record<string, unknown>;
          const read = validateStringArray(files.read, `${label}.files.read`);
          const write = validateStringArray(files.write, `${label}.files.write`);
          const deny = validateStringArray(files.deny, `${label}.files.deny`);

          for (const pattern of read ?? []) {
            validateGlobPattern(pattern, `${label}.files.read`);
          }
          for (const pattern of write ?? []) {
            validateGlobPattern(pattern, `${label}.files.write`);
          }
          for (const pattern of deny ?? []) {
            validateGlobPattern(pattern, `${label}.files.deny`);
          }

          if (permissionRecord.access === 'readonly' && (write?.length ?? 0) > 0) {
            warnings.push(`${label} sets access to "readonly" but also defines files.write entries`);
          }
        }
      }

      const scopes = validateStringArray(permissionRecord.scopes, `${label}.scopes`);
      for (const scope of scopes ?? []) {
        if (scope.trim() === '') {
          errors.push(`${label}.scopes must not contain empty strings`);
          continue;
        }
        if (!/^[^:\s]+:[^:\s]+:[^:\s]+:.+$/u.test(scope)) {
          errors.push(`${label}.scopes entry "${scope}" must follow plane:resource:action:path format`);
        }
      }

      const exec = validateStringArray(permissionRecord.exec, `${label}.exec`);
      for (const entry of exec ?? []) {
        if (entry.trim() === '') {
          errors.push(`${label}.exec must not contain empty strings`);
        }
      }
    };

    if (permissionProfiles !== undefined) {
      if (
        typeof permissionProfiles !== 'object' ||
        permissionProfiles === null ||
        Array.isArray(permissionProfiles)
      ) {
        errors.push(`${source}: permission_profiles must be an object when provided`);
      } else {
        for (const [profileName, profile] of Object.entries(permissionProfiles)) {
          if (profileName.trim() === '') {
            errors.push(`${source}: permission_profiles keys must not be empty`);
            continue;
          }
          validatePermissionObject(profile, `${source}: permission_profiles.${profileName}`, {
            allowProfileReference: false,
          });
        }
      }
    }

    if (!agents || agents.length === 0) {
      return { errors, warnings };
    }

    for (const agent of agents) {
      if (agent.permissions === undefined) {
        continue;
      }
      validatePermissionObject(agent.permissions, `${source}: agent "${agent.name}" permissions`, {
        allowProfileReference: true,
      });
    }

    return { errors, warnings };
  }

  private mergePermissionLists(
    base: readonly string[] | undefined,
    override: readonly string[] | undefined
  ): string[] | undefined {
    const merged = [
      ...new Set([...(base ?? []), ...(override ?? [])].map((value) => value.trim()).filter(Boolean)),
    ];
    return merged.length > 0 ? merged : undefined;
  }

  private mergePermissionFiles(
    base: AgentPermissions['files'],
    override: AgentPermissions['files']
  ): AgentPermissions['files'] {
    const merged = {
      read: this.mergePermissionLists(base?.read, override?.read),
      write: this.mergePermissionLists(base?.write, override?.write),
      deny: this.mergePermissionLists(base?.deny, override?.deny),
    };

    return merged.read || merged.write || merged.deny ? merged : undefined;
  }

  private mergePermissionProfile(
    profile: PermissionProfileDefinition,
    permissions: AgentPermissions
  ): AgentPermissions {
    const merged: AgentPermissions = {
      description: permissions.description ?? profile.description,
      profile: permissions.profile,
      why: permissions.why ?? profile.why,
      access: permissions.access ?? profile.access,
      inherit: permissions.inherit ?? profile.inherit,
      files: this.mergePermissionFiles(profile.files, permissions.files),
      scopes: this.mergePermissionLists(profile.scopes, permissions.scopes),
      network: permissions.network ?? profile.network,
      exec: this.mergePermissionLists(profile.exec, permissions.exec),
    };

    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined)
    ) as AgentPermissions;
  }

  private applyPermissionProfiles(config: RelayYamlConfig): RelayYamlConfig {
    if (!config.permission_profiles || Object.keys(config.permission_profiles).length === 0) {
      return config;
    }

    return {
      ...config,
      agents: config.agents.map((agent) => {
        const rawPermissions = agent.permissions;
        if (!rawPermissions) {
          return agent;
        }

        const normalizedPermissions =
          typeof rawPermissions === 'string'
            ? ({
                ...(config.permission_profiles?.[rawPermissions]
                  ? { profile: rawPermissions }
                  : { access: rawPermissions as AccessPreset }),
              } as AgentPermissions)
            : rawPermissions;

        const profileName = normalizedPermissions.profile;
        if (!profileName) {
          return {
            ...agent,
            permissions: normalizedPermissions,
          };
        }

        const profile = config.permission_profiles?.[profileName];
        if (!profile) {
          return {
            ...agent,
            permissions: normalizedPermissions,
          };
        }

        return {
          ...agent,
          permissions: this.mergePermissionProfile(profile, normalizedPermissions),
        };
      }),
    };
  }

  /**
   * Resolve an agent's effective working directory, considering `workdir` (named path reference)
   * and `cwd` (explicit path). `workdir` takes precedence when both are set.
   */
  private resolveAgentCwd(agent: AgentDefinition): string {
    if (agent.workdir) {
      const resolved = this.resolvedPaths.get(agent.workdir);
      if (!resolved) {
        throw new Error(
          `Agent "${agent.name}" references workdir "${agent.workdir}" which is not defined in paths`
        );
      }
      return resolved;
    }
    if (agent.cwd) {
      return path.resolve(this.cwd, agent.cwd);
    }
    return this.cwd;
  }

  /**
   * Resolve a step's working directory from its `workdir` field (named path reference).
   * Returns undefined if no workdir is set.
   */
  private resolveStepWorkdir(step: WorkflowStep): string | undefined {
    if (!step.workdir) return undefined;
    const resolved = this.resolvedPaths.get(step.workdir);
    if (!resolved) {
      throw new Error(
        `Step "${step.name}" references workdir "${step.workdir}" which is not defined in paths`
      );
    }
    return resolved;
  }

  private resolveEffectiveCwd(step: WorkflowStep, agentDef?: AgentDefinition): string {
    if (step.cwd) {
      return path.resolve(this.cwd, step.cwd);
    }
    return this.resolveStepWorkdir(step) ?? (agentDef ? this.resolveAgentCwd(agentDef) : this.cwd);
  }

  private resolveMountedCwd(agentName: string, cwd: string): string {
    const mount = this.agentMounts.get(agentName);
    if (!mount) {
      return cwd;
    }

    const relative = path.relative(this.cwd, cwd);
    if (relative === '') {
      return mount.mountPoint;
    }
    if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
      return cwd;
    }
    return path.resolve(mount.mountPoint, relative);
  }

  private resolveExecutionCwd(step: WorkflowStep, agentDef?: AgentDefinition): string {
    const cwd = this.resolveEffectiveCwd(step, agentDef);
    if (!agentDef) {
      return cwd;
    }
    return this.resolveMountedCwd(agentDef.name, cwd);
  }

  private async stopProvisionedMounts(): Promise<void> {
    const handles = [...this.agentMounts.values()];
    this.agentMounts.clear();
    await Promise.all(handles.map((handle) => handle.stop().catch(() => undefined)));
  }

  private static readonly EVIDENCE_IGNORED_DIRS = new Set([
    '.git',
    '.agent-relay',
    '.trajectories',
    'node_modules',
  ]);

  public getStepCompletionEvidence(stepName: string): StepCompletionEvidence | undefined {
    const record = this.stepCompletionEvidence.get(stepName);
    if (!record) return undefined;

    const evidence = structuredClone(record.evidence);
    return this.filterStepEvidenceBySignalProvenance(stepName, evidence);
  }

  private getOrCreateStepEvidenceRecord(stepName: string): StepEvidenceRecord {
    const existing = this.stepCompletionEvidence.get(stepName);
    if (existing) return existing;

    const now = new Date().toISOString();
    const record: StepEvidenceRecord = {
      evidence: {
        stepName,
        lastUpdatedAt: now,
        roots: [],
        output: {
          stdout: '',
          stderr: '',
          combined: '',
        },
        channelPosts: [],
        files: [],
        process: {},
        toolSideEffects: [],
        coordinationSignals: [],
      },
      baselineSnapshots: new Map(),
      filesCaptured: false,
    };
    this.stepCompletionEvidence.set(stepName, record);
    return record;
  }

  private initializeStepSignalParticipants(
    stepName: string,
    ownerSender?: string,
    workerSender?: string
  ): void {
    this.stepSignalParticipants.set(stepName, {
      ownerSenders: new Set(),
      workerSenders: new Set(),
    });
    this.rememberStepSignalSender(stepName, 'owner', ownerSender);
    this.rememberStepSignalSender(stepName, 'worker', workerSender);
  }

  private rememberStepSignalSender(
    stepName: string,
    participant: 'owner' | 'worker',
    ...senders: Array<string | undefined>
  ): void {
    const participants = this.stepSignalParticipants.get(stepName) ?? {
      ownerSenders: new Set<string>(),
      workerSenders: new Set<string>(),
    };
    this.stepSignalParticipants.set(stepName, participants);

    const target = participant === 'owner' ? participants.ownerSenders : participants.workerSenders;
    for (const sender of senders) {
      const trimmed = sender?.trim();
      if (trimmed) target.add(trimmed);
    }
  }

  private resolveSignalParticipantKind(role?: string): 'owner' | 'worker' | undefined {
    const roleLC = role?.toLowerCase().trim();
    if (!roleLC) return undefined;
    if (/\b(owner|lead|supervisor)\b/.test(roleLC)) return 'owner';
    if (/\b(worker|specialist|engineer|implementer)\b/.test(roleLC)) return 'worker';
    return undefined;
  }

  private isSignalFromExpectedSender(stepName: string, signal: CompletionEvidenceSignal): boolean {
    const expectedParticipant =
      signal.kind === 'worker_done' ? 'worker' : signal.kind === 'lead_done' ? 'owner' : undefined;
    if (!expectedParticipant) return true;

    const participants = this.stepSignalParticipants.get(stepName);
    if (!participants) return true;

    const allowedSenders =
      expectedParticipant === 'owner' ? participants.ownerSenders : participants.workerSenders;
    if (allowedSenders.size === 0) return true;

    const sender = signal.sender ?? signal.actor;
    if (sender) {
      return allowedSenders.has(sender);
    }

    const observedParticipant = this.resolveSignalParticipantKind(signal.role);
    if (observedParticipant) {
      return observedParticipant === expectedParticipant;
    }

    return signal.source !== 'channel';
  }

  private filterStepEvidenceBySignalProvenance(
    stepName: string,
    evidence: StepCompletionEvidence
  ): StepCompletionEvidence {
    evidence.channelPosts = evidence.channelPosts.map((post) => {
      const signals = post.signals.filter((signal) => this.isSignalFromExpectedSender(stepName, signal));
      return {
        ...post,
        completionRelevant: signals.length > 0,
        signals,
      };
    });
    evidence.coordinationSignals = evidence.coordinationSignals.filter((signal) =>
      this.isSignalFromExpectedSender(stepName, signal)
    );
    return evidence;
  }

  private beginStepEvidence(stepName: string, roots: Array<string | undefined>, startedAt?: string): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const evidence = record.evidence;
    const now = startedAt ?? new Date().toISOString();

    evidence.startedAt ??= now;
    evidence.status = 'running';
    evidence.lastUpdatedAt = now;

    for (const root of this.uniqueEvidenceRoots(roots)) {
      if (!evidence.roots.includes(root)) {
        evidence.roots.push(root);
      }
      if (!record.baselineSnapshots.has(root)) {
        record.baselineSnapshots.set(root, this.captureFileSnapshot(root));
      }
    }
  }

  private captureStepTerminalEvidence(
    stepName: string,
    output: { stdout?: string; stderr?: string; combined?: string },
    process?: { exitCode?: number; exitSignal?: string },
    meta?: { sender?: string; actor?: string; role?: string }
  ): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const evidence = record.evidence;
    const observedAt = new Date().toISOString();

    const append = (current: string, next?: string): string => {
      if (!next) return current;
      return current ? `${current}\n${next}` : next;
    };

    if (output.stdout) {
      evidence.output.stdout = append(evidence.output.stdout, output.stdout);
      for (const signal of this.extractCompletionSignals(output.stdout, 'stdout', observedAt, meta)) {
        evidence.coordinationSignals.push(signal);
      }
    }
    if (output.stderr) {
      evidence.output.stderr = append(evidence.output.stderr, output.stderr);
      for (const signal of this.extractCompletionSignals(output.stderr, 'stderr', observedAt, meta)) {
        evidence.coordinationSignals.push(signal);
      }
    }

    const combinedOutput =
      output.combined ??
      [output.stdout, output.stderr].filter((value): value is string => Boolean(value)).join('\n');
    if (combinedOutput) {
      evidence.output.combined = append(evidence.output.combined, combinedOutput);
    }

    if (process) {
      if (process.exitCode !== undefined) {
        evidence.process.exitCode = process.exitCode;
        evidence.coordinationSignals.push({
          kind: 'process_exit',
          source: 'process',
          text: `Process exited with code ${process.exitCode}`,
          observedAt,
          value: String(process.exitCode),
        });
      }
      if (process.exitSignal !== undefined) {
        evidence.process.exitSignal = process.exitSignal;
      }
    }

    evidence.lastUpdatedAt = observedAt;
  }

  private finalizeStepEvidence(
    stepName: string,
    status: WorkflowStepStatus,
    completedAt?: string,
    completionReason?: WorkflowStepCompletionReason
  ): void {
    const record = this.stepCompletionEvidence.get(stepName);
    if (!record) return;

    const evidence = record.evidence;
    const observedAt = completedAt ?? new Date().toISOString();
    evidence.status = status;
    if (status !== 'running') {
      evidence.completedAt = observedAt;
    }
    evidence.lastUpdatedAt = observedAt;

    if (!record.filesCaptured) {
      const existing = new Set(evidence.files.map((file) => `${file.kind}:${file.path}`));
      for (const root of evidence.roots) {
        const before = record.baselineSnapshots.get(root) ?? new Map<string, FileSnapshotEntry>();
        const after = this.captureFileSnapshot(root);
        for (const change of this.diffFileSnapshots(before, after, root, observedAt)) {
          const key = `${change.kind}:${change.path}`;
          if (existing.has(key)) continue;
          existing.add(key);
          evidence.files.push(change);
        }
      }
      record.filesCaptured = true;
    }

    if (completionReason) {
      const decision = this.buildStepCompletionDecision(stepName, completionReason);
      if (decision) {
        void this.trajectory?.stepCompletionDecision(stepName, decision);
      }
    }
  }

  private recordStepToolSideEffect(
    stepName: string,
    effect: Omit<CompletionEvidenceToolSideEffect, 'observedAt'> & { observedAt?: string }
  ): void {
    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const observedAt = effect.observedAt ?? new Date().toISOString();
    record.evidence.toolSideEffects.push({
      ...effect,
      observedAt,
    });
    record.evidence.lastUpdatedAt = observedAt;
  }

  private recordChannelEvidence(text: string, options: ChannelEvidenceOptions = {}): void {
    const stepName =
      options.stepName ??
      this.inferStepNameFromChannelText(text) ??
      (options.actor ? this.runtimeStepAgents.get(options.actor)?.stepName : undefined);
    if (!stepName) return;

    const record = this.getOrCreateStepEvidenceRecord(stepName);
    const postedAt = new Date().toISOString();
    const sender = options.sender ?? options.actor;
    const signals = this.extractCompletionSignals(text, 'channel', postedAt, {
      sender,
      actor: options.actor,
      role: options.role,
    });

    const channelPost: CompletionEvidenceChannelPost = {
      stepName,
      text,
      postedAt,
      origin: options.origin ?? 'runner_post',
      completionRelevant: signals.length > 0,
      sender,
      actor: options.actor,
      role: options.role,
      target: options.target,
      signals,
    };

    record.evidence.channelPosts.push(channelPost);
    record.evidence.coordinationSignals.push(...signals);
    record.evidence.lastUpdatedAt = postedAt;
  }

  private extractCompletionSignals(
    text: string,
    source: CompletionEvidenceSignal['source'],
    observedAt: string,
    meta?: { sender?: string; actor?: string; role?: string }
  ): CompletionEvidenceSignal[] {
    const signals: CompletionEvidenceSignal[] = [];
    const seen = new Set<string>();
    const add = (kind: CompletionEvidenceSignalKind, signalText: string, value?: string): void => {
      const trimmed = signalText.trim().slice(0, 280);
      if (!trimmed) return;
      const key = `${kind}:${trimmed}:${value ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      signals.push({
        kind,
        source,
        text: trimmed,
        observedAt,
        sender: meta?.sender,
        actor: meta?.actor,
        role: meta?.role,
        value,
      });
    };

    for (const match of text.matchAll(/\bWORKER_DONE\b(?::\s*([^\n]+))?/gi)) {
      add('worker_done', match[0], match[1]?.trim());
    }
    for (const match of text.matchAll(/\bLEAD_DONE\b(?::\s*([^\n]+))?/gi)) {
      add('lead_done', match[0], match[1]?.trim());
    }
    for (const match of text.matchAll(/\bSTEP_COMPLETE:([A-Za-z0-9_.:-]+)/g)) {
      add('step_complete', match[0], match[1]);
    }
    for (const match of text.matchAll(
      /\bOWNER_DECISION:\s*(COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/gi
    )) {
      add('owner_decision', match[0], match[1].toUpperCase());
    }
    for (const match of text.matchAll(/\bREVIEW_DECISION:\s*(APPROVE|REJECT)\b/gi)) {
      add('review_decision', match[0], match[1].toUpperCase());
    }
    if (/\bverification gate observed\b|\bverification passed\b/i.test(text)) {
      add('verification_passed', this.firstMeaningfulLine(text) ?? text);
    }
    if (/\bverification failed\b/i.test(text)) {
      add('verification_failed', this.firstMeaningfulLine(text) ?? text);
    }
    if (
      /\b(summary|handoff|ready for review|ready for handoff|task complete|work complete|completed work|finished work)\b/i.test(
        text
      )
    ) {
      add('task_summary', this.firstMeaningfulLine(text) ?? text);
    }

    return signals;
  }

  private inferStepNameFromChannelText(text: string): string | undefined {
    const bracketMatch = text.match(/^\*\*\[([^\]]+)\]/);
    if (bracketMatch?.[1]) return bracketMatch[1];

    const markerMatch = text.match(/\bSTEP_COMPLETE:([A-Za-z0-9_.:-]+)/);
    if (markerMatch?.[1]) return markerMatch[1];

    return undefined;
  }

  private uniqueEvidenceRoots(roots: Array<string | undefined>): string[] {
    return [
      ...new Set(roots.filter((root): root is string => Boolean(root)).map((root) => path.resolve(root))),
    ];
  }

  private captureFileSnapshot(root: string): Map<string, FileSnapshotEntry> {
    const snapshot = new Map<string, FileSnapshotEntry>();
    if (!existsSync(root)) return snapshot;

    const visit = (currentPath: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory() && WorkflowRunner.EVIDENCE_IGNORED_DIRS.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }

        try {
          const stats = statSync(fullPath);
          if (!stats.isFile()) continue;
          snapshot.set(fullPath, { mtimeMs: stats.mtimeMs, size: stats.size });
        } catch {
          // Best-effort evidence collection only.
        }
      }
    };

    try {
      const stats = statSync(root);
      if (stats.isFile()) {
        snapshot.set(root, { mtimeMs: stats.mtimeMs, size: stats.size });
        return snapshot;
      }
    } catch {
      return snapshot;
    }

    visit(root);
    return snapshot;
  }

  private diffFileSnapshots(
    before: Map<string, FileSnapshotEntry>,
    after: Map<string, FileSnapshotEntry>,
    root: string,
    observedAt: string
  ): CompletionEvidenceFileChange[] {
    const allPaths = new Set([...before.keys(), ...after.keys()]);
    const changes: CompletionEvidenceFileChange[] = [];

    for (const filePath of allPaths) {
      const prior = before.get(filePath);
      const next = after.get(filePath);

      let kind: CompletionEvidenceFileChange['kind'] | undefined;
      if (!prior && next) {
        kind = 'created';
      } else if (prior && !next) {
        kind = 'deleted';
      } else if (prior && next && (prior.mtimeMs !== next.mtimeMs || prior.size !== next.size)) {
        kind = 'modified';
      }

      if (!kind) continue;

      changes.push({
        path: this.normalizeEvidencePath(filePath),
        kind,
        observedAt,
        root,
      });
    }

    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private normalizeEvidencePath(filePath: string): string {
    const relative = path.relative(this.cwd, filePath);
    if (!relative || relative === '') return path.basename(filePath);
    return relative.startsWith('..') ? filePath : relative;
  }

  private buildStepCompletionDecision(
    stepName: string,
    completionReason: WorkflowStepCompletionReason
  ): StepCompletionDecision | undefined {
    let reason: string | undefined;
    let mode: StepCompletionDecision['mode'];
    switch (completionReason) {
      case 'completed_verified':
        mode = 'verification';
        reason = 'Verification passed';
        break;
      case 'completed_by_evidence':
        mode = 'evidence';
        reason = 'Completion inferred from collected evidence';
        break;
      case 'completed_by_owner_decision': {
        const evidence = this.getStepCompletionEvidence(stepName);
        const markerObserved = evidence?.coordinationSignals.some(
          (signal) => signal.kind === 'step_complete'
        );
        mode = markerObserved ? 'marker' : 'owner_decision';
        reason = markerObserved ? 'Legacy STEP_COMPLETE marker observed' : 'Owner approved completion';
        break;
      }
      default:
        return undefined;
    }

    return {
      mode,
      reason,
      evidence: this.buildTrajectoryCompletionEvidence(stepName),
    };
  }

  private buildTrajectoryCompletionEvidence(
    stepName: string
  ): StepCompletionDecision['evidence'] | undefined {
    const evidence = this.getStepCompletionEvidence(stepName);
    if (!evidence) return undefined;

    const signals = evidence.coordinationSignals.slice(-6).map((signal) => signal.value ?? signal.text);
    const channelPosts = evidence.channelPosts
      .filter((post) => post.completionRelevant)
      .slice(-3)
      .map((post) => post.text.slice(0, 160));
    const files = evidence.files.slice(0, 6).map((file) => `${file.kind}:${file.path}`);

    const summaryParts: string[] = [];
    if (signals.length > 0) summaryParts.push(`${signals.length} signal(s)`);
    if (channelPosts.length > 0) summaryParts.push(`${channelPosts.length} relevant channel post(s)`);
    if (files.length > 0) summaryParts.push(`${files.length} file change(s)`);
    if (evidence.process.exitCode !== undefined) {
      summaryParts.push(`exit=${evidence.process.exitCode}`);
    }

    return {
      summary: summaryParts.length > 0 ? summaryParts.join(', ') : undefined,
      signals: signals.length > 0 ? signals : undefined,
      channelPosts: channelPosts.length > 0 ? channelPosts : undefined,
      files: files.length > 0 ? files : undefined,
      exitCode: evidence.process.exitCode,
    };
  }

  // ── Progress logging ────────────────────────────────────────────────────

  /** Log a progress message with elapsed time since run start. */
  private log(msg: string): void {
    const elapsed = this.runStartTime ? Math.round((Date.now() - this.runStartTime) / 1000) : 0;
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const ts =
      mins > 0
        ? `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `00:${String(secs).padStart(2, '0')}`;
    console.log(`${chalk.dim.cyan('[workflow')} ${chalk.dim.cyan(ts)}${chalk.dim.cyan(']')} ${msg}`);
  }

  private buildBrokerName(runId: string): string {
    const brokerBaseName = path.basename(this.cwd) || 'workflow';
    return `${brokerBaseName}-${runId.slice(0, 8)}`;
  }

  private createBrokerEventHandler(runId: string): (event: BrokerEvent) => void {
    return (event: BrokerEvent) => {
      // Re-emit every broker event except the high-volume PTY stream.
      if (event.kind !== 'worker_stream') {
        this.emit({ type: 'broker:event', runId, event });
      }

      switch (event.kind) {
        case 'worker_stream': {
          const { name, chunk } = event;
          const listener = this.ptyListeners.get(name);
          if (listener) listener(chunk);

          // Parse PTY output for high-signal activity
          const stripped = WorkflowRunner.stripAnsi(chunk);
          const shortName = name.replace(/-[a-f0-9]{6,}$/, '');
          let activity: string | undefined;
          if (/Read\(/.test(stripped)) {
            const m = stripped.match(/Read\(\s*~?([^\s)"']{8,})/);
            if (m) {
              const base = path.basename(m[1]);
              activity = base.length >= 3 ? `Reading ${base}` : 'Reading file...';
            } else {
              activity = 'Reading file...';
            }
          } else if (/Edit\(/.test(stripped)) {
            const m = stripped.match(/Edit\(\s*~?([^\s)"']{8,})/);
            if (m) {
              const base = path.basename(m[1]);
              activity = base.length >= 3 ? `Editing ${base}` : 'Editing file...';
            } else {
              activity = 'Editing file...';
            }
          } else if (/Bash\(/.test(stripped)) {
            const m = stripped.match(/Bash\(\s*(.{1,40})/);
            activity = m ? `Running: ${m[1].trim()}...` : 'Running command...';
          } else if (/Explore\(/.test(stripped)) {
            const m = stripped.match(/Explore\(\s*(.{1,50})/);
            activity = m ? `Exploring: ${m[1].replace(/\).*/, '').trim()}` : 'Exploring codebase...';
          } else if (/Task\(/.test(stripped)) {
            activity = 'Running sub-agent...';
          } else if (/Sublimating|Thinking|Coalescing|Cultivating/.test(stripped)) {
            const m = stripped.match(/(\d+)s/);
            activity = m ? `Thinking... (${m[1]}s)` : 'Thinking...';
          }
          if (activity && this.lastActivity.get(name) !== activity) {
            this.lastActivity.set(name, activity);
            this.log(`[${shortName}] ${activity}`);
          }
          break;
        }

        case 'relay_inbound': {
          const from = event.from;
          const to = event.target;
          const text = event.body;
          const body = text.length > 120 ? text.slice(0, 117) + '...' : text;
          const fromShort = from.replace(/-[a-f0-9]{6,}$/, '');
          const toShort = to.replace(/-[a-f0-9]{6,}$/, '');
          this.log(`[msg] ${fromShort} → ${toShort}: ${body}`);

          if (this.channel && (to === this.channel || to === `#${this.channel}`)) {
            const runtimeAgent = this.runtimeStepAgents.get(from);
            this.recordChannelEvidence(text, {
              sender: runtimeAgent?.logicalName ?? from,
              actor: from,
              role: runtimeAgent?.role,
              target: to,
              origin: 'relay_message',
              stepName: runtimeAgent?.stepName,
            });
          }

          const supervision = this.supervisedRuntimeAgents.get(from);
          if (supervision?.role === 'owner') {
            this.recordStepToolSideEffect(supervision.stepName, {
              type: 'owner_monitoring',
              detail: `Owner messaged ${to}: ${text.slice(0, 120)}`,
              raw: { to, text },
            });
            void this.trajectory?.ownerMonitoringEvent(
              supervision.stepName,
              supervision.logicalName,
              `Messaged ${to}: ${text.slice(0, 120)}`,
              { to, text }
            );
          }
          break;
        }

        case 'agent_spawned': {
          if (!this.activeAgentHandles.has(event.name)) {
            this.log(`[spawned] ${event.name} (${event.runtime})`);
          }
          break;
        }

        case 'agent_exited': {
          this.lastActivity.delete(event.name);
          this.lastIdleLog.delete(event.name);
          if (!this.activeAgentHandles.has(event.name)) {
            this.log(`[exited] ${event.name} (code: ${event.code ?? '?'})`);
          }
          break;
        }

        case 'agent_idle': {
          const { name, idle_secs } = event;
          const bucket = Math.floor(idle_secs / 30) * 30;
          if (bucket >= 30 && this.lastIdleLog.get(name) !== bucket) {
            this.lastIdleLog.set(name, bucket);
            const shortName = name.replace(/-[a-f0-9]{6,}$/, '');
            this.log(`[idle] ${shortName} silent for ${bucket}s`);
          }
          break;
        }

        default:
          break;
      }
    };
  }

  private clearRelayListeners(): void {
    for (const off of this.unsubRelayListeners) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.unsubRelayListeners = [];
  }

  private wireRelayClient(runId: string): void {
    if (!this.relay) return;

    this.clearRelayListeners();
    this.unsubRelayListeners.push(this.relay.onEvent(this.createBrokerEventHandler(runId)));
    const unsubBrokerExit = this.relay.onBrokerExit?.((info) => {
      if (this.relay?.brokerPid === info.pid) {
        this.relay = undefined;
      }
      this.log(
        `Broker exited (pid: ${info.pid ?? '?'}, code: ${info.code ?? '?'}, signal: ${info.signal ?? '?'})`
      );
    });
    if (unsubBrokerExit) {
      this.unsubRelayListeners.push(unsubBrokerExit);
    }
    this.relay.connectEvents();
  }

  private async startBroker(context: BrokerRunContext): Promise<void> {
    await this.startOrReuseSharedBroker(context.runId, context.channel, context.relaycastDisabled);
    if (!this.relay) {
      throw new Error('Broker client was not initialized');
    }
    this.wireRelayClient(context.runId);
  }

  private isRetryableProtocolError(error: unknown): boolean {
    const candidate = error as { retryable?: unknown; status?: unknown; message?: unknown } | undefined;
    if (candidate?.retryable === true) return true;
    if (typeof candidate?.status === 'number' && candidate.status >= 500) return true;
    const message = typeof candidate?.message === 'string' ? candidate.message : '';
    return /\b(fetch failed|econn|enotfound|eai_again|socket hang up|network|service unavailable|timed out)\b/i.test(
      message
    );
  }

  private isTransientAgentNetworkError(error: unknown): boolean {
    const candidate = error as { retryable?: unknown; status?: unknown; message?: unknown } | undefined;
    if (candidate?.retryable === true) return true;
    if (typeof candidate?.status === 'number' && candidate.status >= 500) return true;
    const message = error instanceof Error ? error.message : String(error);
    return /\b(fetch failed|econn|enotfound|eai_again|socket hang up|network error|connection reset|connection refused|service unavailable)\b/i.test(message);
  }

  private async recoverBroker(reason: string): Promise<void> {
    if (!this.currentBrokerContext) {
      throw new Error(`Broker unavailable and no recovery context exists (${reason})`);
    }
    if (this.brokerRecoveryPromise) {
      await this.brokerRecoveryPromise;
      return;
    }
    if (this.activeAgentHandles.size > 0) {
      const activeAgents = [...this.activeAgentHandles.keys()];
      throw new Error(
        `Broker recovery is unsafe while ${activeAgents.length} agent${activeAgents.length === 1 ? ' is' : 's are'} still active: ${activeAgents.slice(0, 3).join(', ')}`
      );
    }

    this.brokerRecoveryPromise = (async () => {
      this.log(`Broker unavailable (${reason}); restarting...`);
      this.clearRelayListeners();
      await this.shutdownRelay().catch(() => undefined);
      await this.startBroker(this.currentBrokerContext!);
      this.log('Broker restarted');
    })();

    try {
      await this.brokerRecoveryPromise;
    } finally {
      this.brokerRecoveryPromise = undefined;
    }
  }

  private async withBrokerRecovery<T>(operation: string, work: (relay: HarnessDriverClient) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= BROKER_OPERATION_MAX_ATTEMPTS; attempt++) {
      const relay = this.relay;
      if (!relay) {
        lastError = new Error(`Broker unavailable while ${operation}`);
      } else {
        try {
          return await work(relay);
        } catch (error) {
          lastError = error;
          if (!this.isRetryableProtocolError(error)) {
            throw error;
          }
        }
      }

      if (attempt >= BROKER_OPERATION_MAX_ATTEMPTS) {
        break;
      }
      await this.recoverBroker(`${operation} failed`);
      await this.delay(BROKER_OPERATION_RETRY_DELAY_MS * attempt);
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Broker operation failed during ${operation}: ${message}`);
  }

  // ── Relaycast auto-provisioning ────────────────────────────────────────

  /**
   * Ensure a Relaycast workspace API key is available for the broker.
   * Resolution order:
   *   1. RELAY_API_KEY environment variable (explicit override)
   *   2. Auto-create a fresh workspace via the Relaycast API
   *
   * Each workflow run gets its own isolated workspace — no caching, no sharing.
   */
  private async ensureRelaycastApiKey(channel: string): Promise<void> {
    if (this.relayApiKey) return;

    // Explicit override from relayOptions or environment takes priority.
    const envKey = this.relayOptions.env?.RELAY_API_KEY ?? process.env.RELAY_API_KEY;
    if (envKey) {
      this.relayApiKey = envKey;
      return;
    }

    // Always create a fresh workspace — each run gets full isolation.
    const workspaceName = `relay-${channel}-${randomBytes(4).toString('hex')}`;
    const baseUrl =
      this.relayOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev';
    const res = await fetch(`${baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: workspaceName }),
    });

    if (!res.ok) {
      throw new Error(`Failed to auto-create Relaycast workspace: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as Record<string, any>;
    const data = (body.data ?? body) as Record<string, any>;
    const apiKey = data.api_key as string;

    if (!apiKey) {
      throw new Error('Relaycast workspace response missing api_key');
    }

    this.relayApiKey = apiKey;
    this.relayApiKeyAutoCreated = true;

    // Best-effort: push the key to a co-running dashboard (agent-relay up) so it
    // can make Relaycast API calls without any file or manual env var setup.
    const dashboardPort = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';
    fetch(`http://127.0.0.1:${dashboardPort}/api/relay-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[WorkflowRunner] dashboard key push failed: HTTP ${res.status}`);
        }
      })
      .catch(() => {
        // Dashboard not running — silently ignore.
      });
  }

  private async loadCredentialProxyModule(): Promise<CredentialProxyModule | null> {
    try {
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (
        specifier: string
      ) => Promise<unknown>;
      const module = (await dynamicImport('@agent-relay/credential-proxy')) as Partial<CredentialProxyModule>;
      return typeof module.mintProxyToken === 'function' ? (module as CredentialProxyModule) : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_MODULE_NOT_FOUND') {
        return null;
      }

      throw error;
    }
  }

  private resolveCredentialProxyProvider(agentDef: AgentDefinition, config: RelayYamlConfig): ProxyProvider {
    const configuredProviders = Object.keys(config.swarm.credentialProxy?.providers ?? {});
    const explicitProvider = agentDef.credentials?.provider?.trim().toLowerCase();
    if (
      explicitProvider === 'openai' ||
      explicitProvider === 'anthropic' ||
      explicitProvider === 'openrouter'
    ) {
      return explicitProvider;
    }

    const model = agentDef.constraints?.model?.trim().toLowerCase() ?? '';
    if (model.includes('openrouter')) {
      return 'openrouter';
    }
    if (model.includes('claude') || model.includes('anthropic')) {
      return 'anthropic';
    }
    if (
      model.includes('openai') ||
      model.includes('chatgpt') ||
      model.includes('gpt') ||
      /\bo[134](?:\b|-)/.test(model)
    ) {
      return 'openai';
    }

    if (configuredProviders.length === 1) {
      const [onlyProvider] = configuredProviders;
      if (onlyProvider === 'openai' || onlyProvider === 'anthropic' || onlyProvider === 'openrouter') {
        return onlyProvider;
      }
    }

    switch (agentDef.cli) {
      case 'claude':
        return 'anthropic';
      case 'codex':
      case 'aider':
      case 'goose':
      case 'opencode':
      case 'cursor':
      case 'cursor-agent':
        return 'openai';
      default:
        throw new Error(
          `Unable to resolve credential proxy provider for agent "${agentDef.name}". Set credentials.provider or constraints.model.`
        );
    }
  }

  private resolveCredentialProxySecret(config: RelayYamlConfig): string {
    const configuredSecret = config.swarm.credentialProxy?.jwtSecret;
    if (configuredSecret?.startsWith('$')) {
      const envSecret = process.env[configuredSecret.slice(1)];
      if (envSecret) {
        return envSecret;
      }
    } else if (configuredSecret) {
      return configuredSecret;
    }

    const defaultSecret = process.env.RELAY_PROXY_JWT_SECRET;
    if (defaultSecret) {
      return defaultSecret;
    }

    throw new Error(
      'Credential proxy JWT secret is missing. Set swarm.credentialProxy.jwtSecret or RELAY_PROXY_JWT_SECRET.'
    );
  }

  private async mintAgentProxyToken(
    agentDef: AgentDefinition,
    config: RelayYamlConfig
  ): Promise<string | undefined> {
    const proxyConfig = config.swarm?.credentialProxy;
    if (!proxyConfig?.proxyUrl || !agentDef.credentials?.proxy) {
      return undefined;
    }

    const provider = this.resolveCredentialProxyProvider(agentDef, config);
    const providerConfig = proxyConfig.providers?.[provider];
    const credentialId = providerConfig?.credentialId;
    if (!credentialId) {
      throw new Error(
        `Credential proxy provider "${provider}" is not configured for agent "${agentDef.name}".`
      );
    }

    const budget = agentDef.constraints?.maxTokens ?? proxyConfig.defaultBudget;
    const cacheKey = `${agentDef.name}:${provider}:${credentialId}:${budget ?? 'default'}`;
    const cachedToken = this.proxyTokens.get(cacheKey);
    if (cachedToken) {
      return cachedToken;
    }

    const credentialProxy = await this.loadCredentialProxyModule();
    if (!credentialProxy) {
      throw new Error(
        'Credential proxy mode requires the optional peer dependency "@agent-relay/credential-proxy".'
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await credentialProxy.mintProxyToken(
      {
        sub: this.workspaceId,
        aud: 'relay-llm-proxy',
        provider,
        credentialId,
        budget,
        exp: nowSeconds + 15 * 60,
      },
      this.resolveCredentialProxySecret(config)
    );

    this.proxyTokens.set(cacheKey, token);
    return token;
  }

  private async resolveAgentProxyMode(
    agentDef: AgentDefinition,
    config?: RelayYamlConfig
  ): Promise<ProxyModeConfig | undefined> {
    if (!agentDef.credentials?.proxy) {
      return undefined;
    }

    const env = this.getMergedRelayEnvSource();
    const configuredProxyUrl = config?.swarm?.credentialProxy?.proxyUrl;
    const proxyUrl = configuredProxyUrl ?? resolveProxyUrlFromEnv(env);
    if (!proxyUrl) {
      return undefined;
    }

    if (!configuredProxyUrl) {
      const injectedToken = resolveProxyTokenFromEnv(env);
      if (!injectedToken) {
        return undefined;
      }

      return {
        url: proxyUrl,
        token: injectedToken,
      };
    }

    const token = await this.mintAgentProxyToken(agentDef, config);
    if (!token) {
      return undefined;
    }

    return {
      url: proxyUrl,
      token,
    };
  }

  private getMergedRelayEnvSource(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.relayOptions.env ?? {}),
      ...(this.relayApiKey ? { RELAY_API_KEY: this.relayApiKey } : {}),
    };
  }

  private getRelayEnv(proxyMode?: ProxyModeConfig): NodeJS.ProcessEnv | undefined {
    const env = this.getMergedRelayEnvSource();
    const inheritedProxyUrl = resolveProxyUrlFromEnv(env);
    const inheritedProxyToken = resolveProxyTokenFromEnv(env);

    if (
      !this.relayApiKey &&
      !this.relayOptions.env &&
      !proxyMode &&
      !(inheritedProxyUrl && inheritedProxyToken)
    ) {
      return undefined;
    }

    const normalizedProxy =
      proxyMode?.url && proxyMode.token
        ? proxyMode
        : inheritedProxyUrl && inheritedProxyToken
          ? { url: inheritedProxyUrl, token: inheritedProxyToken }
          : undefined;

    if (normalizedProxy) {
      Object.assign(env, buildNormalizedProxyEnv(normalizedProxy.url, normalizedProxy.token));
      for (const key of getStrippedApiKeyVars()) {
        delete env[key];
      }
    }

    return env;
  }

  private getBrokerCwd(): string {
    return this.relayOptions.cwd ?? this.cwd;
  }

  private getBrokerStateDir(brokerCwd: string): string {
    const configured =
      this.relayOptions.binaryArgs?.stateDir ??
      this.relayOptions.env?.AGENT_RELAY_STATE_DIR ??
      process.env.AGENT_RELAY_STATE_DIR;
    return path.resolve(configured ?? path.join(brokerCwd, '.agentworkforce', 'relay'));
  }

  private async tryConnectSharedBroker(
    connectionPath: string,
    brokerCwd: string
  ): Promise<HarnessDriverClient | null> {
    const conn = readBrokerConnectionFile(connectionPath);
    if (!conn) {
      return null;
    }

    if (!isPidRunning(conn.pid)) {
      safeUnlinkSync(connectionPath);
      return null;
    }

    try {
      const client = HarnessDriverClient.connect({ cwd: brokerCwd, connectionPath });
      await client.getStatus();
      return client;
    } catch {
      return null;
    }
  }

  private async acquireSharedBrokerStartLock(
    stateDir: string,
    startupTimeoutMs: number
  ): Promise<() => void> {
    mkdirSync(stateDir, { recursive: true });
    const lockDir = path.join(stateDir, SHARED_BROKER_LOCK_DIRNAME);
    const deadline = Date.now() + Math.max(startupTimeoutMs + 5_000, 10_000);
    const staleAfterMs = Math.max(startupTimeoutMs * 2, 30_000);

    for (;;) {
      try {
        mkdirSync(lockDir);
        writeFileSync(
          path.join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
          'utf-8'
        );
        return () => {
          rmSync(lockDir, { recursive: true, force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
      }

      try {
        const stat = statSync(lockDir);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for shared broker startup lock at ${lockDir}`);
      }
      await sleepMs(SHARED_BROKER_LOCK_POLL_MS);
    }
  }

  private createSharedBrokerLease(
    stateDir: string,
    connectionPath: string,
    runId: string,
    startedBroker: boolean
  ): SharedBrokerLease {
    const leaseDir = path.join(stateDir, SHARED_BROKER_LEASE_DIRNAME);
    const ownerPath = path.join(stateDir, SHARED_BROKER_OWNER_FILENAME);
    mkdirSync(leaseDir, { recursive: true });
    const leasePath = path.join(
      leaseDir,
      `${process.pid}-${runId}-${randomBytes(4).toString('hex')}.json`
    );
    writeFileSync(
      leasePath,
      JSON.stringify({
        pid: process.pid,
        runId,
        startedBroker,
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    return { stateDir, connectionPath, ownerPath, leasePath, startedBroker };
  }

  private writeSharedBrokerOwner(lease: SharedBrokerLease): void {
    const conn = readBrokerConnectionFile(lease.connectionPath);
    writeFileSync(
      lease.ownerPath,
      JSON.stringify({
        pid: conn?.pid,
        createdByPid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
  }

  private isWorkflowOwnedSharedBroker(lease: SharedBrokerLease): boolean {
    const conn = readBrokerConnectionFile(lease.connectionPath);
    if (!conn) {
      return false;
    }
    try {
      const owner = JSON.parse(readFileSync(lease.ownerPath, 'utf-8')) as { pid?: unknown };
      return owner.pid === conn.pid;
    } catch {
      return false;
    }
  }

  private disconnectRelayClient(relay: HarnessDriverClient): void {
    const disconnect = (relay as { disconnect?: () => void }).disconnect;
    if (typeof disconnect === 'function') {
      disconnect.call(relay);
    }
  }

  private countLiveSharedBrokerLeases(stateDir: string): number {
    const leaseDir = path.join(stateDir, SHARED_BROKER_LEASE_DIRNAME);
    let entries: Dirent[];
    try {
      entries = readdirSync(leaseDir, { withFileTypes: true });
    } catch {
      return 0;
    }

    let live = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const leasePath = path.join(leaseDir, entry.name);
      try {
        const lease = JSON.parse(readFileSync(leasePath, 'utf-8')) as { pid?: unknown };
        if (typeof lease.pid === 'number' && lease.pid > 0 && isPidRunning(lease.pid)) {
          live += 1;
        } else {
          safeUnlinkSync(leasePath);
        }
      } catch {
        safeUnlinkSync(leasePath);
      }
    }
    return live;
  }

  private async startOrReuseSharedBroker(
    runId: string,
    channel: string,
    relaycastDisabled: boolean
  ): Promise<void> {
    const brokerCwd = this.getBrokerCwd();
    const stateDir = this.getBrokerStateDir(brokerCwd);
    const connectionPath = path.join(stateDir, BROKER_CONNECTION_FILENAME);
    const startupTimeoutMs =
      this.relayOptions.startupTimeoutMs ?? SHARED_BROKER_DEFAULT_STARTUP_TIMEOUT_MS;
    const lease = this.createSharedBrokerLease(stateDir, connectionPath, runId, false);
    this.sharedBrokerLease = lease;

    const existing = await this.tryConnectSharedBroker(connectionPath, brokerCwd);
    if (existing) {
      this.log('Reusing shared broker...');
      this.relay = existing;
      return;
    }

    const releaseLock = await this.acquireSharedBrokerStartLock(stateDir, startupTimeoutMs);
    try {
      const lockedExisting = await this.tryConnectSharedBroker(connectionPath, brokerCwd);
      if (lockedExisting) {
        this.log('Reusing shared broker...');
        this.relay = lockedExisting;
        return;
      }

      this.log('Starting broker...');
      // Include a short run ID suffix in the broker name so a newly-created
      // broker keeps the same Relaycast identity behavior as previous runs.
      const brokerBaseName = path.basename(this.cwd) || 'workflow';
      const brokerName = `${brokerBaseName}-${runId.slice(0, 8)}`;
      const relayEnv = {
        ...(this.getRelayEnv() ?? filteredEnv()),
        AGENT_RELAY_STATE_DIR: stateDir,
      };
      this.relay = await HarnessDriverClient.spawn({
        ...this.relayOptions,
        cwd: brokerCwd,
        brokerName,
        channels: relaycastDisabled ? [] : [channel],
        binaryArgs: {
          ...(this.relayOptions.binaryArgs ?? {}),
          persist: true,
          stateDir,
        },
        env: relayEnv,
        // Workflows spawn agents across multiple waves; each spawn requires a PTY +
        // Relaycast registration. 60s is too tight when the broker is saturated with
        // long-running PTY processes from earlier steps. 120s gives room to breathe.
        requestTimeoutMs: this.relayOptions.requestTimeoutMs ?? 120_000,
        // Wire broker stderr to console for observability — skip empty and
        // JSON event lines (already surfaced via the broker:event emitter).
        onStderr: (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) return;
          console.log(`${chalk.dim.yellow('[broker]')} ${line}`);
        },
      });
      lease.startedBroker = true;
      this.writeSharedBrokerOwner(lease);
    } finally {
      releaseLock();
    }
  }

  async shutdownRelay(): Promise<void> {
    const relay = this.relay;
    const lease = this.sharedBrokerLease;
    this.sharedBrokerLease = undefined;

    if (!relay) {
      if (lease) {
        safeUnlinkSync(lease.leasePath);
      }
      return;
    }

    this.relay = undefined;

    if (!lease) {
      await relay.shutdown();
      return;
    }

    safeUnlinkSync(lease.leasePath);
    const liveLeases = this.countLiveSharedBrokerLeases(lease.stateDir);
    if (liveLeases === 0 && (lease.startedBroker || this.isWorkflowOwnedSharedBroker(lease))) {
      await relay.shutdown();
      safeUnlinkSync(lease.connectionPath);
      safeUnlinkSync(lease.ownerPath);
    } else {
      this.disconnectRelayClient(relay);
    }
  }

  private async provisionAgents(config: RelayYamlConfig): Promise<void> {
    // Cloud launcher already compiled and seeded relayfile ACLs before the
    // sandbox started.  Skip in-sandbox provisioning — the relayfile API has
    // no POST /v1/workspaces route, so attempting it causes a fatal 404.
    if (process.env.RELAY_CLOUD_PROVISIONING_DONE === '1') {
      return;
    }

    this.agentTokens.clear();
    this.proxyTokens.clear();
    await this.stopProvisionedMounts();

    const agentsToProvision: Record<string, NonNullable<AgentDefinition['permissions']>> = {};
    for (const agent of config.agents) {
      if (agent.permissions) {
        agentsToProvision[agent.name] = agent.permissions;
      }
    }

    const agentNames = Object.keys(agentsToProvision);
    if (agentNames.length === 0) {
      return;
    }

    const relayEnv = {
      ...process.env,
      ...(this.getRelayEnv() ?? {}),
    };
    const tokenSigningKey = resolveWorkflowTokenSigningKey(relayEnv);
    const result = await provisionWorkflowAgents({
      tokenSigningKey,
      workspace: this.workspaceId,
      projectDir: this.cwd,
      relayfileBaseUrl: relayEnv.RELAYFILE_BASE_URL ?? 'http://127.0.0.1:8080',
      agents: agentsToProvision,
      tokenTtlSeconds: 3600,
    });

    for (const [agentName, token] of result.tokens) {
      this.agentTokens.set(agentName, token);
    }
    for (const [agentName, mount] of result.mounts) {
      this.agentMounts.set(agentName, mount);
    }

    this.log(
      `Provisioned workflow tokens for ${result.tokens.size} agent${result.tokens.size === 1 ? '' : 's'}`
    );
  }

  private getRelaycastBaseUrl(): string {
    return (
      this.relayOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev'
    );
  }

  private getRelaycastClient(): RelayCast {
    if (!this.relayApiKey) {
      throw new Error('No Relaycast API key available');
    }
    if (!this.relaycast) {
      this.relaycast = new RelayCast({
        apiKey: this.relayApiKey,
        baseUrl: this.getRelaycastBaseUrl(),
      });
    }
    return this.relaycast;
  }

  private async ensureRelaycastRunnerAgent(): Promise<AgentClient> {
    if (this.relaycastAgent) return this.relaycastAgent;

    const rc = this.getRelaycastClient();
    let registration;
    try {
      registration = await rc.agents.register({ name: 'WorkflowRunner', type: 'agent' });
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        registration = await rc.agents.register({
          name: `WorkflowRunner-${randomBytes(4).toString('hex')}`,
          type: 'agent',
        });
      } else {
        throw err;
      }
    }

    this.relaycastAgent = rc.as(registration.token);
    return this.relaycastAgent;
  }

  private async createAndJoinRelaycastChannel(channel: string, topic?: string): Promise<void> {
    const agent = await this.ensureRelaycastRunnerAgent();
    try {
      await agent.channels.create({ name: channel, ...(topic ? { topic } : {}) });
    } catch (err) {
      if (!(err instanceof RelayError && err.code === 'name_conflict')) {
        throw err;
      }
    }
    await agent.channels.join(channel);
  }

  private async registerRelaycastExternalAgent(name: string, persona?: string): Promise<AgentClient | null> {
    const rc = this.getRelaycastClient();
    try {
      const registration = await rc.agents.register({
        name,
        type: 'agent',
        ...(persona ? { persona } : {}),
      });
      return rc.as(registration.token);
    } catch (err) {
      if (err instanceof RelayError && err.code === 'name_conflict') {
        return null;
      }
      throw err;
    }
  }

  private startRelaycastHeartbeat(agent: AgentClient, intervalMs = 30_000): () => void {
    const beat = () => {
      agent.heartbeat().catch(() => {});
    };
    const timer = setInterval(beat, intervalMs);
    timer.unref();
    beat();
    return () => clearInterval(timer);
  }

  // ── Event subscription ──────────────────────────────────────────────────

  on(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: WorkflowEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Parsing & validation ────────────────────────────────────────────────

  /** Parse a relay.yaml file from disk. */
  async parseYamlFile(filePath: string): Promise<RelayYamlConfig> {
    const absPath = path.resolve(this.cwd, filePath);
    const raw = await readFile(absPath, 'utf-8');
    return this.parseYamlString(raw, absPath);
  }

  /** Parse a relay.yaml string. */
  parseYamlString(raw: string, source = '<string>'): RelayYamlConfig {
    const parsed = parseYaml(raw);
    this.validateConfig(parsed, source);
    const config = this.normalizeLegacyPermissionConfig(parsed as RelayYamlConfig);
    config.agents ??= [];
    return config;
  }

  private normalizeLegacyPermissionConfig(config: RelayYamlConfig): RelayYamlConfig {
    const legacyPermissions = (
      config as RelayYamlConfig & {
        permissions?: { profiles?: RelayYamlConfig['permission_profiles'] };
      }
    ).permissions;

    if (
      config.permission_profiles === undefined &&
      legacyPermissions &&
      typeof legacyPermissions === 'object' &&
      legacyPermissions.profiles &&
      typeof legacyPermissions.profiles === 'object'
    ) {
      return {
        ...config,
        permission_profiles: legacyPermissions.profiles,
      };
    }

    return config;
  }

  private applyReliabilityDefaults(config: RelayYamlConfig): RelayYamlConfig {
    const existing = config.errorHandling;
    if (existing?.strategy === 'fail-fast' || existing?.strategy === 'continue') {
      return config;
    }

    const hasRepairAgentCandidate = (config.agents ?? []).length > 0;
    const maxRetries =
      existing?.maxRetries ??
      existing?.repairRetries ??
      (existing ? DEFAULT_WORKFLOW_MAX_RETRIES : DEFAULT_WORKFLOW_MAX_RETRIES);
    const repairRetries =
      existing?.repairRetries ??
      (hasRepairAgentCandidate
        ? (existing?.maxRetries ?? DEFAULT_WORKFLOW_REPAIR_RETRIES)
        : existing?.repairRetries);

    return {
      ...config,
      errorHandling: {
        ...existing,
        strategy: 'retry',
        maxRetries,
        retryDelayMs: existing?.retryDelayMs ?? DEFAULT_WORKFLOW_RETRY_DELAY_MS,
        ...(repairRetries !== undefined ? { repairRetries } : {}),
      },
    };
  }

  /** Validate a config object against the RelayYamlConfig shape. */
  validateConfig(config: unknown, source = '<config>'): asserts config is RelayYamlConfig {
    if (typeof config !== 'object' || config === null) {
      throw new Error(`${source}: config must be a non-null object`);
    }

    const c = config as Record<string, unknown>;

    if (typeof c.version !== 'string') {
      throw new Error(`${source}: missing required field "version"`);
    }
    if (typeof c.name !== 'string') {
      throw new Error(`${source}: missing required field "name"`);
    }
    if (typeof c.swarm !== 'object' || c.swarm === null) {
      throw new Error(`${source}: missing required field "swarm"`);
    }
    const swarm = c.swarm as Record<string, unknown>;
    if (typeof swarm.pattern !== 'string') {
      throw new Error(`${source}: missing required field "swarm.pattern"`);
    }
    if (c.agents !== undefined && !Array.isArray(c.agents)) {
      throw new Error(`${source}: "agents" must be an array when provided`);
    }
    const legacyPermissions = c.permissions;
    if (
      legacyPermissions !== undefined &&
      (typeof legacyPermissions !== 'object' ||
        legacyPermissions === null ||
        Array.isArray(legacyPermissions))
    ) {
      throw new Error(`${source}: "permissions" must be an object when provided`);
    }
    if (
      c.permission_profiles !== undefined &&
      (typeof c.permission_profiles !== 'object' ||
        c.permission_profiles === null ||
        Array.isArray(c.permission_profiles))
    ) {
      throw new Error(`${source}: "permission_profiles" must be an object when provided`);
    }
    if (
      c.permission_profiles === undefined &&
      legacyPermissions !== undefined &&
      typeof legacyPermissions === 'object' &&
      legacyPermissions !== null
    ) {
      const profiles = (legacyPermissions as Record<string, unknown>).profiles;
      if (
        profiles !== undefined &&
        (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles))
      ) {
        throw new Error(`${source}: "permissions.profiles" must be an object when provided`);
      }
    }

    for (const agent of c.agents ?? []) {
      if (typeof agent !== 'object' || agent === null) {
        throw new Error(`${source}: each agent must be an object`);
      }
      const a = agent as Record<string, unknown>;
      if (typeof a.name !== 'string') {
        throw new Error(`${source}: each agent must have a string "name"`);
      }
      if (typeof a.cli !== 'string') {
        throw new Error(`${source}: each agent must have a string "cli"`);
      }
    }

    if (c.workflows !== undefined) {
      if (!Array.isArray(c.workflows)) {
        throw new Error(`${source}: "workflows" must be an array`);
      }
      for (const wf of c.workflows) {
        this.validateWorkflow(wf, (c.agents ?? []) as AgentDefinition[], source);
      }
    }
  }

  // ── Dry-run simulation ──────────────────────────────────────────────

  /**
   * Validate a workflow config and simulate execution waves without spawning agents.
   * Returns a DryRunReport with DAG analysis, agent summary, and wave breakdown.
   */
  dryRun(config: RelayYamlConfig, workflowName?: string, vars?: VariableContext): DryRunReport {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Validate config
    let resolved: RelayYamlConfig;
    try {
      this.validateConfig(config);
      resolved = vars ? this.resolveVariables(config, vars) : config;
      resolved = this.applyPermissionProfiles(resolved);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return {
        valid: false,
        errors,
        warnings,
        name: (config as any)?.name ?? '<unknown>',
        pattern: (config as any)?.swarm?.pattern ?? '<unknown>',
        agents: [],
        waves: [],
        totalSteps: 0,
        estimatedWaves: 0,
      };
    }

    // 1b. Validate permissions and resolve named paths
    const permissionResult = this.validatePermissions(resolved.agents, resolved.permission_profiles);
    errors.push(...permissionResult.errors);
    warnings.push(...permissionResult.warnings);

    const pathResult = this.resolvePathDefinitions(resolved.paths, this.cwd);
    errors.push(...pathResult.errors);
    warnings.push(...pathResult.warnings);
    const dryRunPaths = pathResult.resolved;

    // Validate workdir references on agents
    for (const agent of resolved.agents) {
      if (agent.workdir && !dryRunPaths.has(agent.workdir)) {
        errors.push(
          `Agent "${agent.name}" references workdir "${agent.workdir}" which is not defined in paths`
        );
      }
    }

    // 2. Find target workflow
    const workflows = resolved.workflows ?? [];
    const workflow = workflowName ? workflows.find((w) => w.name === workflowName) : workflows[0];

    if (!workflow) {
      errors.push(
        workflowName ? `Workflow "${workflowName}" not found in config` : 'No workflows defined in config'
      );
      return {
        valid: false,
        errors,
        warnings,
        name: resolved.name,
        description: resolved.description,
        pattern: resolved.swarm.pattern,
        agents: [],
        waves: [],
        totalSteps: 0,
        estimatedWaves: 0,
      };
    }

    // 3. Load and validate custom steps
    let customSteps = new Map<string, import('./types.js').CustomStepDefinition>();
    try {
      customSteps = loadCustomSteps(this.cwd);
    } catch (err) {
      if (err instanceof CustomStepsParseError) {
        errors.push(`Custom steps file error: ${err.issue}\n${err.suggestion}`);
      } else {
        errors.push(`Failed to load custom steps: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Validate custom step usage in workflow steps
    const customStepValidation = validateCustomStepsUsage(workflow.steps, customSteps);
    errors.push(...customStepValidation.errors);
    warnings.push(...customStepValidation.warnings);

    // Resolve custom steps for further validation
    let resolvedSteps = workflow.steps;
    if (customStepValidation.valid) {
      try {
        resolvedSteps = resolveAllCustomSteps(workflow.steps, customSteps);
      } catch (err) {
        if (err instanceof CustomStepResolutionError) {
          errors.push(`${err.issue}\n${err.suggestion}`);
        } else {
          errors.push(`Failed to resolve custom steps: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // 4. Build agent map and validate step→agent references
    const agentMap = new Map<string, AgentDefinition>();
    for (const agent of resolved.agents) {
      agentMap.set(agent.name, agent);
    }

    const stepAgentCounts = new Map<string, number>();
    for (const step of resolvedSteps) {
      // Only validate agent references for agent-type steps
      if (step.agent) {
        if (!agentMap.has(step.agent)) {
          warnings.push(`Step "${step.name}" references unknown agent "${step.agent}"`);
        }
        stepAgentCounts.set(step.agent, (stepAgentCounts.get(step.agent) ?? 0) + 1);
      }
    }

    // Validate workdir references on steps
    for (const step of resolvedSteps) {
      if (step.workdir && !dryRunPaths.has(step.workdir)) {
        errors.push(`Step "${step.name}" references workdir "${step.workdir}" which is not defined in paths`);
      }
    }

    // Validate cwd paths
    for (const agent of resolved.agents) {
      if (agent.cwd) {
        const resolvedCwd = path.resolve(this.cwd, agent.cwd);
        if (!existsSync(resolvedCwd)) {
          warnings.push(
            `Agent "${agent.name}" cwd "${agent.cwd}" resolves to "${resolvedCwd}" which does not exist`
          );
        }
      }
      if (agent.additionalPaths) {
        for (const ap of agent.additionalPaths) {
          const resolvedPath = path.resolve(this.cwd, ap);
          if (!existsSync(resolvedPath)) {
            warnings.push(
              `Agent "${agent.name}" additionalPath "${ap}" resolves to "${resolvedPath}" which does not exist`
            );
          }
        }
      }
    }

    // Cycle detection via topological sort
    const stepNames = new Set(resolvedSteps.map((s) => s.name));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const step of resolvedSteps) {
      inDegree.set(step.name, 0);
      adjacency.set(step.name, []);
    }
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        if (stepNames.has(dep)) {
          adjacency.get(dep)!.push(step.name);
          inDegree.set(step.name, (inDegree.get(step.name) ?? 0) + 1);
        }
      }
    }
    const topoQueue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) topoQueue.push(name);
    }
    let visited = 0;
    while (topoQueue.length > 0) {
      const node = topoQueue.shift()!;
      visited++;
      for (const neighbor of adjacency.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) topoQueue.push(neighbor);
      }
    }
    if (visited < resolvedSteps.length) {
      errors.push(
        'Dependency cycle detected in workflow steps. Check dependsOn references for circular dependencies.'
      );
    }

    // Missing dependency references
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepNames.has(dep)) {
          errors.push(`Step "${step.name}" depends on unknown step "${dep}"`);
        }
      }
    }

    // Unreachable steps (steps that are never depended on and aren't root steps)
    const dependedOn = new Set<string>();
    for (const step of resolvedSteps) {
      for (const dep of step.dependsOn ?? []) {
        dependedOn.add(dep);
      }
    }

    // Timeout warnings
    for (const step of resolvedSteps) {
      if (!step.timeoutMs) {
        const agentDef = step.agent ? agentMap.get(step.agent) : undefined;
        if (!agentDef?.constraints?.timeoutMs && !resolved.swarm.timeoutMs) {
          warnings.push(
            `Step "${step.name}" has no timeout configured (no step, agent, or swarm-level timeout)`
          );
        }
      }
    }

    // Large dependency fan-in warning (decomposition guidance)
    for (const step of resolvedSteps) {
      if ((step.dependsOn?.length ?? 0) >= 5) {
        warnings.push(
          `Step "${step.name}" depends on ${step.dependsOn!.length} upstream steps. ` +
            `Consider decomposing into smaller verification steps to reduce context size.`
        );
      }
    }

    const permissions = resolved.agents.map((agent) => {
      const compiled = resolveAgentPermissions(agent.name, agent.permissions, this.cwd, this.workspaceId);
      const source: NonNullable<DryRunReport['permissions']>[number]['source'] = compiled.sources.some(
        (entry) => entry.type === 'yaml'
      )
        ? 'yaml'
        : compiled.sources.some((entry) => entry.type === 'preset')
          ? 'preset'
          : compiled.sources.some((entry) => entry.type === 'dotfile')
            ? 'dotfiles'
            : 'none';

      return {
        agent: agent.name,
        access: compiled.effectiveAccess,
        readPaths: compiled.summary.readonly,
        writePaths: compiled.summary.readwrite,
        denyPaths: compiled.summary.denied,
        scopes: compiled.scopes.length,
        source,
      };
    });

    // 4. Build agent summary
    const agents = resolved.agents.map((a) => ({
      name: a.name,
      cli: a.cli,
      role: a.role,
      cwd: a.workdir ? dryRunPaths.get(a.workdir) : a.cwd,
      stepCount: stepAgentCounts.get(a.name) ?? 0,
    }));

    // 5. Simulate execution waves
    const waves: DryRunWave[] = [];
    const completed = new Set<string>();
    const allSteps = [...resolvedSteps];
    let waveNum = 0;

    while (completed.size < allSteps.length) {
      const ready = allSteps.filter((step) => {
        if (completed.has(step.name)) return false;
        const deps = step.dependsOn ?? [];
        return deps.every((dep) => completed.has(dep));
      });

      if (ready.length === 0) {
        // Remaining steps are blocked — likely a cycle or unresolvable deps
        const blocked = allSteps.filter((s) => !completed.has(s.name)).map((s) => s.name);
        errors.push(`Blocked steps with unresolvable dependencies: ${blocked.join(', ')}`);
        break;
      }

      waveNum++;
      waves.push({
        wave: waveNum,
        steps: ready.map((s) => ({
          name: s.name,
          agent: s.agent,
          dependsOn: s.dependsOn ?? [],
        })),
      });

      for (const step of ready) {
        completed.add(step.name);
      }
    }

    // 6. Resource estimation
    const peakConcurrency = Math.max(...waves.map((w) => w.steps.length), 0);
    const totalAgentSteps = resolvedSteps.filter(
      (s) => s.type !== 'deterministic' && s.type !== 'worktree' && s.type !== 'integration'
    ).length;

    // 7. Check maxConcurrency against wave widths
    const maxConcurrency = resolved.swarm.maxConcurrency;
    if (maxConcurrency !== undefined) {
      for (const wave of waves) {
        if (wave.steps.length > maxConcurrency) {
          warnings.push(
            `Wave ${wave.wave} has ${wave.steps.length} parallel steps but maxConcurrency is ${maxConcurrency}`
          );
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      name: workflow.name,
      description: workflow.description ?? resolved.description,
      pattern: resolved.swarm.pattern,
      agents,
      permissions,
      waves,
      totalSteps: workflow.steps.length,
      maxConcurrency,
      estimatedWaves: waves.length,
      estimatedPeakConcurrency: peakConcurrency,
      estimatedTotalAgentSteps: totalAgentSteps,
    };
  }

  private validateWorkflow(wf: unknown, agents: AgentDefinition[], source: string): void {
    if (typeof wf !== 'object' || wf === null) {
      throw new Error(`${source}: each workflow must be an object`);
    }
    const w = wf as Record<string, unknown>;
    if (typeof w.name !== 'string') {
      throw new Error(`${source}: each workflow must have a string "name"`);
    }
    if (!Array.isArray(w.steps) || w.steps.length === 0) {
      throw new Error(`${source}: workflow "${w.name}" must have a non-empty "steps" array`);
    }
    for (const step of w.steps) {
      if (typeof step !== 'object' || step === null) {
        throw new Error(`${source}: each step must be an object`);
      }
      const s = step as Record<string, unknown>;
      if (typeof s.name !== 'string') {
        throw new Error(`${source}: each step must have a string "name" field`);
      }

      // Deterministic steps require type and command
      if (s.type === 'deterministic') {
        if (typeof s.command !== 'string') {
          throw new Error(`${source}: deterministic step "${s.name}" must have a "command" field`);
        }
      } else if (s.type === 'worktree') {
        if (typeof s.branch !== 'string' || s.branch.trim().length === 0) {
          throw new Error(`${source}: worktree step "${s.name}" must have a "branch" string field`);
        }
      } else if (s.type === 'integration') {
        // Integration steps require integration and action
        if (typeof s.integration !== 'string') {
          throw new Error(`${source}: integration step "${s.name}" must have an "integration" string field`);
        }
        if (typeof s.action !== 'string') {
          throw new Error(`${source}: integration step "${s.name}" must have an "action" string field`);
        }
      } else if (s.type === 'waitFor') {
        if (typeof s.waitFor !== 'object' || s.waitFor === null) {
          throw new Error(`${source}: waitFor step "${s.name}" must have a "waitFor" event selector`);
        }
      } else {
        // Agent steps (type undefined or 'agent') require agent and task
        if (typeof s.agent !== 'string' || typeof s.task !== 'string') {
          throw new Error(`${source}: agent step "${s.name}" must have "agent" and "task" string fields`);
        }
      }
    }

    // Validate DAG: check for unknown dependencies and cycles
    const stepNames = new Set((w.steps as WorkflowStep[]).map((s) => s.name));
    for (const step of w.steps as WorkflowStep[]) {
      if (step.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!stepNames.has(dep)) {
            throw new Error(`${source}: step "${step.name}" depends on unknown step "${dep}"`);
          }
        }
      }
    }
    this.detectCycles(w.steps as WorkflowStep[], source, w.name as string);
    this.detectLeadWorkerDeadlock(w.steps as WorkflowStep[], agents, source, w.name as string);

    // Warn if non-interactive agent task is excessively large before interpolation
    for (const step of w.steps as WorkflowStep[]) {
      if (step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration') continue;
      const agentDef = agents.find((a) => a.name === step.agent);
      const isNonInteractive =
        agentDef?.interactive === false || ['worker', 'reviewer', 'analyst'].includes(agentDef?.preset ?? '');
      if (isNonInteractive && (step.task ?? '').length > 10_000) {
        console.warn(
          `[WorkflowRunner] Warning: non-interactive step "${step.name}" has a very large task (${step.task!.length} chars). ` +
            `Consider pre-reading files in a deterministic step and injecting only the relevant excerpt.`
        );
      }
    }
  }

  private detectCycles(steps: WorkflowStep[], source: string, workflowName: string): void {
    const adj = new Map<string, string[]>();
    for (const step of steps) {
      adj.set(step.name, step.dependsOn ?? []);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string): void => {
      if (inStack.has(node)) {
        throw new Error(
          `${source}: workflow "${workflowName}" contains a dependency cycle involving "${node}"`
        );
      }
      if (visited.has(node)) return;
      inStack.add(node);
      for (const dep of adj.get(node) ?? []) {
        dfs(dep);
      }
      inStack.delete(node);
      visited.add(node);
    };

    for (const step of steps) {
      dfs(step.name);
    }
  }

  private detectLeadWorkerDeadlock(
    steps: WorkflowStep[],
    agents: AgentDefinition[],
    source: string,
    workflowName: string
  ): void {
    // Build a map of step name → steps that depend on it
    const downstreamOf = new Map<string, string[]>();
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!downstreamOf.has(dep)) downstreamOf.set(dep, []);
        downstreamOf.get(dep)!.push(step.name);
      }
    }

    for (const step of steps) {
      // Only check interactive agent steps (leads)
      if (step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration') continue;
      const agentDef = agents.find((a) => a.name === step.agent);
      // Skip non-interactive agents — they can't wait for channel signals
      if (
        agentDef?.interactive === false ||
        agentDef?.preset === 'worker' ||
        agentDef?.preset === 'reviewer' ||
        agentDef?.preset === 'analyst'
      )
        continue;

      const downstream = downstreamOf.get(step.name) ?? [];
      if (downstream.length === 0) continue;

      // Check if the task mentions downstream step names in a "waiting" context
      const task = step.task ?? '';
      const waitingKeywords = /\b(wait|waiting|monitor|check inbox|check.*channel|DONE|_DONE|signal)\b/i;
      if (!waitingKeywords.test(task)) continue;

      // Check if any downstream step name appears in the task
      const mentioned = downstream.filter((name) => task.includes(name));
      if (mentioned.length > 0) {
        throw new Error(
          `${source}: workflow "${workflowName}" likely has a lead\u2194worker deadlock. ` +
            `Step "${step.name}" (interactive lead) mentions downstream step(s) [${mentioned.join(', ')}] in its task ` +
            `and appears to wait for their signals, but those steps can't start until "${step.name}" completes. ` +
            `Fix: make workers depend on a shared upstream step (e.g. "context"), not on the lead step. ` +
            `See tests/workflows/README.md rule #6.`
        );
      }
    }
  }

  // ── Template variable resolution ────────────────────────────────────────

  /** Resolve {{variable}} placeholders in all task strings. */
  resolveVariables(config: RelayYamlConfig, vars: VariableContext): RelayYamlConfig {
    return this.templateResolver.resolveVariables(config, vars);
  }

  private interpolate(template: string, vars: VariableContext): string {
    return resolveTemplate(template, vars);
  }

  private resolveDotPath(key: string, vars: VariableContext): string | number | boolean | undefined {
    return resolveTemplateDotPath(key, vars);
  }

  /** Build a nested context from completed step outputs for {{steps.X.output}} resolution. */
  private buildStepOutputContext(stepStates: Map<string, StepState>, runId?: string): VariableContext {
    const steps: Record<string, { output: string }> = {};
    for (const [name, state] of stepStates) {
      if (state.row.status === 'completed' && state.row.output !== undefined) {
        steps[name] = { output: state.row.output };
      } else if (state.row.status === 'completed' && runId) {
        // Recover from persisted output on disk (e.g., after restart)
        const persisted = this.loadStepOutput(runId, name);
        if (persisted) {
          state.row.output = persisted;
          steps[name] = { output: persisted };
        }
      }
    }
    return { steps } as unknown as VariableContext;
  }

  /** Interpolate step-output variables, silently skipping unresolved ones (they may be user vars). */
  private interpolateStepTask(template: string, context: VariableContext): string {
    return interpolateStepTaskTemplate(template, context);
  }

  private createStepLifecycleExecutor(
    workflow: WorkflowDefinition,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): WorkflowStepLifecycleExecutor<StepState> {
    // eslint-disable-next-line prefer-const -- circular: deps closure captures lifecycle before assignment
    let lifecycle!: WorkflowStepLifecycleExecutor<StepState>;
    const deps: WorkflowStepLifecycleExecutorDeps<StepState> = {
      cwd: this.cwd,
      runId,
      templateResolver: this.templateResolver,
      channelMessenger: this.channelMessenger,
      verificationRunner: (check, output, stepName, injectedTaskText, options) =>
        this.runVerification(check, output, stepName, injectedTaskText, options),
      postToChannel: (text) => this.postToChannel(text),
      persistStepRow: async (stepId, patch) => this.db.updateStep(stepId, patch),
      persistStepOutput: async (lifecycleRunId, stepName, output) =>
        this.persistStepOutput(lifecycleRunId, stepName, output),
      loadStepOutput: (lifecycleRunId, stepName) => this.loadStepOutput(lifecycleRunId, stepName),
      checkAborted: () => this.checkAborted(),
      waitIfPaused: () => this.waitIfPaused(),
      log: (message) => this.log(message),
      onStepStarted: async (step) => {
        this.emit({ type: 'step:started', runId, stepName: step.name });
      },
      onStepCompleted: async (step, state, result) => {
        this.emit({
          type: 'step:completed',
          runId,
          stepName: step.name,
          output: result.output,
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
        });
        this.finalizeStepEvidence(step.name, result.status, state.row.completedAt, result.completionReason);
      },
      onStepFailed: async (step, state, result) => {
        this.captureStepTerminalEvidence(
          step.name,
          {},
          {
            exitCode: result.exitCode,
            exitSignal: result.exitSignal,
          }
        );
        this.emit({
          type: 'step:failed',
          runId,
          stepName: step.name,
          error: result.error ?? 'Unknown error',
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
        });
        this.finalizeStepEvidence(step.name, 'failed', state.row.completedAt, result.completionReason);
      },
      executeStep: async (step, state) => {
        await this.executeStep(step, state, stepStates, agentMap, errorHandling, runId, lifecycle);
        return {
          status: state.row.status,
          output: state.row.output ?? '',
          completionReason: state.row.completionReason,
          retries: state.row.retryCount,
          error: state.row.error,
        };
      },
      onBeginTrack: async (steps) => {
        if (steps.length > 1 && this.trajectory) {
          await this.trajectory.beginTrack(steps.map((step) => step.name).join(', '));
        }
      },
      onConverge: async (readySteps, batchOutcomes) => {
        if (readySteps.length <= 1 || !this.trajectory?.shouldReflectOnConverge()) {
          return;
        }

        const completedNames = new Set(
          batchOutcomes.filter((outcome) => outcome.status === 'completed').map((outcome) => outcome.name)
        );
        const unblocked = workflow.steps
          .filter((step) => step.dependsOn?.some((dependency) => completedNames.has(dependency)))
          .filter((step) => stepStates.get(step.name)?.row.status === 'pending')
          .map((step) => step.name);

        await this.trajectory.synthesizeAndReflect(
          readySteps.map((step) => step.name).join(' + '),
          batchOutcomes,
          unblocked.length > 0 ? unblocked : undefined
        );
      },
      markDownstreamSkipped: async (failedStepName) =>
        this.markDownstreamSkipped(failedStepName, workflow.steps, stepStates, runId),
      buildCompletionMode: (stepName, completionReason) =>
        completionReason ? this.buildStepCompletionDecision(stepName, completionReason)?.mode : undefined,
    };

    lifecycle = new WorkflowStepLifecycleExecutor<StepState>(deps);
    return lifecycle;
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /** Execute a named workflow from a validated config. */
  async execute(
    config: RelayYamlConfig,
    workflowName?: string,
    vars?: VariableContext,
    executeOptions?: WorkflowExecuteOptions
  ): Promise<WorkflowRunRow> {
    // Set up abort controller early so callers can abort() even during setup
    this.abortController = new AbortController();
    this.paused = false;

    const resolved = this.applyPermissionProfiles(vars ? this.resolveVariables(config, vars) : config);

    // Validate config (catches cycles, missing deps, invalid steps, etc.)
    this.validateConfig(resolved);
    const runtimeConfig = this.applyReliabilityDefaults(resolved);

    const permissionResult = this.validatePermissions(
      runtimeConfig.agents,
      runtimeConfig.permission_profiles
    );
    if (permissionResult.errors.length > 0) {
      throw new Error(`Permission validation failed:\n  ${permissionResult.errors.join('\n  ')}`);
    }
    for (const warning of permissionResult.warnings) {
      console.warn(`[WorkflowRunner] Warning: ${warning}`);
    }

    // Resolve and validate named paths from the top-level `paths` config
    const pathResult = this.resolvePathDefinitions(runtimeConfig.paths, this.cwd);
    if (pathResult.errors.length > 0) {
      throw new Error(`Path validation failed:\n  ${pathResult.errors.join('\n  ')}`);
    }
    this.resolvedPaths = pathResult.resolved;
    if (this.resolvedPaths.size > 0) {
      for (const [name, abs] of this.resolvedPaths) {
        console.log(`[workflow] path "${name}" → ${abs}`);
      }
    }

    const workflows = runtimeConfig.workflows ?? [];

    const workflow = workflowName ? workflows.find((w) => w.name === workflowName) : workflows[0];

    if (!workflow) {
      throw new Error(
        workflowName ? `Workflow "${workflowName}" not found in config` : 'No workflows defined in config'
      );
    }

    // Load and resolve custom step definitions
    const customSteps = loadCustomSteps(this.cwd);
    const resolvedSteps = resolveAllCustomSteps(workflow.steps, customSteps);
    const resolvedWorkflow = { ...workflow, steps: resolvedSteps };

    const runId = this.generateId();
    const now = new Date().toISOString();

    const run: WorkflowRunRow = {
      id: runId,
      workspaceId: this.workspaceId,
      workflowName: resolvedWorkflow.name,
      pattern: runtimeConfig.swarm.pattern,
      status: 'pending',
      config: runtimeConfig,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insertRun(run);
    this.persistRunIdHint(runId);

    // Build step rows
    const stepStates = new Map<string, StepState>();
    for (const step of resolvedWorkflow.steps) {
      // Handle agent, deterministic, worktree, and integration steps
      const isNonAgent =
        step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration';

      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: isNonAgent ? null : (step.agent ?? null),
        stepType: isNonAgent ? (step.type as 'deterministic' | 'worktree' | 'integration') : 'agent',
        status: 'pending',
        task:
          step.type === 'deterministic'
            ? (step.command ?? '')
            : step.type === 'worktree'
              ? (step.branch ?? '')
              : step.type === 'integration'
                ? `${step.integration}.${step.action}`
                : (step.task ?? ''),
        dependsOn: step.dependsOn ?? [],
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insertStep(stepRow);
      stepStates.set(step.name, { row: stepRow });
    }

    // Handle startFrom: skip all transitive dependencies of the target step
    if (executeOptions?.startFrom) {
      const startFromName = executeOptions.startFrom;
      const stepNames = new Set(resolvedWorkflow.steps.map((s) => s.name));
      if (!stepNames.has(startFromName)) {
        throw new Error(
          `startFrom step "${startFromName}" not found in workflow. Available steps: ${[...stepNames].join(', ')}`
        );
      }

      const transitiveDeps = this.collectTransitiveDeps(startFromName, resolvedWorkflow.steps);
      const skippedCount = transitiveDeps.size;

      // Determine which run ID to load cached outputs from
      const cacheRunId = executeOptions.previousRunId ?? this.findMostRecentRunWithSteps(transitiveDeps);

      for (const depName of transitiveDeps) {
        const state = stepStates.get(depName);
        if (!state) continue;

        // Load cached output from a previous run if available
        const cachedOutput = cacheRunId ? this.loadStepOutput(cacheRunId, depName) : undefined;
        if (!cachedOutput) {
          this.log(`[startFrom] No cached output for skipped step "${depName}" — using empty string`);
        }

        state.row.status = 'completed';
        state.row.output = cachedOutput ?? '';
        state.row.completedAt = now;
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output: state.row.output,
          completedAt: now,
          updatedAt: now,
        });
      }

      if (skippedCount > 0) {
        this.log(`[startFrom] Skipping ${skippedCount} steps, starting from "${startFromName}"`);
      }
    }

    return this.runWorkflowCore({
      run,
      workflow: resolvedWorkflow,
      config: runtimeConfig,
      stepStates,
      isResume: false,
    });
  }

  /** Resume a previously paused or partially completed run. */
  async resume(runId: string, vars?: VariableContext, config?: RelayYamlConfig): Promise<WorkflowRunRow> {
    // Set up abort controller early so callers can abort() even during setup
    this.abortController = new AbortController();
    this.paused = false;

    let run = await this.db.getRun(runId);
    let stepStates = new Map<string, StepState>();
    if (!run) {
      const reconstructed = this.reconstructRunFromCache(runId, config);
      if (!reconstructed) {
        throw new Error(`Run "${runId}" not found (no database entry or cached step outputs)`);
      }
      this.log('[resume] Reconstructing run from cached step outputs (workflow-runs.jsonl missing)');
      run = reconstructed.run;
      stepStates = reconstructed.stepStates;
      await this.db.insertRun(run);
      for (const [, state] of stepStates) {
        await this.db.insertStep(state.row);
      }
    }
    this.persistRunIdHint(runId);

    if (run.status !== 'running' && run.status !== 'failed') {
      throw new Error(`Run "${runId}" is in status "${run.status}" and cannot be resumed`);
    }

    const resolvedConfig = this.applyReliabilityDefaults(
      vars ? this.resolveVariables(run.config, vars) : run.config
    );

    // Resolve path definitions (same as execute()) so workdir lookups work on resume
    const pathResult = this.resolvePathDefinitions(resolvedConfig.paths, this.cwd);
    if (pathResult.errors.length > 0) {
      throw new Error(`Path validation failed:\n  ${pathResult.errors.join('\n  ')}`);
    }
    this.resolvedPaths = pathResult.resolved;

    const workflows = resolvedConfig.workflows ?? [];
    const workflow = workflows.find((w) => w.name === run.workflowName);
    if (!workflow) {
      throw new Error(`Workflow "${run.workflowName}" not found in stored config`);
    }

    if (stepStates.size === 0) {
      const existingSteps = await this.db.getStepsByRunId(runId);
      for (const stepRow of existingSteps) {
        stepStates.set(stepRow.stepName, { row: stepRow });
      }
    }

    // Reset failed steps to pending for retry
    for (const [, state] of stepStates) {
      if (state.row.status === 'failed') {
        state.row.status = 'pending';
        state.row.error = undefined;
        state.row.completionReason = undefined;
        await this.db.updateStep(state.row.id, {
          status: 'pending',
          error: undefined,
          completionReason: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return this.runWorkflowCore({
      run,
      workflow,
      config: resolvedConfig,
      stepStates,
      isResume: true,
    });
  }

  private async runWorkflowCore(input: {
    run: WorkflowRunRow;
    workflow: WorkflowDefinition;
    config: RelayYamlConfig;
    stepStates: Map<string, StepState>;
    isResume: boolean;
  }): Promise<WorkflowRunRow> {
    const { run, workflow, config, stepStates, isResume } = input;
    const runId = run.id;

    // Start execution (abortController already set by execute()/resume())
    this.currentConfig = config;
    this.currentRunId = runId;
    this.runStartTime = Date.now();
    this.runtimeStepAgents.clear();
    this.stepCompletionEvidence.clear();
    this.agentReports.clear();
    this.initializeBudgetTracker(config, workflow);

    this.log(`Starting workflow "${workflow.name}" (${workflow.steps.length} steps)`);

    // Initialize trajectory recording
    this.trajectory = new WorkflowTrajectory(config.trajectories, runId, this.cwd);

    try {
      await this.updateRunStatus(runId, 'running');
      if (!isResume) {
        this.emit({ type: 'run:started', runId });
      }

      const pendingCount = [...stepStates.values()].filter((s) => s.row.status === 'pending').length;
      if (isResume) {
        await this.trajectory.start(
          workflow.name,
          workflow.steps.length,
          `Resumed run: ${pendingCount} pending steps of ${workflow.steps.length} total`,
          config.description,
          config.swarm.pattern
        );
      } else {
        // Analyze DAG for trajectory context on first run
        const dagInfo = this.analyzeDAG(workflow.steps);
        await this.trajectory.start(
          workflow.name,
          workflow.steps.length,
          dagInfo,
          config.description,
          config.swarm.pattern
        );
      }

      const channel =
        config.swarm.channel ??
        `wf-${this.sanitizeChannelName(config.name || run.workflowName)}-${this.generateShortId()}`;
      this.channel = channel;
      if (!config.swarm.channel) {
        config.swarm.channel = channel;
        await this.db.updateRun(runId, { config });
      }
      const relaycastDisabled = this.relayOptions.env?.AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST === '1';
      const requiresBroker =
        !this.executor &&
        workflow.steps.some(
          (step) => step.type !== 'deterministic' && step.type !== 'worktree' && step.type !== 'integration' && step.type !== 'waitFor'
        );
      // Skip broker/relay init when an external executor handles agent spawning
      if (requiresBroker) {
        if (!relaycastDisabled) {
          this.log('Resolving Relaycast API key...');
          await this.ensureRelaycastApiKey(channel);
          this.log('API key resolved');
          if (this.relayApiKeyAutoCreated) {
            for (const line of formatObserverGuidance(channel)) {
              this.log(line);
            }
          }
        }

        this.currentBrokerContext = {
          runId,
          brokerName: this.buildBrokerName(runId),
          channel,
          relaycastDisabled,
        };
        await this.startBroker(this.currentBrokerContext);

        this.relaycast = undefined;
        this.relaycastAgent = undefined;

        if (!relaycastDisabled) {
          this.log(`Creating channel: ${channel}...`);
          if (isResume) {
            await this.createAndJoinRelaycastChannel(channel);
          } else {
            await this.createAndJoinRelaycastChannel(channel, workflow.description);
          }
          this.log('Channel ready');

          if (isResume) {
            this.postToChannel(`Workflow **${workflow.name}** resumed — ${pendingCount} pending steps`);
          } else {
            this.postToChannel(
              `Workflow **${workflow.name}** started — ${workflow.steps.length} steps, pattern: ${config.swarm.pattern}`
            );
          }
        }
      }

      await this.startRelayfileEventSubscriptions(config);

      const agentMap = new Map<string, AgentDefinition>();
      for (const agent of config.agents) {
        agentMap.set(agent.name, agent);
      }

      // Run preflight checks before any steps (skip on resume)
      if (!isResume && workflow.preflight?.length) {
        await this.runPreflightChecks(workflow.preflight, runId);
      }

      await this.provisionAgents(config);

      this.log(`Executing ${workflow.steps.length} steps (pattern: ${config.swarm.pattern})`);
      await this.executeSteps(workflow, stepStates, agentMap, config.errorHandling, runId);

      // A run is successful iff every step completed or was skipped. Under
      // continue-on-error we keep executing past a failure, but the run
      // itself still "failed" — otherwise the final status contradicts the
      // summary table ("1 passed, 3 failed" but run.status=completed) and
      // downstream wrappers that key off run.status (e.g. the cloud
      // orchestrator's bootstrap) silently report success.
      const allCompleted = [...stepStates.values()].every(
        (s) => s.row.status === 'completed' || s.row.status === 'skipped'
      );

      if (allCompleted) {
        this.log('Workflow completed successfully');
        await this.updateRunStatus(runId, 'completed');
        this.emit({ type: 'run:completed', runId });

        const outcomes = this.collectOutcomes(stepStates, workflow.steps);
        const summary = this.trajectory.buildRunSummary(outcomes);
        const confidence = this.trajectory.computeConfidence(outcomes);
        await this.trajectory.complete(summary, confidence, {
          learnings: this.trajectory.extractLearnings(outcomes),
          challenges: this.trajectory.extractChallenges(outcomes),
        });

        this.postCompletionReport(workflow.name, outcomes, summary, confidence);
        this.logRunSummary(workflow.name, outcomes, runId, 'completed');
      } else {
        const failedStep = [...stepStates.values()].find((s) => s.row.status === 'failed');
        const errorMsg = failedStep?.row.error ?? 'One or more steps failed';
        const needsHumanStep = this.findNeedsHumanExhaustedStep(config.errorHandling, stepStates);

        if (needsHumanStep) {
          await this.completeNeedsHumanRun(runId, workflow, stepStates, needsHumanStep);
        } else {
          await this.updateRunStatus(runId, 'failed', errorMsg);
          this.emit({ type: 'run:failed', runId, error: errorMsg });

          const outcomes = this.collectOutcomes(stepStates, workflow.steps);
          const summary = this.trajectory.buildRunSummary(outcomes);
          const confidence = this.trajectory.computeConfidence(outcomes);
          const learnings = this.trajectory.extractLearnings(outcomes);
          const challenges = this.trajectory.extractChallenges(outcomes);
          this.postFailureReport(workflow.name, outcomes, errorMsg);
          this.logRunSummary(workflow.name, outcomes, runId, 'failed');
          await this.trajectory.abandon(errorMsg, {
            summary,
            confidence,
            learnings,
            challenges,
          });
        }
      }
    } catch (err) {
      if (process.env.RF_DEBUG_STACK) console.error('RF_DEBUG_STACK_EXEC', (err as Error)?.stack);
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = !isResume && this.abortController?.signal.aborted;

      if (isCancelled) {
        await this.updateRunStatus(runId, 'cancelled', errorMsg);
        // Mark any pending or in-progress steps as failed due to cancellation
        for (const [stepName, state] of stepStates) {
          if (state.row.status === 'pending' || state.row.status === 'running') {
            state.row.status = 'failed';
            state.row.error = 'Cancelled';
            await this.db.updateStep(state.row.id, {
              status: 'failed',
              error: 'Cancelled',
              updatedAt: new Date().toISOString(),
            });
            this.emit({ type: 'step:failed', runId, stepName, error: 'Cancelled' });
            this.finalizeStepEvidence(stepName, 'failed');
          }
        }
        this.emit({ type: 'run:cancelled', runId });
        this.postToChannel(`Workflow **${workflow.name}** cancelled`);
        await this.trajectory.abandon('Cancelled by user');
      } else {
        const needsHumanStep = this.findNeedsHumanExhaustedStep(config.errorHandling, stepStates);
        if (needsHumanStep) {
          await this.completeNeedsHumanRun(runId, workflow, stepStates, needsHumanStep);
        } else {
          await this.updateRunStatus(runId, 'failed', errorMsg);
          this.emit({ type: 'run:failed', runId, error: errorMsg });
          this.postToChannel(`Workflow failed: ${errorMsg}`);
          const outcomes = this.collectOutcomes(stepStates, workflow.steps);
          await this.trajectory.abandon(errorMsg, {
            summary: this.trajectory.buildRunSummary(outcomes),
            confidence: this.trajectory.computeConfidence(outcomes),
            learnings: this.trajectory.extractLearnings(outcomes),
            challenges: this.trajectory.extractChallenges(outcomes),
          });
        }
      }
    } finally {
      this.lastFailedStepOutput.clear();
      this.lastCustomVerificationFailure.clear();
      for (const stream of this.ptyLogStreams.values()) stream.end();
      this.ptyLogStreams.clear();
      this.ptyOutputBuffers.clear();
      this.ptyListeners.clear();

      this.unsubBrokerStderr?.();
      this.unsubBrokerStderr = undefined;

      this.clearRelayListeners();
      this.lastIdleLog.clear();
      this.lastActivity.clear();
      this.clearPendingHumanQuestionDrafts();
      this.pendingHumanQuestions.clear();
      this.seenHumanQuestionKeys.clear();
      this.answeredHumanQuestionKeys.clear();
      this.supervisedRuntimeAgents.clear();
      this.runtimeStepAgents.clear();
      this.activeReviewers.clear();

      await this.stopRelayfileEventSubscriptions();

      this.log('Shutting down broker...');
      await this.shutdownRelay();
      this.currentBrokerContext = undefined;
      this.brokerRecoveryPromise = undefined;
      this.runStartTime = undefined;
      this.relaycast = undefined;
      this.relaycastAgent = undefined;
      this.channel = undefined;
      this.trajectory = undefined;
      this.abortController = undefined;
      this.currentConfig = undefined;
      this.currentRunId = undefined;
      this.activeAgentHandles.clear();
      this.relayfileClient = undefined;
      this.relayfileRuntimeConfig = undefined;
      this.relayfileEventSubscriptions.length = 0;
      this.seenRelayfileEventIds.clear();
      this.relayfileEventWaiters.length = 0;
      await this.stopRelayfileIntegrationMount();
      await this.stopProvisionedMounts();
      this.agentTokens.clear(); // Prevent workflow-scoped tokens from leaking into a later run.
    }

    const finalRun = await this.db.getRun(runId);
    return finalRun ?? run;
  }

  /** Pause execution. Currently-running steps will finish but no new steps start. */
  pause(): void {
    this.paused = true;
  }

  /** Resume after a pause(). */
  unpause(): void {
    this.paused = false;
    this.pauseResolver?.();
    this.pauseResolver = undefined;
  }

  /** Abort the current run. Running agents are released. */
  abort(): void {
    // Unblock waitIfPaused() so the run loop can exit
    this.pauseResolver?.();
    this.pauseResolver = undefined;
    this.abortController?.abort();
  }

  // ── Step execution engine ─────────────────────────────────────────────

  private async executeSteps(
    workflow: WorkflowDefinition,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): Promise<void> {
    const rawStrategy = errorHandling?.strategy ?? workflow.onError ?? 'fail-fast';
    const strategy =
      rawStrategy === 'fail'
        ? 'fail-fast'
        : rawStrategy === 'skip'
          ? 'continue'
          : rawStrategy === 'retry'
            ? 'fail-fast'
            : rawStrategy;

    const lifecycle = this.createStepLifecycleExecutor(workflow, stepStates, agentMap, errorHandling, runId);

    await lifecycle.executeAll(
      workflow.steps,
      agentMap,
      {
        ...(errorHandling ?? { strategy: 'fail-fast' }),
        strategy,
      },
      stepStates
    );
  }

  private findReadySteps(steps: WorkflowStep[], stepStates: Map<string, StepState>): WorkflowStep[] {
    return steps.filter((step) => {
      const state = stepStates.get(step.name);
      if (!state || state.row.status !== 'pending') return false;

      const deps = step.dependsOn ?? [];
      return deps.every((dep) => {
        const depState = stepStates.get(dep);
        return depState && (depState.row.status === 'completed' || depState.row.status === 'skipped');
      });
    });
  }

  /**
   * Execute preflight checks before any workflow steps.
   * All checks must pass or the workflow fails immediately.
   */
  private async runPreflightChecks(checks: PreflightCheck[], runId: string): Promise<void> {
    this.postToChannel(`Running ${checks.length} preflight check(s)...`);

    for (const check of checks) {
      this.checkAborted();

      const description = check.description ?? check.command.slice(0, 50);
      this.postToChannel(`**[preflight]** ${description}`);

      try {
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('sh', ['-c', check.command], {
            stdio: 'pipe',
            cwd: this.cwd,
            env: filteredEnv(),
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          // Wire abort signal
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

          // 30s timeout for preflight checks
          const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Preflight check timed out: ${description}`));
          }, 30_000);

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          child.on('close', (code) => {
            clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error('Preflight check aborted'));
              return;
            }

            // Non-zero exit code is a failure
            if (code !== 0 && code !== null) {
              const stderr = stderrChunks.join('');
              reject(
                new Error(`Preflight check failed (exit ${code})${stderr ? `: ${stderr.slice(0, 200)}` : ''}`)
              );
              return;
            }

            resolve(stdoutChunks.join(''));
          });

          child.on('error', (err) => {
            clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }
            reject(new Error(`Preflight check error: ${err.message}`));
          });
        });

        // Check failIf condition
        if (check.failIf) {
          const trimmedOutput = output.trim();
          if (check.failIf === 'non-empty' && trimmedOutput.length > 0) {
            throw new Error(`Preflight failed: output is non-empty\n${trimmedOutput.slice(0, 200)}`);
          }
          if (check.failIf === 'empty' && trimmedOutput.length === 0) {
            throw new Error('Preflight failed: output is empty');
          }
          // Treat as regex pattern
          if (check.failIf !== 'non-empty' && check.failIf !== 'empty') {
            const regex = new RegExp(check.failIf);
            if (regex.test(output)) {
              throw new Error(`Preflight failed: output matches pattern "${check.failIf}"`);
            }
          }
        }

        // Check successIf condition
        if (check.successIf) {
          const regex = new RegExp(check.successIf);
          if (!regex.test(output)) {
            throw new Error(`Preflight failed: output does not match required pattern "${check.successIf}"`);
          }
        }

        this.postToChannel(`**[preflight]** ${description} — passed`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.postToChannel(`**[preflight]** ${description} — FAILED: ${errorMsg}`);
        throw new Error(`Preflight check failed: ${errorMsg}`);
      }
    }

    this.postToChannel('All preflight checks passed');
  }

  /** Check if a step is deterministic (shell command) vs agent (LLM-powered). */
  private isDeterministicStep(step: WorkflowStep): boolean {
    return step.type === 'deterministic';
  }

  /** Check if a step is a worktree (git worktree setup) step. */
  private isWorktreeStep(step: WorkflowStep): boolean {
    return step.type === 'worktree';
  }

  /** Check if a step is an integration (external service) step. */
  private isIntegrationStep(step: WorkflowStep): boolean {
    return step.type === 'integration';
  }

  /** Check if a step is a Relayfile event gate. */
  private isWaitForStep(step: WorkflowStep): boolean {
    return step.type === 'waitFor';
  }

  private async executeStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    // Branch: deterministic steps execute shell commands
    if (this.isDeterministicStep(step)) {
      return this.executeDeterministicStep(
        step,
        state,
        stepStates,
        agentMap,
        runId,
        errorHandling,
        lifecycle
      );
    }

    // Branch: worktree steps set up git worktrees
    if (this.isWorktreeStep(step)) {
      return this.executeWorktreeStep(step, state, stepStates, runId, lifecycle);
    }

    // Branch: integration steps interact with external services
    if (this.isIntegrationStep(step)) {
      return this.executeIntegrationStep(step, state, stepStates, runId, lifecycle);
    }

    // Branch: event gates block until a matching Relayfile integration event arrives
    if (this.isWaitForStep(step)) {
      return this.executeWaitForStep(step, state, stepStates, runId, lifecycle);
    }

    // Agent step execution
    return this.executeAgentStep(step, stepStates, agentMap, errorHandling, runId);
  }

  /**
   * Execute a deterministic step (shell command).
   * Fast, reliable, $0 LLM cost.
   */
  private async executeDeterministicStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    runId: string,
    errorHandling: ErrorHandlingConfig | undefined,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    const repairRetries = errorHandling?.strategy === 'retry' ? (errorHandling.repairRetries ?? 0) : 0;
    const repairAgent =
      repairRetries > 0
        ? this.resolveWorkflowRepairAgent(step, stepStates, agentMap, errorHandling)
        : undefined;
    const maxRetries = step.retries ?? errorHandling?.maxRetries ?? (repairAgent ? repairRetries : 0);
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    let lastError = 'Unknown error';
    let lastCompletionReason: WorkflowStepCompletionReason | undefined;
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;
    let lastResolvedCommand = step.command ?? '';
    let lastStepCwd = this.cwd;
    let lastCommandOutput = '';

    const result = await lifecycle.monitorStep(step, state, {
      maxRetries,
      retryDelayMs: retryDelay,
      startMessage: `**[${step.name}]** Started (deterministic)`,
      onRetry: async (attempt, total) => {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${total + 1})`);
        this.recordStepToolSideEffect(step.name, {
          type: 'retry',
          detail: `Retrying attempt ${attempt + 1}/${total + 1}`,
          raw: { attempt, maxRetries: total },
        });
        if (repairAgent) {
          await this.runDeterministicRepairAgent({
            step,
            agentDef: repairAgent,
            attempt,
            maxRetries: total,
            command: lastResolvedCommand,
            cwd: lastStepCwd,
            error: lastError,
            output: lastCommandOutput,
            exitCode: lastExitCode,
            exitSignal: lastExitSignal,
          });
        }
      },
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        let resolvedCommand = this.interpolateStepTask(step.command ?? '', stepOutputContext);

        resolvedCommand = resolvedCommand.replace(/\{\{([\w][\w.\-]*)\}\}/g, (_match, key: string) => {
          if (key.startsWith('steps.')) return _match;
          const value = this.resolveDotPath(key, stepOutputContext);
          return value !== undefined ? String(value) : _match;
        });

        const stepCwd = this.resolveEffectiveCwd(step);
        lastResolvedCommand = resolvedCommand;
        lastStepCwd = stepCwd;
        this.beginStepEvidence(step.name, [stepCwd], state.row.startedAt);
        this.log(
          `[${step.name}] Running: ${resolvedCommand.slice(0, 200)}${resolvedCommand.length > 200 ? '...' : ''}`
        );

        if (this.executor?.executeDeterministicStep) {
          const executorResult = await this.executor.executeDeterministicStep(step, resolvedCommand, stepCwd);
          lastExitCode = executorResult.exitCode;
          lastExitSignal = undefined;
          lastCommandOutput = executorResult.output;
          const failOnError = step.failOnError !== false;
          if (failOnError && executorResult.exitCode !== 0) {
            this.log(`[${step.name}] Command failed (exit code ${executorResult.exitCode})`);
            if (executorResult.output) {
              this.log(`[${step.name}] Output:\n${executorResult.output}`);
            }
            throw new Error(
              `Command failed with exit code ${executorResult.exitCode}: ${executorResult.output.slice(0, 500)}`
            );
          }
          const output =
            step.captureOutput !== false
              ? executorResult.output
              : `Command completed (exit code ${executorResult.exitCode})`;
          this.captureStepTerminalEvidence(
            step.name,
            { stdout: executorResult.output, combined: executorResult.output },
            { exitCode: executorResult.exitCode }
          );
          const verificationResult = step.verification
            ? this.runVerification(step.verification, output, step.name)
            : undefined;
          return {
            output,
            completionReason: verificationResult?.completionReason,
          };
        }

        let commandStdout = '';
        let commandStderr = '';
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('sh', ['-c', resolvedCommand], {
            stdio: 'pipe',
            cwd: stepCwd,
            env: filteredEnv(),
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (step.timeoutMs) {
            timer = setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            }, step.timeoutMs);
          }

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error(`Step "${step.name}" aborted`));
              return;
            }

            if (timedOut) {
              reject(
                new Error(`Step "${step.name}" timed out (no step timeout set, check global swarm.timeoutMs)`)
              );
              return;
            }

            const stdout = stdoutChunks.join('');
            const stderr = stderrChunks.join('');
            commandStdout = stdout;
            commandStderr = stderr;
            lastExitCode = code ?? undefined;
            lastExitSignal = signal ?? undefined;
            lastCommandOutput = [stdout, stderr].filter(Boolean).join('\n');

            const failOnError = step.failOnError !== false;
            if (failOnError && code !== 0 && code !== null) {
              this.log(`[${step.name}] Command failed (exit code ${code})`);
              if (stdout) {
                this.log(`[${step.name}] stdout:\n${stdout}`);
              }
              if (stderr) {
                this.log(`[${step.name}] stderr:\n${stderr}`);
              }
              reject(
                new Error(`Command failed with exit code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`)
              );
              return;
            }

            resolve(step.captureOutput !== false ? stdout : `Command completed (exit code ${code ?? 0})`);
          });

          child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }
            reject(new Error(`Failed to execute command: ${err.message}`));
          });
        });

        this.captureStepTerminalEvidence(
          step.name,
          {
            stdout: commandStdout || output,
            stderr: commandStderr,
            combined: [commandStdout || output, commandStderr].filter(Boolean).join('\n'),
          },
          { exitCode: lastExitCode, exitSignal: lastExitSignal }
        );

        const verificationResult = step.verification
          ? this.runVerification(step.verification, output, step.name)
          : undefined;
        lastCommandOutput = [commandStdout || output, commandStderr].filter(Boolean).join('\n');

        return {
          output,
          completionReason: verificationResult?.completionReason,
        };
      },
      toCompletionResult: ({ output, completionReason }, attempt) => ({
        status: 'completed',
        output,
        completionReason,
        retries: attempt,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
      onAttemptFailed: async (error) => {
        if (process.env.RF_DEBUG_STACK) console.error('RF_DEBUG_STACK', (error as Error)?.stack);
        lastError = error instanceof Error ? error.message : String(error);
        lastCompletionReason = error instanceof WorkflowCompletionError ? error.completionReason : undefined;
        if (lastCommandOutput) {
          this.lastFailedStepOutput.set(step.name, lastCommandOutput);
        }
      },
      getFailureResult: () => ({
        status: 'failed',
        output: '',
        error: lastError,
        retries: state.row.retryCount,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
        completionReason: lastCompletionReason,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }
  }

  private resolveWorkflowRepairAgent(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined
  ): AgentDefinition | undefined {
    const explicitName = errorHandling?.repairAgent?.trim();
    if (explicitName) {
      const explicitAgent = agentMap.get(explicitName);
      if (explicitAgent) return WorkflowRunner.resolveAgentDef(explicitAgent);
      this.log(`[${step.name}] repairAgent "${explicitName}" not found; falling back to workflow agents`);
    }

    if (step.agent) {
      const stepAgent = agentMap.get(step.agent);
      if (stepAgent) return WorkflowRunner.resolveAgentDef(stepAgent);
    }

    for (const dependency of [...(step.dependsOn ?? [])].reverse()) {
      const dependencyAgent = stepStates.get(dependency)?.row.agentName;
      if (!dependencyAgent) continue;
      const agent = agentMap.get(dependencyAgent);
      if (agent) return WorkflowRunner.resolveAgentDef(agent);
    }

    const candidates = [...agentMap.values()].map((agent) => WorkflowRunner.resolveAgentDef(agent));
    candidates.sort((a, b) => this.scoreRepairAgent(b) - this.scoreRepairAgent(a));
    return candidates[0];
  }

  private scoreRepairAgent(agent: AgentDefinition): number {
    const text = `${agent.name} ${agent.role ?? ''} ${agent.preset ?? ''}`.toLowerCase();
    let score = 0;
    if (
      /\b(repair|fix|implement|implementation|engineer|developer|coder|worker|owner|lead|coordinator)\b/.test(
        text
      )
    ) {
      score += 10;
    }
    if (agent.interactive === false || ['worker', 'analyst'].includes(agent.preset ?? '')) {
      score += 2;
    }
    if (/\b(review|reviewer|audit|security|analyst)\b/.test(text)) {
      score -= 4;
    }
    if (agent.permissions?.access === 'readonly') {
      score -= 20;
    }
    return score;
  }

  private async runDeterministicRepairAgent(context: DeterministicRepairContext): Promise<void> {
    const repairAgent: AgentDefinition = {
      ...context.agentDef,
      interactive: false,
    };
    const repairPrompt = this.buildDeterministicRepairPrompt(context);
    const repairStep: WorkflowStep = {
      name: `${context.step.name}-repair-${context.attempt}`,
      type: 'agent',
      agent: repairAgent.name,
      task: repairPrompt,
      cwd: context.cwd,
      workdir: undefined,
      retries: 0,
    };
    const timeoutMs =
      repairAgent.constraints?.timeoutMs ?? context.step.timeoutMs ?? this.currentConfig?.swarm?.timeoutMs;

    this.log(
      `[${context.step.name}] Deterministic gate failed; asking "${repairAgent.name}" to repair before retry ${context.attempt + 1}/${context.maxRetries + 1}`
    );
    this.postToChannel(
      `**[${context.step.name}]** Deterministic gate failed; assigning repair to \`${repairAgent.name}\``
    );
    this.recordStepToolSideEffect(context.step.name, {
      type: 'custom',
      detail: `Assigned deterministic gate repair to ${repairAgent.name}`,
      raw: {
        repairAgent: repairAgent.name,
        attempt: context.attempt,
        maxRetries: context.maxRetries,
        exitCode: context.exitCode,
        exitSignal: context.exitSignal,
      },
    });

    try {
      this.ensureBudgetAllowsSpawn(context.step.name, repairAgent.name);
      let repairOutput: string;
      if (this.executor) {
        repairOutput = await this.executor.executeAgentStep(repairStep, repairAgent, repairPrompt, timeoutMs);
      } else if (repairAgent.cli === 'api') {
        repairOutput = await executeApiStep(
          repairAgent.constraints?.model ?? 'claude-sonnet-4-20250514',
          repairPrompt,
          {
            envSecrets: this.envSecrets,
            skills: repairAgent.skills,
            defaultMaxTokens: repairAgent.constraints?.maxTokens,
          }
        );
      } else {
        const result = await this.execNonInteractive(repairAgent, repairStep, timeoutMs);
        repairOutput = result.output;
      }

      this.recordStepToolSideEffect(context.step.name, {
        type: 'custom',
        detail: `Repair agent ${repairAgent.name} completed before deterministic retry`,
        raw: { repairAgent: repairAgent.name, output: repairOutput.slice(0, 1000) },
      });
    } catch (error) {
      if (error instanceof BudgetExceededError || this.abortController?.signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[${context.step.name}] Repair agent "${repairAgent.name}" failed: ${message}`);
      this.postToChannel(
        `**[${context.step.name}]** Repair agent \`${repairAgent.name}\` failed; retrying gate anyway`
      );
      this.recordStepToolSideEffect(context.step.name, {
        type: 'custom',
        detail: `Repair agent ${repairAgent.name} failed before deterministic retry: ${message}`,
        raw: { repairAgent: repairAgent.name, error: message },
      });
    }
  }

  private buildDeterministicRepairPrompt(context: DeterministicRepairContext): string {
    const output = context.output.trim();
    const clippedOutput = output.length > 4000 ? output.slice(-4000) : output;
    return (
      `A deterministic workflow gate failed after an agent/team step. Fix the repository or workflow state so the same gate passes on the next retry.\n\n` +
      `Step: ${context.step.name}\n` +
      `Working directory: ${context.cwd}\n` +
      `Command:\n${context.command}\n\n` +
      `Failure:\n${context.error}\n` +
      `Exit code: ${context.exitCode ?? 'unknown'}\n` +
      `Exit signal: ${context.exitSignal ?? 'none'}\n\n` +
      `Command output:\n${clippedOutput || '(no output captured)'}\n\n` +
      `Repair only what is needed for this gate to pass. Preserve unrelated user changes. ` +
      `After making the fix, report the files changed and the reason the gate should pass.`
    );
  }

  private async runAgentStepRepairAgent(context: AgentStepRepairContext): Promise<void> {
    const repairAgent: AgentDefinition = {
      ...context.agentDef,
      interactive: false,
    };
    const repairPrompt = this.buildAgentStepRepairPrompt(context);
    const repairStep: WorkflowStep = {
      name: `${context.step.name}-repair-${context.attempt}`,
      type: 'agent',
      agent: repairAgent.name,
      task: repairPrompt,
      cwd: context.cwd,
      workdir: undefined,
      retries: 0,
    };
    const timeoutMs =
      repairAgent.constraints?.timeoutMs ?? context.step.timeoutMs ?? this.currentConfig?.swarm?.timeoutMs;

    this.log(
      `[${context.step.name}] Agent step failed; asking "${repairAgent.name}" to repair before retry ${context.attempt + 1}/${context.maxRetries + 1}`
    );
    this.postToChannel(
      `**[${context.step.name}]** Agent step failed; assigning repair to \`${repairAgent.name}\``
    );
    this.recordStepToolSideEffect(context.step.name, {
      type: 'custom',
      detail: `Assigned agent-step repair to ${repairAgent.name}`,
      raw: {
        repairAgent: repairAgent.name,
        attempt: context.attempt,
        maxRetries: context.maxRetries,
        completionReason: context.completionReason,
        exitCode: context.exitCode,
        exitSignal: context.exitSignal,
      },
    });

    try {
      this.ensureBudgetAllowsSpawn(context.step.name, repairAgent.name);
      let repairOutput: string;
      if (this.executor) {
        repairOutput = await this.executor.executeAgentStep(repairStep, repairAgent, repairPrompt, timeoutMs);
      } else if (repairAgent.cli === 'api') {
        repairOutput = await executeApiStep(
          repairAgent.constraints?.model ?? 'claude-sonnet-4-20250514',
          repairPrompt,
          {
            envSecrets: this.envSecrets,
            skills: repairAgent.skills,
            defaultMaxTokens: repairAgent.constraints?.maxTokens,
          }
        );
      } else {
        const result = await this.execNonInteractive(repairAgent, repairStep, timeoutMs);
        repairOutput = result.output;
      }

      this.recordStepToolSideEffect(context.step.name, {
        type: 'custom',
        detail: `Repair agent ${repairAgent.name} completed before agent retry`,
        raw: { repairAgent: repairAgent.name, output: repairOutput.slice(0, 1000) },
      });
    } catch (error) {
      if (error instanceof BudgetExceededError || this.abortController?.signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[${context.step.name}] Repair agent "${repairAgent.name}" failed: ${message}`);
      this.postToChannel(
        `**[${context.step.name}]** Repair agent \`${repairAgent.name}\` failed; retrying agent step anyway`
      );
      this.recordStepToolSideEffect(context.step.name, {
        type: 'custom',
        detail: `Repair agent ${repairAgent.name} failed before agent retry: ${message}`,
        raw: { repairAgent: repairAgent.name, error: message },
      });
    }
  }

  private buildAgentStepRepairPrompt(context: AgentStepRepairContext): string {
    const output = context.output.trim();
    const clippedOutput = output.length > 4000 ? output.slice(-4000) : output;
    const task = (context.step.task ?? '').trim();
    const clippedTask = task.length > 3000 ? task.slice(0, 3000) : task;
    return (
      `A workflow agent step failed or produced an invalid artifact. Repair the repository, workflow state, or step instructions so the step can succeed on the next retry.\n\n` +
      `Step: ${context.step.name}\n` +
      `Working directory: ${context.cwd}\n` +
      `Completion reason: ${context.completionReason ?? 'unknown'}\n` +
      `Failure:\n${context.error}\n` +
      `Exit code: ${context.exitCode ?? 'unknown'}\n` +
      `Exit signal: ${context.exitSignal ?? 'none'}\n\n` +
      `Step task:\n${clippedTask || '(no task captured)'}\n\n` +
      `Previous output:\n${clippedOutput || '(no output captured)'}\n\n` +
      `Repair only what is needed for this step to produce the required artifact or evidence. ` +
      `Preserve unrelated user changes. After making the fix, report the files changed and why the retry should pass.`
    );
  }

  /**
   * Execute a worktree step (git worktree setup).
   * Fast, reliable, $0 LLM cost.
   * Outputs the worktree path for downstream steps to use.
   */
  private async executeWorktreeStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;
    let worktreeBranch = '';
    let createdBranch = false;

    const result = await lifecycle.monitorStep(step, state, {
      startMessage: `**[${step.name}]** Started (worktree setup)`,
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        const branch = this.interpolateStepTask(step.branch ?? '', stepOutputContext);
        const baseBranch = step.baseBranch
          ? this.interpolateStepTask(step.baseBranch, stepOutputContext)
          : 'HEAD';
        const worktreePath = step.path
          ? this.interpolateStepTask(step.path, stepOutputContext)
          : path.join('.worktrees', step.name);
        const createBranch = step.createBranch !== false;
        const stepCwd = this.resolveStepWorkdir(step) ?? this.cwd;

        this.beginStepEvidence(step.name, [stepCwd], state.row.startedAt);

        if (!branch) {
          throw new Error('Worktree step missing required "branch" field');
        }

        const absoluteWorktreePath = path.resolve(stepCwd, worktreePath);
        let branchExists = false;

        await new Promise<void>((resolve) => {
          const checkChild = cpSpawn('git', ['rev-parse', '--verify', '--quiet', branch], {
            stdio: 'pipe',
            cwd: stepCwd,
            env: filteredEnv(),
          });
          checkChild.on('close', (code) => {
            branchExists = code === 0;
            resolve();
          });
          checkChild.on('error', () => resolve());
        });

        let worktreeArgs: string[];
        if (branchExists) {
          worktreeArgs = ['worktree', 'add', absoluteWorktreePath, branch];
        } else if (createBranch) {
          worktreeArgs = ['worktree', 'add', '-b', branch, absoluteWorktreePath, baseBranch];
        } else {
          throw new Error(`Branch "${branch}" does not exist and createBranch is false`);
        }

        let commandStdout = '';
        let commandStderr = '';
        const output = await new Promise<string>((resolve, reject) => {
          const child = cpSpawn('git', worktreeArgs, {
            stdio: 'pipe',
            cwd: stepCwd,
            env: filteredEnv(),
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];
          const abortSignal = this.abortController?.signal;
          let abortHandler: (() => void) | undefined;
          if (abortSignal && !abortSignal.aborted) {
            abortHandler = () => {
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            };
            abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

          let timedOut = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (step.timeoutMs) {
            timer = setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
            }, step.timeoutMs);
          }

          child.stdout?.on('data', (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });

          child.stderr?.on('data', (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }

            if (abortSignal?.aborted) {
              reject(new Error(`Step "${step.name}" aborted`));
              return;
            }

            if (timedOut) {
              reject(
                new Error(`Step "${step.name}" timed out (no step timeout set, check global swarm.timeoutMs)`)
              );
              return;
            }

            commandStdout = stdoutChunks.join('');
            commandStderr = stderrChunks.join('');
            lastExitCode = code ?? undefined;
            lastExitSignal = signal ?? undefined;

            if (code !== 0 && code !== null) {
              reject(
                new Error(
                  `git worktree add failed with exit code ${code}${commandStderr ? `: ${commandStderr.slice(0, 500)}` : ''}`
                )
              );
              return;
            }

            resolve(absoluteWorktreePath);
          });

          child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            if (abortHandler && abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }
            reject(new Error(`Failed to execute git worktree command: ${err.message}`));
          });
        });

        this.captureStepTerminalEvidence(
          step.name,
          {
            stdout: commandStdout || output,
            stderr: commandStderr,
            combined: [commandStdout || output, commandStderr].filter(Boolean).join('\n'),
          },
          { exitCode: lastExitCode, exitSignal: lastExitSignal }
        );

        worktreeBranch = branch;
        createdBranch = !branchExists && createBranch;
        return { output };
      },
      toCompletionResult: ({ output }, attempt) => ({
        status: 'completed',
        output,
        retries: attempt,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
      getFailureResult: (error) => ({
        status: 'failed',
        output: '',
        error: (() => { if (error instanceof Error && /reading 'get'/.test(error.message)) console.error('DEBUG_STACK>>>', error.stack); return error instanceof Error ? error.message : String(error); })(),
        retries: state.row.retryCount,
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }

    this.postToChannel(
      `**[${step.name}]** Worktree created at: ${result.output}\n  Branch: ${worktreeBranch}${createdBranch ? ' (created)' : ''}`
    );
    this.recordStepToolSideEffect(step.name, {
      type: 'worktree_created',
      detail: `Worktree created at ${result.output}`,
      raw: { branch: worktreeBranch, createdBranch },
    });
  }

  /**
   * Execute an integration step (external service interaction via executor).
   */
  private async executeIntegrationStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    const result = await lifecycle.monitorStep(step, state, {
      startMessage: `**[${step.name}]** Started (integration: ${step.integration}.${step.action})`,
      execute: async () => {
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        const resolvedParams: Record<string, string> = {};
        for (const [key, value] of Object.entries(step.params ?? {})) {
          resolvedParams[key] = this.interpolateStepTask(value, stepOutputContext);
        }

        if (!this.executor?.executeIntegrationStep) {
          throw new Error(
            `Integration steps require a cloud executor. Step "${step.name}" cannot run locally. ` +
              `Use "cloud run" to execute workflows with integration steps.`
          );
        }

        const integrationResult = await this.executor.executeIntegrationStep(step, resolvedParams, {
          workspaceId: this.workspaceId,
          injectAnswerToAgent: (input) => this.injectAnswerToAgent(input),
        });

        if (!integrationResult.success) {
          throw new Error(`Integration step "${step.name}" failed: ${integrationResult.output}`);
        }

        return { output: integrationResult.output };
      },
      toCompletionResult: ({ output }, attempt) => ({
        status: 'completed',
        output,
        retries: attempt,
      }),
      getFailureResult: (error) => ({
        status: 'failed',
        output: '',
        error: (() => { if (error instanceof Error && /reading 'get'/.test(error.message)) console.error('DEBUG_STACK>>>', error.stack); return error instanceof Error ? error.message : String(error); })(),
        retries: state.row.retryCount,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }

    this.postToChannel(`**[${step.name}]** Completed (integration: ${step.integration}.${step.action})`);
  }

  /**
   * Execute a waitFor step by suspending until a matching Relayfile event arrives.
   */
  private async executeWaitForStep(
    step: WorkflowStep,
    state: StepState,
    stepStates: Map<string, StepState>,
    runId: string,
    lifecycle: WorkflowStepLifecycleExecutor<StepState>
  ): Promise<void> {
    const result = await lifecycle.monitorStep(step, state, {
      startMessage: `**[${step.name}]** Waiting for integration event`,
      execute: async () => {
        const gate = step.waitFor;
        if (!gate) {
          throw new Error(`waitFor step "${step.name}" requires a waitFor event selector`);
        }

        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        const paths = this.resolveSubscriptionPaths({
          path: gate.path ? this.interpolateStepTask(gate.path, stepOutputContext) : undefined,
          paths: gate.paths?.map((entry) => this.interpolateStepTask(entry, stepOutputContext)),
        });
        if (paths.length === 0) {
          throw new Error(`waitFor step "${step.name}" requires waitFor.path or waitFor.paths`);
        }

        const subscription: ResolvedRelayfileSubscription = {
          name: `${step.name}.waitFor`,
          paths,
          events: this.normalizeRelayfileEventFilters(gate.events ?? (gate.event ? [gate.event] : undefined)),
          provider: gate.provider,
          source: 'workflow',
        };
        const event = await this.waitForRelayfileEvent(subscription, gate.timeoutMs ?? step.timeoutMs);
        return { output: JSON.stringify(this.serializeRelayfileEvent(event), null, 2) };
      },
      toCompletionResult: ({ output }, attempt) => ({
        status: 'completed',
        output,
        retries: attempt,
      }),
      getFailureResult: (error) => ({
        status: 'failed',
        output: '',
        error: error instanceof Error ? error.message : String(error),
        retries: state.row.retryCount,
      }),
    });

    if (result.status === 'failed') {
      this.postToChannel(`**[${step.name}]** Failed: ${result.error ?? 'Unknown error'}`);
      throw new Error(`Step "${step.name}" failed: ${result.error ?? 'Unknown error'}`);
    }

    this.postToChannel(`**[${step.name}]** Event gate satisfied`);
  }

  /**
   * Execute an agent step (LLM-powered).
   */
  private async executeAgentStep(
    step: WorkflowStep,
    stepStates: Map<string, StepState>,
    agentMap: Map<string, AgentDefinition>,
    errorHandling: ErrorHandlingConfig | undefined,
    runId: string
  ): Promise<void> {
    const state = stepStates.get(step.name);
    if (!state) throw new Error(`Step state not found: ${step.name}`);

    const agentName = step.agent;
    if (!agentName) {
      throw new Error(`Step "${step.name}" is missing required "agent" field`);
    }
    const rawAgentDef = agentMap.get(agentName);
    if (!rawAgentDef) {
      throw new Error(`Agent "${agentName}" not found in config`);
    }
    const specialistDef = WorkflowRunner.resolveAgentDef(rawAgentDef);

    const usesOwnerFlow = specialistDef.cli !== 'api' && specialistDef.interactive !== false;
    const currentPattern = this.currentConfig?.swarm?.pattern ?? '';
    const isHubPattern = WorkflowRunner.HUB_PATTERNS.has(currentPattern);
    const usesAutoHardening =
      usesOwnerFlow && isHubPattern && !this.isExplicitInteractiveWorker(specialistDef);
    const ownerDef = usesAutoHardening ? this.resolveAutoStepOwner(specialistDef, agentMap) : specialistDef;
    // Reviewer resolution is deferred to just before the review gate runs (see below)
    // so that activeReviewers is up-to-date for concurrent steps.
    let reviewDef: ReturnType<typeof this.resolveAutoReviewAgent> | undefined;
    const supervised: SupervisedStep = {
      specialist: specialistDef,
      owner: ownerDef,
      reviewer: reviewDef,
    };
    const usesDedicatedOwner = usesOwnerFlow && ownerDef.name !== specialistDef.name;

    const maxRetries =
      step.retries ??
      ownerDef.constraints?.retries ??
      specialistDef.constraints?.retries ??
      errorHandling?.maxRetries ??
      0;
    const retryDelay = errorHandling?.retryDelayMs ?? 1000;
    const timeoutMs =
      step.timeoutMs ??
      ownerDef.constraints?.timeoutMs ??
      specialistDef.constraints?.timeoutMs ??
      this.currentConfig?.swarm?.timeoutMs;
    const repairRetries = errorHandling?.strategy === 'retry' ? (errorHandling.repairRetries ?? 0) : 0;
    const repairAgent =
      repairRetries > 0
        ? this.resolveWorkflowRepairAgent(step, stepStates, agentMap, errorHandling)
        : undefined;

    let lastError: string | undefined;
    let lastExitCode: number | undefined;
    let lastExitSignal: string | undefined;
    let lastCompletionReason: WorkflowStepCompletionReason | undefined;
    let lastAttemptStartedAt: number | undefined;
    let lastEffectiveAgentDef: AgentDefinition | undefined;
    let lastEffectiveCwd: string | undefined;
    let lastAttemptReportCaptured = false;
    let lastDiagnosticResult: DiagnosticResult | null = null;

    // OWNER_DECISION: INCOMPLETE_RETRY is enforced here at the attempt-loop level so every
    // interactive execution path shares the same contract:
    // - retries remaining => throw back into the loop and retry
    // - maxRetries = 0 => fail immediately after the first retry request
    // - retry budget exhausted => fail with retry_requested_by_owner, never "completed"
    let repeatSameAttempt = false;
    let transientNetworkRetries = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.checkAborted();
      const isSameAttemptReplay = repeatSameAttempt;
      repeatSameAttempt = false;
      if (!isSameAttemptReplay) {
        transientNetworkRetries = 0;
      }

      // Reset per-attempt exit info so stale values don't leak across retries
      lastExitCode = undefined;
      lastExitSignal = undefined;
      lastAttemptStartedAt = undefined;
      lastEffectiveAgentDef = undefined;
      lastEffectiveCwd = undefined;
      lastAttemptReportCaptured = false;
      let stepOutputForDiagnostic = '';

      if (attempt > 0 && !isSameAttemptReplay) {
        this.emit({ type: 'step:retrying', runId, stepName: step.name, attempt });
        this.postToChannel(`**[${step.name}]** Retrying (attempt ${attempt + 1}/${maxRetries + 1})`);
        this.recordStepToolSideEffect(step.name, {
          type: 'retry',
          detail: `Retrying attempt ${attempt + 1}/${maxRetries + 1}`,
          raw: { attempt, maxRetries },
        });
        state.row.retryCount = attempt;
        await this.db.updateStep(state.row.id, {
          retryCount: attempt,
          updatedAt: new Date().toISOString(),
        });
        await this.trajectory?.stepRetrying(step, attempt, maxRetries);
        if (repairAgent && attempt <= repairRetries) {
          await this.runAgentStepRepairAgent({
            step,
            agentDef: repairAgent,
            attempt,
            maxRetries,
            cwd: lastEffectiveCwd ?? this.resolveEffectiveCwd(step, specialistDef),
            error: lastError ?? 'Unknown error',
            output: this.lastFailedStepOutput.get(step.name) ?? '',
            exitCode: lastExitCode,
            exitSignal: lastExitSignal,
            completionReason: lastCompletionReason,
          });
        }
        await this.delay(retryDelay);
      }

      try {
        this.ensureBudgetAllowsSpawn(step.name, agentName);
        lastAttemptStartedAt = Date.now();
        // Mark step as running
        state.row.status = 'running';
        state.row.error = undefined;
        state.row.completionReason = undefined;
        state.row.startedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'running',
          error: undefined,
          completionReason: undefined,
          startedAt: state.row.startedAt,
          updatedAt: new Date().toISOString(),
        });
        if (!isSameAttemptReplay) {
          this.emit({ type: 'step:started', runId, stepName: step.name });
        }
        this.log(
          `[${step.name}] ${isSameAttemptReplay ? 'Retrying transient network failure' : 'Started'} (owner: ${ownerDef.name}, specialist: ${specialistDef.name})`
        );
        this.initializeStepSignalParticipants(step.name, ownerDef.name, specialistDef.name);
        if (!isSameAttemptReplay) {
          await this.trajectory?.stepStarted(step, ownerDef.name, {
            role: usesDedicatedOwner ? 'owner' : 'specialist',
            owner: ownerDef.name,
            specialist: specialistDef.name,
            reviewer: reviewDef?.name,
          });
          if (usesDedicatedOwner) {
            await this.trajectory?.stepSupervisionAssigned(step, supervised);
          }
          this.emit({
            type: 'step:owner-assigned',
            runId,
            stepName: step.name,
            ownerName: ownerDef.name,
            specialistName: specialistDef.name,
          });
        }

        // Resolve step-output variables (e.g. {{steps.plan.output}}) at execution time
        const stepOutputContext = this.buildStepOutputContext(stepStates, runId);
        let resolvedTask = this.interpolateStepTask(step.task ?? '', stepOutputContext);

        // On retry attempts, prepend failure context so the agent knows what went wrong
        if (attempt > 0 && lastError) {
          if (lastDiagnosticResult) {
            resolvedTask =
              `[RETRY — Attempt ${attempt + 1}/${maxRetries + 1}] Verification failed.\n` +
              `Diagnostic analysis:\n${lastDiagnosticResult.analysis}\n\n` +
              `Original error: ${lastError}\n---\n${resolvedTask}`;
          } else {
            const priorOutput = (this.lastFailedStepOutput.get(step.name) ?? '').slice(-2000);
            const customVerificationFailure = this.lastCustomVerificationFailure.get(step.name);
            const verificationFailurePrompt = customVerificationFailure
              ? `[VERIFICATION FAILED] Your code did not pass the verification check.\n` +
                `Command: ${customVerificationFailure.command}\n` +
                `Output:\n` +
                `${customVerificationFailure.output}\n\n` +
                `Fix the issues above before proceeding.\n`
              : '';
            resolvedTask =
              `[RETRY — Attempt ${attempt + 1}/${maxRetries + 1}]\n` +
              `Previous attempt failed: ${lastError}\n` +
              verificationFailurePrompt +
              (priorOutput ? `Previous output (last 2000 chars):\n${priorOutput}\n` : '') +
              `---\n${resolvedTask}`;
          }
        }

        // If this is an interactive agent, append awareness of non-interactive workers
        // so the lead knows not to message them and to use step output chaining instead
        if (specialistDef.interactive !== false || ownerDef.interactive !== false) {
          const nonInteractiveInfo = this.buildNonInteractiveAwareness(agentMap, stepStates);
          if (nonInteractiveInfo) {
            resolvedTask += nonInteractiveInfo;
          }
        }

        // Apply step-level workdir override to agent definitions if present
        const applyStepCwd = (def: AgentDefinition): AgentDefinition => {
          if (step.cwd) {
            return { ...def, cwd: step.cwd, workdir: undefined };
          }
          if (step.workdir) {
            const stepWorkdir = this.resolveStepWorkdir(step);
            if (stepWorkdir) {
              return { ...def, cwd: stepWorkdir, workdir: undefined };
            }
          }
          return def;
        };
        const effectiveSpecialist = applyStepCwd(specialistDef);
        const effectiveOwner = applyStepCwd(ownerDef);
        const effectiveReviewer = reviewDef ? applyStepCwd(reviewDef) : undefined;
        lastEffectiveAgentDef = effectiveSpecialist;
        lastEffectiveCwd = this.resolveAgentCwd(effectiveSpecialist);
        this.beginStepEvidence(
          step.name,
          [
            this.resolveAgentCwd(effectiveSpecialist),
            this.resolveAgentCwd(effectiveOwner),
            effectiveReviewer ? this.resolveAgentCwd(effectiveReviewer) : undefined,
          ],
          state.row.startedAt
        );

        let specialistOutput: string;
        let ownerOutput: string;
        let ownerElapsed: number;
        let completionReason: WorkflowStepCompletionReason | undefined;
        let promptTaskText: string | undefined;

        if (usesDedicatedOwner) {
          const result = await this.executeSupervisedAgentStep(
            step,
            { specialist: effectiveSpecialist, owner: effectiveOwner, reviewer: reviewDef },
            resolvedTask,
            timeoutMs,
            attempt
          );
          specialistOutput = result.specialistOutput;
          stepOutputForDiagnostic = result.specialistOutput;
          ownerOutput = result.ownerOutput;
          ownerElapsed = result.ownerElapsed;
          completionReason = result.completionReason;
        } else {
          const ownerTask = this.injectStepOwnerContract(
            step,
            resolvedTask,
            effectiveOwner,
            effectiveSpecialist
          );
          const explicitInteractiveWorker = this.isExplicitInteractiveWorker(effectiveOwner);
          let explicitWorkerHandle: WorkflowAgentHandle | undefined;
          let explicitWorkerCompleted = false;
          let explicitWorkerOutput = '';

          this.log(
            `[${step.name}] Spawning owner "${effectiveOwner.name}" (cli: ${effectiveOwner.cli})${step.workdir ? ` [workdir: ${step.workdir}]` : ''}`
          );
          const resolvedStep = { ...step, task: ownerTask };
          const ownerStartTime = Date.now();
          // When processBackend is set without an explicit executor, the runner
          // constructor synthesizes a RunnerStepExecutor that calls
          // processBackend.createEnvironment(step.name).exec(command). Explicit
          // executors still take precedence. See process-backend-executor.ts.
          const spawnResult = this.executor
            ? await this.executor.executeAgentStep(resolvedStep, effectiveOwner, ownerTask, timeoutMs)
            : effectiveOwner.cli === 'api'
              ? {
                  output: await executeApiStep(
                    effectiveOwner.constraints?.model ?? 'claude-sonnet-4-20250514',
                    ownerTask,
                    {
                      envSecrets: this.envSecrets,
                      skills: effectiveOwner.skills,
                      defaultMaxTokens: effectiveOwner.constraints?.maxTokens,
                    }
                  ),
                  exitCode: 0,
                  promptTaskText: ownerTask,
                }
              : await this.spawnAndWait(effectiveOwner, resolvedStep, timeoutMs, {
                  retryAttempt: attempt,
                  evidenceStepName: step.name,
                  evidenceRole: usesOwnerFlow ? 'owner' : 'specialist',
                  preserveOnIdle: !isHubPattern || !this.isLeadLikeAgent(effectiveOwner) ? false : undefined,
                  logicalName: effectiveOwner.name,
                  onSpawned: explicitInteractiveWorker
                    ? ({ agent }) => {
                        explicitWorkerHandle = agent;
                      }
                    : undefined,
                  onChunk: explicitInteractiveWorker
                    ? ({ chunk }) => {
                        explicitWorkerOutput += WorkflowRunner.stripAnsi(chunk);
                        if (
                          !explicitWorkerCompleted &&
                          this.hasExplicitInteractiveWorkerCompletionEvidence(
                            step,
                            explicitWorkerOutput,
                            ownerTask,
                            resolvedTask
                          )
                        ) {
                          explicitWorkerCompleted = true;
                          void explicitWorkerHandle?.release().catch(() => undefined);
                        }
                      }
                    : undefined,
                });
          const output = typeof spawnResult === 'string' ? spawnResult : spawnResult.output;
          promptTaskText =
            typeof spawnResult === 'string'
              ? effectiveOwner.interactive === false
                ? undefined
                : ownerTask
              : (spawnResult.promptTaskText ?? ownerTask);
          lastExitCode = typeof spawnResult === 'string' ? undefined : spawnResult.exitCode;
          lastExitSignal = typeof spawnResult === 'string' ? undefined : spawnResult.exitSignal;
          ownerElapsed = Date.now() - ownerStartTime;
          this.log(`[${step.name}] Owner "${effectiveOwner.name}" exited`);
          if (usesOwnerFlow) {
            try {
              const completionDecision = this.resolveOwnerCompletionDecision(
                step,
                output,
                output,
                promptTaskText ?? ownerTask,
                promptTaskText ?? ownerTask
              );
              completionReason = completionDecision.completionReason;
            } catch (error) {
              const canUseVerificationFallback =
                !usesDedicatedOwner &&
                step.verification &&
                error instanceof WorkflowCompletionError &&
                error.completionReason === 'failed_no_evidence';
              if (!canUseVerificationFallback) {
                throw error;
              }
            }
          }
          specialistOutput = output;
          stepOutputForDiagnostic = output;
          ownerOutput = output;
        }

        // Even non-interactive steps can emit an explicit OWNER_DECISION contract.
        // Honor retry/fail/clarification signals before verification-driven success so
        // real runs stay consistent with interactive owner flows.
        if (!usesOwnerFlow) {
          const explicitOwnerDecision = this.parseOwnerDecision(step, ownerOutput, false);
          if (explicitOwnerDecision?.decision === 'INCOMPLETE_RETRY') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner requested retry${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'retry_requested_by_owner'
            );
          }
          if (explicitOwnerDecision?.decision === 'INCOMPLETE_FAIL') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner marked the step incomplete${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'failed_owner_decision'
            );
          }
          if (explicitOwnerDecision?.decision === 'NEEDS_CLARIFICATION') {
            throw new WorkflowCompletionError(
              `Step "${step.name}" owner requested clarification before completion${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
              'retry_requested_by_owner'
            );
          }
        }

        // Run verification if configured.
        // Self-owned interactive steps still need verification fallback so
        // explicit OWNER_DECISION output is not mandatory for the happy path.
        if (step.verification && (!usesOwnerFlow || !usesDedicatedOwner) && !completionReason) {
          const verificationResult = this.runVerification(
            step.verification,
            specialistOutput,
            step.name,
            promptTaskText
          );
          completionReason = verificationResult.completionReason;
        }

        // Retry-style owner decisions are control-flow signals, not terminal success states.
        // Guard here so they cannot accidentally fall through into review or completed-step
        // persistence if a future branch returns a completionReason instead of throwing.
        if (completionReason === 'retry_requested_by_owner') {
          throw new WorkflowCompletionError(
            `Step "${step.name}" owner requested another attempt`,
            'retry_requested_by_owner'
          );
        }

        // Every interactive step gets a review pass; pick a dedicated reviewer when available.
        // Resolve reviewer JIT so activeReviewers reflects concurrent steps that started earlier.
        if (usesAutoHardening && usesDedicatedOwner && !reviewDef) {
          reviewDef = this.resolveAutoReviewAgent(ownerDef, agentMap);
          supervised.reviewer = reviewDef;
        }
        let combinedOutput = specialistOutput;
        if (usesOwnerFlow && reviewDef) {
          this.activeReviewers.set(reviewDef.name, (this.activeReviewers.get(reviewDef.name) ?? 0) + 1);
          try {
            const remainingMs = timeoutMs ? Math.max(0, timeoutMs - ownerElapsed) : undefined;
            const reviewOutput = await this.runStepReviewGate(
              step,
              resolvedTask,
              specialistOutput,
              ownerOutput,
              ownerDef,
              reviewDef,
              remainingMs
            );
            combinedOutput = this.combineStepAndReviewOutput(specialistOutput, reviewOutput);
          } finally {
            const count = (this.activeReviewers.get(reviewDef.name) ?? 1) - 1;
            if (count <= 0) this.activeReviewers.delete(reviewDef.name);
            else this.activeReviewers.set(reviewDef.name, count);
          }
        }

        await this.captureAgentReport(
          runId,
          step.name,
          lastEffectiveAgentDef,
          lastEffectiveCwd,
          lastAttemptStartedAt,
          Date.now()
        );
        lastAttemptReportCaptured = true;

        // Mark completed
        state.row.status = 'completed';
        state.row.output = combinedOutput;
        state.row.completionReason = completionReason;
        state.row.completedAt = new Date().toISOString();
        await this.db.updateStep(state.row.id, {
          status: 'completed',
          output: combinedOutput,
          completionReason,
          completedAt: state.row.completedAt,
          updatedAt: new Date().toISOString(),
        });

        // Persist step output to disk so it survives restarts and is inspectable
        await this.persistStepOutput(runId, step.name, combinedOutput);

        this.emit({
          type: 'step:completed',
          runId,
          stepName: step.name,
          output: combinedOutput,
          exitCode: lastExitCode,
          exitSignal: lastExitSignal,
        });
        this.finalizeStepEvidence(step.name, 'completed', state.row.completedAt, completionReason);
        await this.trajectory?.stepCompleted(step, combinedOutput, attempt + 1);
        return;
      } catch (err) {
        if (
          this.isTransientAgentNetworkError(err) &&
          transientNetworkRetries < AGENT_TRANSIENT_NETWORK_MAX_ATTEMPTS - 1
        ) {
          transientNetworkRetries += 1;
          const message = err instanceof Error ? err.message : String(err);
          this.log(
            `[${step.name}] Transient network failure during agent step; replaying attempt ${attempt + 1}/${maxRetries + 1} (${transientNetworkRetries}/${AGENT_TRANSIENT_NETWORK_MAX_ATTEMPTS - 1}): ${message}`
          );
          this.postToChannel(
            `**[${step.name}]** Transient network issue; retrying current attempt (${transientNetworkRetries}/${AGENT_TRANSIENT_NETWORK_MAX_ATTEMPTS - 1})`
          );
          repeatSameAttempt = true;
          attempt -= 1;
          await this.delay(AGENT_TRANSIENT_NETWORK_RETRY_DELAY_MS * transientNetworkRetries);
          continue;
        }
        if (process.env.RF_DEBUG_STACK) console.error('RF_DEBUG_STACK', (err as Error)?.stack);
        lastError = err instanceof Error ? err.message : String(err);
        lastCompletionReason = err instanceof WorkflowCompletionError ? err.completionReason : undefined;
        if (stepOutputForDiagnostic) {
          this.lastFailedStepOutput.set(step.name, stepOutputForDiagnostic);
        }
        const diagnosticVerification = step.verification as DiagnosticVerificationCheck | undefined;
        if (
          err instanceof WorkflowCompletionError &&
          err.completionReason === 'failed_verification' &&
          diagnosticVerification?.diagnosticAgent &&
          attempt < maxRetries
        ) {
          lastDiagnosticResult = await this.runDiagnosticAgent(
            step,
            lastError,
            stepOutputForDiagnostic || (this.lastFailedStepOutput.get(step.name) ?? ''),
            agentMap,
            runId
          );
        } else {
          lastDiagnosticResult = null;
        }
        if (lastCompletionReason !== 'failed_verification') {
          this.lastCustomVerificationFailure.delete(step.name);
        }
        if (!(err instanceof BudgetExceededError) && !lastAttemptReportCaptured) {
          await this.captureAgentReport(
            runId,
            step.name,
            lastEffectiveAgentDef,
            lastEffectiveCwd,
            lastAttemptStartedAt,
            Date.now()
          );
          lastAttemptReportCaptured = true;
        }
        if (err instanceof BudgetExceededError) {
          break;
        }
        if (lastCompletionReason === 'retry_requested_by_owner' && attempt >= maxRetries) {
          lastError = this.buildOwnerRetryBudgetExceededMessage(step.name, maxRetries, lastError);
        }
        if (err instanceof SpawnExitError) {
          lastExitCode = err.exitCode;
          lastExitSignal = err.exitSignal;
        }
        const ownerTimedOut = usesDedicatedOwner
          ? /\bowner timed out\b/i.test(lastError)
          : /\btimed out\b/i.test(lastError) && !lastError.includes(`${step.name}-review`);
        if (ownerTimedOut) {
          this.emit({ type: 'step:owner-timeout', runId, stepName: step.name, ownerName: ownerDef.name });
        }
      }
    }

    // All retries exhausted — record root-cause diagnosis and mark failed
    const nonInteractive =
      ownerDef.interactive === false || ['worker', 'reviewer', 'analyst'].includes(ownerDef.preset ?? '');
    const verificationValue =
      typeof step.verification === 'object' && 'value' in step.verification
        ? String(step.verification.value)
        : undefined;
    if (!lastAttemptReportCaptured) {
      await this.captureAgentReport(
        runId,
        step.name,
        lastEffectiveAgentDef,
        lastEffectiveCwd,
        lastAttemptStartedAt,
        Date.now()
      );
    }
    await this.trajectory?.stepFailed(step, lastError ?? 'Unknown error', maxRetries + 1, maxRetries, {
      agent: agentName,
      nonInteractive,
      verificationValue,
    });
    this.postToChannel(`**[${step.name}]** Failed: ${lastError ?? 'Unknown error'}`);
    await this.markStepFailed(
      state,
      lastError ?? 'Unknown error',
      runId,
      {
        exitCode: lastExitCode,
        exitSignal: lastExitSignal,
      },
      lastCompletionReason
    );
    throw new Error(
      `Step "${step.name}" failed after ${maxRetries} retries: ${lastError ?? 'Unknown error'}`
    );
  }

  private async runDiagnosticAgent(
    step: WorkflowStep,
    verificationError: string,
    stepOutput: string,
    agentMap: Map<string, AgentDefinition>,
    runId: string
  ): Promise<DiagnosticResult | null> {
    const verification = step.verification as DiagnosticVerificationCheck | undefined;
    const diagnosticAgentName = verification?.diagnosticAgent;
    if (!verification || !diagnosticAgentName) {
      return null;
    }

    const rawDiagnosticDef = agentMap.get(diagnosticAgentName);
    if (!rawDiagnosticDef) {
      this.log(
        `[${step.name}] Diagnostic agent "${diagnosticAgentName}" not found — falling back to standard retry`
      );
      return null;
    }

    const diagnosticAgentDef: AgentDefinition = {
      ...WorkflowRunner.resolveAgentDef(rawDiagnosticDef),
      interactive: false,
    };
    const verificationCommand =
      verification.type === 'custom' ? verification.value : `${verification.type}: ${verification.value}`;
    const diagnosticTimeout = verification.diagnosticTimeout ?? 60_000;
    const diagnosticPrompt =
      `The following verification failed after step "${step.name}".\n\n` +
      `Verification command: ${verificationCommand}\n` +
      `Verification output:\n${verificationError}\n\n` +
      `Step task was:\n${step.task ?? ''}\n\n` +
      `Step output (last 2000 chars):\n${stepOutput.slice(-2000)}\n\n` +
      `Analyze what went wrong. Be specific. Do NOT fix the code.`;
    const diagnosticStep: WorkflowStep = {
      ...step,
      name: `${step.name}-diagnostic-${runId.slice(0, 8)}`,
      agent: diagnosticAgentName,
      task: diagnosticPrompt,
      verification: undefined,
      retries: 0,
    };
    const diagnosticCwd = this.resolveExecutionCwd(diagnosticStep, diagnosticAgentDef);
    const startedAt = Date.now();

    try {
      this.ensureBudgetAllowsSpawn(step.name, diagnosticAgentName);
      this.log(`[${step.name}] Verification failed — running diagnostic agent '${diagnosticAgentName}'...`);
      const diagnosticResult = await this.execNonInteractive(
        diagnosticAgentDef,
        diagnosticStep,
        diagnosticTimeout
      );
      const elapsedMs = Date.now() - startedAt;
      await this.captureAgentReport(
        runId,
        step.name,
        diagnosticAgentDef,
        diagnosticCwd,
        startedAt,
        Date.now()
      );
      const analysis = diagnosticResult.output.trim();
      const tokenCount = Math.max(1, Math.ceil(analysis.length / 4));
      const firstLine =
        analysis
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? '(no analysis returned)';

      this.log(`[${step.name}] Diagnostic complete (${elapsedMs}ms, ${tokenCount} tokens): ${firstLine}`);

      return {
        analysis,
        metadata: {
          agentName: diagnosticAgentName,
          elapsedMs,
          tokenCount,
        },
      };
    } catch (error) {
      await this.captureAgentReport(
        runId,
        step.name,
        diagnosticAgentDef,
        diagnosticCwd,
        startedAt,
        Date.now()
      );
      const message = error instanceof Error ? error.message : String(error);
      if (/\btimed out\b/i.test(message)) {
        this.log(`[${step.name}] Diagnostic timed out — falling back to standard retry`);
      } else {
        this.log(`[${step.name}] Diagnostic failed — falling back to standard retry: ${message}`);
      }
      return null;
    }
  }

  private buildOwnerRetryBudgetExceededMessage(
    stepName: string,
    maxRetries: number,
    ownerDecisionError?: string
  ): string {
    const attempts = maxRetries + 1;
    const prefix = `Step "${stepName}" `;
    const normalizedDecision = ownerDecisionError?.startsWith(prefix)
      ? ownerDecisionError.slice(prefix.length).trim()
      : ownerDecisionError?.trim();
    const decisionSuffix = normalizedDecision ? ` Latest owner decision: ${normalizedDecision}` : '';

    if (maxRetries === 0) {
      return (
        `Step "${stepName}" owner requested another attempt, but no retries are configured ` +
        `(maxRetries=0). Configure retries > 0 to allow OWNER_DECISION: INCOMPLETE_RETRY.` +
        decisionSuffix
      );
    }

    return (
      `Step "${stepName}" owner requested another attempt after ${attempts} total attempts, ` +
      `but the retry budget is exhausted (maxRetries=${maxRetries}).` +
      decisionSuffix
    );
  }

  private injectStepOwnerContract(
    step: WorkflowStep,
    resolvedTask: string,
    ownerDef: AgentDefinition,
    specialistDef: AgentDefinition
  ): string {
    if (ownerDef.interactive === false) return resolvedTask;
    const specialistNote =
      ownerDef.name === specialistDef.name
        ? ''
        : `Specialist intended for this step: "${specialistDef.name}" (${specialistDef.role ?? specialistDef.cli}).`;
    return (
      resolvedTask +
      '\n\n---\n' +
      `STEP OWNER CONTRACT:\n` +
      `- You are the accountable owner for step "${step.name}".\n` +
      (specialistNote ? `- ${specialistNote}\n` : '') +
      `- If you delegate, you must still verify completion yourself.\n` +
      `- Preferred final decision format:\n` +
      `  OWNER_DECISION: <one of COMPLETE, INCOMPLETE_RETRY, INCOMPLETE_FAIL, NEEDS_CLARIFICATION>\n` +
      `  REASON: <one sentence>\n` +
      `- Legacy completion marker still supported: STEP_COMPLETE:${step.name}\n` +
      `- Then self-terminate immediately with /exit.`
    );
  }

  private buildOwnerSupervisorTask(
    step: WorkflowStep,
    originalTask: string,
    supervised: SupervisedStep,
    workerRuntimeName: string
  ): string {
    const verificationGuide = this.buildSupervisorVerificationGuide(step.verification);
    const channelLine = this.channel ? `#${this.channel}` : '(workflow channel unavailable)';
    const channelContract = this.channel
      ? `- Prefer Relaycast/group-chat handoff signals over terminal sentinels: wait for the worker to post \`WORKER_DONE: <brief summary>\` in ${channelLine}\n` +
        `- When you have validated the handoff, post \`LEAD_DONE: <brief summary>\` to ${channelLine} before you exit\n`
      : '';
    return (
      `You are the step owner/supervisor for step "${step.name}".\n\n` +
      `Worker: ${supervised.specialist.name} (runtime: ${workerRuntimeName}) on ${channelLine}\n` +
      `Task: ${originalTask}\n\n` +
      `Your job: Monitor the worker and determine when the task is complete.\n\n` +
      `How to verify completion:\n` +
      `- Watch ${channelLine} for the worker's progress messages and mirrored PTY output\n` +
      `- Check file changes: run \`git diff --stat\` or inspect expected files directly\n` +
      `- Ask the worker directly on ${channelLine} if you need a status update\n` +
      channelContract +
      verificationGuide +
      `\nWhen you have enough evidence, return:\n` +
      `OWNER_DECISION: <one of COMPLETE, INCOMPLETE_RETRY, INCOMPLETE_FAIL, NEEDS_CLARIFICATION>\n` +
      `REASON: <one sentence>\n` +
      `Legacy completion marker still supported: STEP_COMPLETE:${step.name}`
    );
  }

  private buildWorkerHandoffTask(
    step: WorkflowStep,
    originalTask: string,
    supervised: SupervisedStep
  ): string {
    if (!this.channel) return originalTask;

    return (
      `${originalTask}\n\n---\n` +
      `WORKER COMPLETION CONTRACT:\n` +
      `- You are handing work off to owner "${supervised.owner.name}" for step "${step.name}".\n` +
      `- When your work is ready for review, post to #${this.channel}: \`WORKER_DONE: <brief summary>\`\n` +
      `- Do not rely on terminal output alone for handoff; use the workflow group chat signal above.\n` +
      `- After posting your handoff signal, self-terminate with /exit unless the owner asks for follow-up.`
    );
  }

  private buildWorkflowRuntimeAgentBaseName(stepName: string, options: SpawnAndWaitOptions): string {
    return `${stepName}${options.agentNameSuffix ? `-${options.agentNameSuffix}` : ''}-${(this.currentRunId ?? this.generateShortId()).slice(0, 8)}`;
  }

  private async releaseStaleRetryAgents(baseRequestedName: string, stepName: string): Promise<void> {
    if (!this.relay) {
      return;
    }

    const staleAgents = (
      await this.withBrokerRecovery(`listing stale retry agents for step "${stepName}"`, (relay) =>
        relay.listAgents()
      )
    ).filter((agent) => agent.name === baseRequestedName || agent.name.startsWith(`${baseRequestedName}-r`));
    if (staleAgents.length === 0) {
      return;
    }

    const staleNames = [...new Set(staleAgents.map((agent) => agent.name))].sort();
    this.log(`[${stepName}] Releasing stale retry agent(s): ${staleNames.join(', ')}`);

    for (const name of staleNames) {
      await this.withBrokerRecovery(`releasing stale retry agent "${name}"`, (relay) =>
        relay.release(name, `workflow retry cleanup for step "${stepName}"`)
      );
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const remaining = (
        await this.withBrokerRecovery(`confirming retry cleanup for step "${stepName}"`, (relay) =>
          relay.listAgents()
        )
      )
        .map((agent) => agent.name)
        .filter((name) => staleNames.includes(name));
      if (remaining.length === 0) {
        return;
      }
      await this.delay(100);
    }

    throw new Error(`Failed to clear stale retry agent(s) before respawn: ${staleNames.join(', ')}`);
  }

  private buildSupervisorVerificationGuide(verification?: VerificationCheck): string {
    if (!verification) return '';
    switch (verification.type) {
      case 'output_contains':
        return `- Verification gate: confirm the worker output contains ${JSON.stringify(verification.value)}\n`;
      case 'file_exists':
        return `- Verification gate: confirm the file exists at ${JSON.stringify(verification.value)}\n`;
      case 'exit_code':
        return `- Verification gate: confirm the worker exits with code ${JSON.stringify(verification.value)}\n`;
      case 'custom':
        return `- Verification gate: apply the custom verification rule ${JSON.stringify(verification.value)}\n`;
      default:
        return '';
    }
  }

  private async executeSupervisedAgentStep(
    step: WorkflowStep,
    supervised: SupervisedStep,
    resolvedTask: string,
    timeoutMs?: number,
    retryAttempt = 0
  ): Promise<{
    specialistOutput: string;
    ownerOutput: string;
    ownerElapsed: number;
    completionReason: WorkflowStepCompletionReason;
  }> {
    if (this.executor) {
      const specialistTask = this.buildWorkerHandoffTask(step, resolvedTask, supervised);
      const supervisorTask = this.buildOwnerSupervisorTask(
        step,
        resolvedTask,
        supervised,
        supervised.specialist.name
      );
      const specialistStep = { ...step, task: specialistTask };
      const ownerStep: WorkflowStep = {
        ...step,
        name: `${step.name}-owner`,
        agent: supervised.owner.name,
        task: supervisorTask,
      };

      this.log(
        `[${step.name}] Spawning specialist "${supervised.specialist.name}" and owner "${supervised.owner.name}"`
      );
      const specialistPromise = this.executor.executeAgentStep(
        specialistStep,
        supervised.specialist,
        specialistTask,
        timeoutMs
      );
      // Guard against unhandled rejection if owner fails before specialist settles
      const specialistSettled = specialistPromise.catch(() => undefined);

      try {
        const ownerStartTime = Date.now();
        const ownerOutput = await this.executor.executeAgentStep(
          ownerStep,
          supervised.owner,
          supervisorTask,
          timeoutMs
        );
        const ownerElapsed = Date.now() - ownerStartTime;
        const specialistOutput = await specialistPromise;
        const completionDecision = this.resolveOwnerCompletionDecision(
          step,
          ownerOutput,
          specialistOutput,
          supervisorTask,
          resolvedTask
        );
        return {
          specialistOutput,
          ownerOutput,
          ownerElapsed,
          completionReason: completionDecision.completionReason,
        };
      } catch (error) {
        await specialistSettled;
        throw error;
      }
    }

    let workerHandle: WorkflowAgentHandle | undefined;
    let workerRuntimeName = supervised.specialist.name;
    let workerSpawned = false;
    let workerReleased = false;
    let resolveWorkerSpawn!: () => void;
    let rejectWorkerSpawn!: (error: unknown) => void;
    const workerReady = new Promise<void>((resolve, reject) => {
      resolveWorkerSpawn = resolve;
      rejectWorkerSpawn = reject;
    });

    const specialistTask = this.buildWorkerHandoffTask(step, resolvedTask, supervised);
    const specialistStep = { ...step, task: specialistTask };
    this.log(
      `[${step.name}] Spawning specialist "${supervised.specialist.name}" (cli: ${supervised.specialist.cli})`
    );
    const workerPromise = this.spawnAndWait(supervised.specialist, specialistStep, timeoutMs, {
      agentNameSuffix: 'worker',
      retryAttempt,
      evidenceStepName: step.name,
      evidenceRole: 'worker',
      logicalName: supervised.specialist.name,
      onSpawned: ({ actualName, agent }) => {
        workerHandle = agent;
        workerRuntimeName = actualName;
        this.supervisedRuntimeAgents.set(actualName, {
          stepName: step.name,
          role: 'specialist',
          logicalName: supervised.specialist.name,
        });
        if (!workerSpawned) {
          workerSpawned = true;
          resolveWorkerSpawn();
        }
      },
      onChunk: ({ agentName, chunk }) => {
        this.forwardAgentChunkToChannel(step.name, 'Worker', agentName, chunk, supervised.specialist.name);
      },
    }).catch((error) => {
      if (!workerSpawned) {
        workerSpawned = true;
        rejectWorkerSpawn(error);
      }
      throw error;
    });

    const workerSettled = workerPromise.catch(() => undefined);
    workerPromise
      .then((result) => {
        workerReleased = true;
        this.log(`[${step.name}] Worker ${workerRuntimeName} exited`);
        this.recordStepToolSideEffect(step.name, {
          type: 'worker_exit',
          detail: `Worker ${workerRuntimeName} exited`,
          raw: { worker: workerRuntimeName, exitCode: result.exitCode, exitSignal: result.exitSignal },
        });
        if (
          step.verification?.type === 'output_contains' &&
          this.outputContainsVerificationToken(result.output, step.verification.value, result.promptTaskText)
        ) {
          this.log(
            `[${step.name}] Verification gate observed: output contains ${JSON.stringify(step.verification.value)}`
          );
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.postToChannel(
          `**[${step.name}]** Worker \`${workerRuntimeName}\` exited with error: ${message}`
        );
        this.recordStepToolSideEffect(step.name, {
          type: 'worker_error',
          detail: `Worker ${workerRuntimeName} exited with error: ${message}`,
          raw: { worker: workerRuntimeName, error: message },
        });
      });

    await workerReady;

    const supervisorTask = this.buildOwnerSupervisorTask(step, resolvedTask, supervised, workerRuntimeName);
    const ownerStep: WorkflowStep = {
      ...step,
      name: `${step.name}-owner`,
      agent: supervised.owner.name,
      task: supervisorTask,
    };

    this.log(`[${step.name}] Spawning owner "${supervised.owner.name}" (cli: ${supervised.owner.cli})`);
    const ownerStartTime = Date.now();

    try {
      const ownerResultObj =
        supervised.owner.cli === 'api'
          ? {
              output: await executeApiStep(
                supervised.owner.constraints?.model ?? 'claude-sonnet-4-20250514',
                supervisorTask,
                {
                  envSecrets: this.envSecrets,
                  skills: supervised.owner.skills,
                  defaultMaxTokens: supervised.owner.constraints?.maxTokens,
                }
              ),
              exitCode: 0,
              promptTaskText: supervisorTask,
            }
          : await this.spawnAndWait(supervised.owner, ownerStep, timeoutMs, {
              agentNameSuffix: 'owner',
              retryAttempt,
              evidenceStepName: step.name,
              evidenceRole: 'owner',
              logicalName: supervised.owner.name,
              onSpawned: ({ actualName }) => {
                this.supervisedRuntimeAgents.set(actualName, {
                  stepName: step.name,
                  role: 'owner',
                  logicalName: supervised.owner.name,
                });
              },
              onChunk: ({ chunk }) => {
                void this.recordOwnerMonitoringChunk(step, supervised.owner, chunk);
              },
            });
      const ownerElapsed = Date.now() - ownerStartTime;
      const ownerOutput = ownerResultObj.output;
      this.log(`[${step.name}] Owner "${supervised.owner.name}" exited`);
      const workerResultObj = await workerPromise;
      const specialistOutput = workerResultObj.output;
      const completionDecision = this.resolveOwnerCompletionDecision(
        step,
        ownerOutput,
        specialistOutput,
        ownerResultObj.promptTaskText ?? supervisorTask,
        workerResultObj.promptTaskText ?? specialistTask
      );
      return {
        specialistOutput,
        ownerOutput,
        ownerElapsed,
        completionReason: completionDecision.completionReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!workerReleased && workerHandle) {
        await workerHandle.release().catch(() => undefined);
      }
      await workerSettled;
      if (/\btimed out\b/i.test(message)) {
        // Resolve the effective owner timeout so the failure is actionable. A bare
        // `${timeoutMs ?? 'unknown'}ms` renders "unknownms" whenever the step has no
        // timeout configured, which leaves every downstream repair attempt with an
        // undiagnosable context. Fall back through the same precedence the runner uses
        // elsewhere (step -> owner agent constraints -> swarm), and name the gap when
        // nothing is configured at all.
        const effectiveTimeoutMs =
          timeoutMs ??
          supervised.owner.constraints?.timeoutMs ??
          this.currentConfig?.swarm?.timeoutMs;
        const timeoutLabel =
          effectiveTimeoutMs != null
            ? `${effectiveTimeoutMs}ms`
            : 'the default timeout (no step, owner-agent, or swarm timeout configured)';
        throw new Error(`Step "${step.name}" owner timed out after ${timeoutLabel}`);
      }
      throw error;
    }
  }

  private forwardAgentChunkToChannel(
    stepName: string,
    roleLabel: string,
    agentName: string,
    chunk: string,
    sender?: string
  ): void {
    const lines = WorkflowRunner.scrubForChannel(chunk)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 3);
    for (const line of lines) {
      this.postToChannel(`**[${stepName}]** ${roleLabel} \`${agentName}\`: ${line.slice(0, 280)}`, {
        stepName,
        sender,
        actor: agentName,
        role: roleLabel,
        origin: 'forwarded_chunk',
      });
    }
  }

  private async recordOwnerMonitoringChunk(
    step: WorkflowStep,
    ownerDef: AgentDefinition,
    chunk: string
  ): Promise<void> {
    const stripped = WorkflowRunner.stripAnsi(chunk);
    const details: string[] = [];
    if (/git diff --stat/i.test(stripped)) details.push('Checked git diff stats');
    if (/\bls -la\b/i.test(stripped)) details.push('Listed files for verification');
    if (/status update\?/i.test(stripped)) details.push('Asked the worker for a status update');
    if (/STEP_COMPLETE:/i.test(stripped)) details.push('Declared the step complete');

    for (const detail of details) {
      this.recordStepToolSideEffect(step.name, {
        type: 'owner_monitoring',
        detail,
        raw: { output: stripped.slice(0, 240), owner: ownerDef.name },
      });
      await this.trajectory?.ownerMonitoringEvent(step.name, ownerDef.name, detail, {
        output: stripped.slice(0, 240),
      });
    }
  }

  private resolveAutoStepOwner(
    specialistDef: AgentDefinition,
    agentMap: Map<string, AgentDefinition>
  ): AgentDefinition {
    if (specialistDef.interactive === false) return specialistDef;

    const allDefs = [...agentMap.values()].map((d) => WorkflowRunner.resolveAgentDef(d));
    const candidates = allDefs.filter((d) => d.interactive !== false);
    const matchesHubRole = (text: string): boolean =>
      [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`, 'i').test(text));
    const ownerish = (def: AgentDefinition): boolean => {
      const nameLC = def.name.toLowerCase();
      const roleLC = def.role?.toLowerCase() ?? '';
      return matchesHubRole(nameLC) || matchesHubRole(roleLC);
    };
    const ownerPriority = (def: AgentDefinition): number => {
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      if (/\blead\b/.test(roleLC) || /\blead\b/.test(nameLC)) return 6;
      if (/\bcoordinator\b/.test(roleLC) || /\bcoordinator\b/.test(nameLC)) return 5;
      if (/\bsupervisor\b/.test(roleLC) || /\bsupervisor\b/.test(nameLC)) return 4;
      if (/\borchestrator\b/.test(roleLC) || /\borchestrator\b/.test(nameLC)) return 3;
      if (/\bhub\b/.test(roleLC) || /\bhub\b/.test(nameLC)) return 2;
      return ownerish(def) ? 1 : 0;
    };
    const dedicatedOwner = candidates
      .filter((d) => d.name !== specialistDef.name && ownerish(d))
      .sort((a, b) => ownerPriority(b) - ownerPriority(a) || a.name.localeCompare(b.name))[0];
    if (dedicatedOwner) return dedicatedOwner;
    return specialistDef;
  }

  private resolveAutoReviewAgent(
    ownerDef: AgentDefinition,
    agentMap: Map<string, AgentDefinition>
  ): AgentDefinition {
    const allDefs = [...agentMap.values()].map((d) => WorkflowRunner.resolveAgentDef(d));
    const eligible = (def: AgentDefinition): boolean =>
      def.name !== ownerDef.name && !this.isExplicitInteractiveWorker(def);
    const isReviewer = (def: AgentDefinition): boolean => {
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      return (
        def.preset === 'reviewer' ||
        roleLC.includes('review') ||
        roleLC.includes('critic') ||
        roleLC.includes('verifier') ||
        roleLC.includes('qa') ||
        nameLC.includes('review')
      );
    };
    const reviewerPriority = (def: AgentDefinition): number => {
      if (def.preset === 'reviewer') return 5;
      const roleLC = def.role?.toLowerCase() ?? '';
      const nameLC = def.name.toLowerCase();
      if (roleLC.includes('review') || nameLC.includes('review')) return 4;
      if (roleLC.includes('verifier') || roleLC.includes('qa')) return 3;
      if (roleLC.includes('critic')) return 2;
      return isReviewer(def) ? 1 : 0;
    };
    // Prefer agents not currently assigned as reviewers to avoid double-booking
    const notBusy = (def: AgentDefinition): boolean => !this.activeReviewers.has(def.name);

    const dedicatedCandidates = allDefs
      .filter((d) => eligible(d) && isReviewer(d))
      .sort((a, b) => reviewerPriority(b) - reviewerPriority(a) || a.name.localeCompare(b.name));
    const dedicated = dedicatedCandidates.find(notBusy) ?? dedicatedCandidates[0];
    if (dedicated) return dedicated;

    const alternateCandidates = allDefs.filter((d) => eligible(d) && d.interactive !== false);
    const alternate = alternateCandidates.find(notBusy) ?? alternateCandidates[0];
    if (alternate) return alternate;

    // Self-review fallback — log a warning since owner reviewing itself is weak.
    return ownerDef;
  }

  private isExplicitInteractiveWorker(agentDef: AgentDefinition): boolean {
    return agentDef.preset === 'worker' && agentDef.interactive !== false;
  }

  private resolveOwnerCompletionDecision(
    step: WorkflowStep,
    ownerOutput: string,
    specialistOutput: string,
    injectedTaskText: string,
    verificationTaskText?: string
  ): CompletionDecisionResult {
    const hasMarker = this.hasOwnerCompletionMarker(step, ownerOutput, injectedTaskText);
    const explicitOwnerDecision = this.parseOwnerDecision(step, ownerOutput, false);

    // INCOMPLETE_RETRY / NEEDS_CLARIFICATION are non-terminal owner outcomes. They never mark
    // the step complete here; instead they throw back to executeAgentStep(), which decides
    // whether to retry or fail based on the remaining retry budget for this step.
    if (explicitOwnerDecision?.decision === 'INCOMPLETE_RETRY') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner requested retry${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'retry_requested_by_owner'
      );
    }
    if (explicitOwnerDecision?.decision === 'INCOMPLETE_FAIL') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner marked the step incomplete${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'failed_owner_decision'
      );
    }
    if (explicitOwnerDecision?.decision === 'NEEDS_CLARIFICATION') {
      throw new WorkflowCompletionError(
        `Step "${step.name}" owner requested clarification before completion${explicitOwnerDecision.reason ? `: ${explicitOwnerDecision.reason}` : ''}`,
        'retry_requested_by_owner'
      );
    }

    const verificationResult = step.verification
      ? this.runVerification(step.verification, specialistOutput, step.name, verificationTaskText, {
          allowFailure: true,
          completionMarkerFound: hasMarker,
        })
      : { passed: false };

    if (verificationResult.error) {
      throw new WorkflowCompletionError(
        `Step "${step.name}" verification failed and no owner decision or evidence established completion: ${verificationResult.error}`,
        'failed_verification'
      );
    }

    if (explicitOwnerDecision?.decision === 'COMPLETE') {
      if (!hasMarker) {
        this.log(
          `[${step.name}] Structured OWNER_DECISION completed the step without legacy STEP_COMPLETE marker`
        );
      }
      return {
        completionReason: 'completed_by_owner_decision',
        ownerDecision: explicitOwnerDecision.decision,
        reason: explicitOwnerDecision.reason,
      };
    }
    if (verificationResult.passed) {
      return { completionReason: 'completed_verified' };
    }

    const ownerDecision = this.parseOwnerDecision(step, ownerOutput, hasMarker);
    if (ownerDecision?.decision === 'COMPLETE') {
      return {
        completionReason: 'completed_by_owner_decision',
        ownerDecision: ownerDecision.decision,
        reason: ownerDecision.reason,
      };
    }

    if (!explicitOwnerDecision) {
      const evidenceReason = this.judgeOwnerCompletionByEvidence(step.name, ownerOutput);
      if (evidenceReason) {
        if (!hasMarker) {
          this.log(`[${step.name}] Evidence-based completion resolved without legacy STEP_COMPLETE marker`);
        }
        return {
          completionReason: 'completed_by_evidence',
          reason: evidenceReason,
        };
      }
    }

    // Process-exit fallback: if the agent exited cleanly (code 0) and verification
    // passes (or no verification is configured), infer completion rather than failing.
    // This reduces dependence on agents posting exact coordination signals.
    const processExitFallback = this.tryProcessExitFallback(
      step,
      specialistOutput,
      verificationTaskText,
      ownerOutput
    );
    if (processExitFallback) {
      this.log(
        `[${step.name}] Completion inferred from clean process exit (code 0)` +
          (step.verification ? ' + verification passed' : '') +
          ' — no coordination signal was required'
      );
      return processExitFallback;
    }

    throw new WorkflowCompletionError(
      `Step "${step.name}" owner completion decision missing: no OWNER_DECISION, legacy STEP_COMPLETE marker, or evidence-backed completion signal`,
      'failed_no_evidence'
    );
  }

  private hasExplicitInteractiveWorkerCompletionEvidence(
    step: WorkflowStep,
    output: string,
    injectedTaskText: string,
    verificationTaskText: string
  ): boolean {
    try {
      this.resolveOwnerCompletionDecision(step, output, output, injectedTaskText, verificationTaskText);
      return true;
    } catch {
      return false;
    }
  }

  private hasOwnerCompletionMarker(step: WorkflowStep, output: string, injectedTaskText: string): boolean {
    const marker = `STEP_COMPLETE:${step.name}`;
    const strippedOutput = stripInjectedTaskEcho(output, injectedTaskText);
    if (strippedOutput.includes(marker)) {
      return true;
    }
    const taskHasMarker = injectedTaskText.includes(marker);
    const first = output.indexOf(marker);
    if (first === -1) {
      return false;
    }
    // PTY output often includes echoed prompt text, so when the injected task
    // itself contains the legacy marker require a second occurrence from the
    // agent response.
    const outputLikelyContainsInjectedPrompt =
      output.includes('STEP OWNER CONTRACT') ||
      output.includes('Preferred final decision format') ||
      output.includes('Legacy completion marker still supported') ||
      output.includes('Output exactly: STEP_COMPLETE:');
    if (taskHasMarker && outputLikelyContainsInjectedPrompt) {
      return output.includes(marker, first + marker.length);
    }
    return true;
  }

  private parseOwnerDecision(
    step: WorkflowStep,
    ownerOutput: string,
    hasMarker: boolean
  ): { decision: WorkflowOwnerDecision; reason?: string } | null {
    const decisionPattern =
      /OWNER_DECISION:\s*(COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/gi;
    const decisionMatches = [...ownerOutput.matchAll(decisionPattern)];
    const outputLikelyContainsEchoedPrompt =
      ownerOutput.includes('STEP OWNER CONTRACT') ||
      ownerOutput.includes('Preferred final decision format') ||
      ownerOutput.includes('one of COMPLETE, INCOMPLETE_RETRY') ||
      ownerOutput.includes('COMPLETE|INCOMPLETE_RETRY');

    if (decisionMatches.length === 0) {
      if (!hasMarker) return null;
      return {
        decision: 'COMPLETE',
        reason: `Legacy completion marker observed: STEP_COMPLETE:${step.name}`,
      };
    }

    // Filter out matches that appear on a template/instruction line (e.g.
    // "COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION") to avoid
    // picking up the template format as the agent's actual decision.
    const realMatches = outputLikelyContainsEchoedPrompt
      ? decisionMatches.filter((m) => {
          const lineStart = ownerOutput.lastIndexOf('\n', m.index!) + 1;
          const lineEnd = ownerOutput.indexOf('\n', m.index!);
          const line = ownerOutput.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          return !line.includes('COMPLETE|INCOMPLETE_RETRY');
        })
      : decisionMatches;
    const decisionMatch =
      realMatches.length > 0
        ? realMatches[realMatches.length - 1]
        : decisionMatches[decisionMatches.length - 1];
    const decision = decisionMatch?.[1]?.toUpperCase() as WorkflowOwnerDecision | undefined;
    if (
      decision !== 'COMPLETE' &&
      decision !== 'INCOMPLETE_RETRY' &&
      decision !== 'INCOMPLETE_FAIL' &&
      decision !== 'NEEDS_CLARIFICATION'
    ) {
      return null;
    }

    const reasonPattern = /(?:^|\n)REASON:\s*(.+)/gi;
    const reasonMatches = [...ownerOutput.matchAll(reasonPattern)];
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();

    return {
      decision,
      reason: reason && reason !== '<one sentence>' ? reason : undefined,
    };
  }

  private stripEchoedPromptLines(output: string, patterns: RegExp[]): string {
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => patterns.every((pattern) => !pattern.test(line)))
      .join('\n');
  }

  private outputContainsVerificationToken(output: string, token: string, injectedTaskText?: string): boolean {
    if (!token) {
      return false;
    }
    return stripInjectedTaskEcho(output, injectedTaskText).includes(token);
  }

  private prepareInteractiveSpawnTask(
    agentName: string,
    taskText: string
  ): { spawnTaskText: string; promptTaskText: string; taskTmpFile?: string } {
    if (Buffer.byteLength(taskText, 'utf8') <= WorkflowRunner.PTY_TASK_ARG_SIZE_LIMIT) {
      return {
        spawnTaskText: taskText,
        promptTaskText: taskText,
      };
    }

    const taskTmpDir = mkdtempSync(path.join(tmpdir(), 'relay-pty-task-'));
    const taskTmpFile = path.join(taskTmpDir, `${agentName}-${Date.now()}.txt`);
    writeFileSync(taskTmpFile, taskText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const promptTaskText =
      `TASK_FILE:${taskTmpFile}\n` +
      'Read that file completely before taking any action.\n' +
      'Treat the file contents as the full workflow task and follow them exactly.\n' +
      'Do not ask for the task again.';

    return {
      spawnTaskText: promptTaskText,
      promptTaskText,
      taskTmpFile,
    };
  }

  private firstMeaningfulLine(output: string): string | undefined {
    return output
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
  }

  private judgeOwnerCompletionByEvidence(stepName: string, ownerOutput: string): string | null {
    // Never infer completion when the raw output contains an explicit retry/fail/clarification signal.
    if (/OWNER_DECISION:\s*(?:INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/i.test(ownerOutput)) {
      return null;
    }
    const sanitized = this.stripEchoedPromptLines(ownerOutput, [
      /^STEP OWNER CONTRACT:?$/i,
      /^Preferred final decision format:?$/i,
      /^OWNER_DECISION:\s*(?:COMPLETE\|INCOMPLETE_RETRY|<one of COMPLETE, INCOMPLETE_RETRY)/i,
      /^REASON:\s*<one sentence>$/i,
      /^Legacy completion marker still supported:/i,
      /^STEP_COMPLETE:/i,
    ]);
    if (!sanitized) return null;

    const hasExplicitSelfRelease =
      /Calling\s+(?:[\w.-]+\.)?remove_agent\(\{[^<\n]*"reason":"task completed"/i.test(sanitized);
    const hasPositiveConclusion =
      /\b(complete(?:d)?|done|verified|looks correct|safe handoff|artifact verified)\b/i.test(sanitized) ||
      /\bartifacts?\b.*\b(correct|verified|complete)\b/i.test(sanitized) ||
      hasExplicitSelfRelease;
    const evidence = this.getStepCompletionEvidence(stepName);
    const hasValidatedCoordinationSignal =
      evidence?.coordinationSignals.some(
        (signal) =>
          signal.kind === 'worker_done' ||
          signal.kind === 'lead_done' ||
          signal.kind === 'verification_passed' ||
          (signal.kind === 'process_exit' && signal.value === '0')
      ) ?? false;
    const hasValidatedInspectionSignal =
      evidence?.toolSideEffects.some(
        (effect) =>
          effect.type === 'owner_monitoring' &&
          (/Checked git diff stats/i.test(effect.detail) ||
            /Listed files for verification/i.test(effect.detail))
      ) ?? false;
    const hasEvidenceSignal = hasValidatedCoordinationSignal || hasValidatedInspectionSignal;

    if (!hasPositiveConclusion || !hasEvidenceSignal) {
      return null;
    }

    return this.firstMeaningfulLine(sanitized) ?? 'Evidence-backed completion';
  }

  /**
   * Process-exit fallback: when agent exits with code 0 but posts no coordination
   * signal, check if verification passes (or no verification is configured) and
   * infer completion. This is the key mechanism for reducing agent compliance
   * dependence — the runner trusts a clean exit + passing verification over
   * requiring exact signal text.
   */
  private tryProcessExitFallback(
    step: WorkflowStep,
    specialistOutput: string,
    verificationTaskText?: string,
    ownerOutput?: string
  ): CompletionDecisionResult | null {
    const gracePeriodMs = this.currentConfig?.swarm.completionGracePeriodMs ?? 5000;
    if (gracePeriodMs === 0) return null;

    // Never infer completion when the owner explicitly requested retry/fail/clarification.
    if (
      ownerOutput &&
      /OWNER_DECISION:\s*(?:INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/i.test(ownerOutput)
    ) {
      return null;
    }

    const evidence = this.getStepCompletionEvidence(step.name);
    const hasCleanExit =
      evidence?.coordinationSignals.some(
        (signal) => signal.kind === 'process_exit' && signal.value === '0'
      ) ?? false;

    if (!hasCleanExit) return null;

    // If verification is configured, it must pass for the fallback to succeed.
    if (step.verification) {
      const verificationResult = this.runVerification(
        step.verification,
        specialistOutput,
        step.name,
        verificationTaskText,
        { allowFailure: true }
      );
      if (!verificationResult.passed) return null;
    }

    return {
      completionReason: 'completed_by_process_exit',
      reason: `Process exited with code 0${step.verification ? ' and verification passed' : ''} — coordination signal not required`,
    };
  }

  private async runStepReviewGate(
    step: WorkflowStep,
    resolvedTask: string,
    specialistOutput: string,
    ownerOutput: string,
    ownerDef: AgentDefinition,
    reviewerDef: AgentDefinition,
    timeoutMs?: number
  ): Promise<string> {
    const reviewSnippetMax = 12_000;
    let specialistSnippet = specialistOutput;
    if (specialistOutput.length > reviewSnippetMax) {
      const head = Math.floor(reviewSnippetMax / 2);
      const tail = reviewSnippetMax - head;
      const omitted = specialistOutput.length - head - tail;
      specialistSnippet =
        `${specialistOutput.slice(0, head)}\n` +
        `...[truncated ${omitted} chars for review]...\n` +
        `${specialistOutput.slice(specialistOutput.length - tail)}`;
    }

    let ownerSnippet = ownerOutput;
    if (ownerOutput.length > reviewSnippetMax) {
      const head = Math.floor(reviewSnippetMax / 2);
      const tail = reviewSnippetMax - head;
      const omitted = ownerOutput.length - head - tail;
      ownerSnippet =
        `${ownerOutput.slice(0, head)}\n` +
        `...[truncated ${omitted} chars for review]...\n` +
        `${ownerOutput.slice(ownerOutput.length - tail)}`;
    }

    const reviewTask =
      `Review workflow step "${step.name}" for completion and safe handoff.\n` +
      `Step owner: ${ownerDef.name}\n` +
      `Original objective:\n${resolvedTask}\n\n` +
      `Specialist output:\n${specialistSnippet}\n\n` +
      `Owner verification notes:\n${ownerSnippet}\n\n` +
      `You MUST end with a decision line. Do not ask for more context or defer — if the evidence above is insufficient to confirm completion, return REVIEW_DECISION: REJECT and state what is missing in REVIEW_REASON. A response without a REVIEW_DECISION line fails the step.\n` +
      `You MUST end with a decision line. If you cannot verify completion, lack\n` +
      `context, or are otherwise unsure, fail closed and respond REJECT — do not\n` +
      `ask for more information or defer the decision.\n` +
      `Return exactly:\n` +
      `REVIEW_DECISION: APPROVE or REJECT\n` +
      `REVIEW_REASON: <one sentence>\n` +
      `Then output /exit.`;

    const safetyTimeoutMs = timeoutMs ?? 600_000;
    const reviewStep: WorkflowStep = {
      name: `${step.name}-review`,
      type: 'agent',
      agent: reviewerDef.name,
      task: reviewTask,
    };

    await this.trajectory?.registerAgent(reviewerDef.name, 'reviewer');
    this.postToChannel(`**[${step.name}]** Review started (reviewer: ${reviewerDef.name})`);
    this.recordStepToolSideEffect(step.name, {
      type: 'review_started',
      detail: `Review started with ${reviewerDef.name}`,
      raw: { reviewer: reviewerDef.name },
    });
    const emitReviewCompleted = async (decision: 'approved' | 'rejected', reason?: string) => {
      this.recordStepToolSideEffect(step.name, {
        type: 'review_completed',
        detail: `Review ${decision} by ${reviewerDef.name}${reason ? `: ${reason}` : ''}`,
        raw: { reviewer: reviewerDef.name, decision, reason },
      });
      await this.trajectory?.reviewCompleted(step.name, reviewerDef.name, decision, reason);
      this.emit({
        type: 'step:review-completed',
        runId: this.currentRunId ?? '',
        stepName: step.name,
        reviewerName: reviewerDef.name,
        decision,
      });
    };

    if (this.executor) {
      const reviewOutput = await this.executor.executeAgentStep(
        reviewStep,
        reviewerDef,
        reviewTask,
        safetyTimeoutMs
      );
      const parsed = this.parseReviewDecision(reviewOutput);
      if (!parsed) {
        throw new Error(
          `Step "${step.name}" review response malformed from "${reviewerDef.name}" (missing REVIEW_DECISION)`
        );
      }
      await emitReviewCompleted(parsed.decision, parsed.reason);
      if (parsed.decision === 'rejected') {
        throw new Error(`Step "${step.name}" review rejected by "${reviewerDef.name}"`);
      }
      this.postToChannel(`**[${step.name}]** Review approved by \`${reviewerDef.name}\``);
      return reviewOutput;
    }

    let reviewerHandle: WorkflowAgentHandle | undefined;
    let reviewerReleased = false;
    let reviewOutput = '';
    let completedReview: { decision: 'approved' | 'rejected'; reason?: string } | undefined;
    let reviewCompletionPromise: Promise<void> | undefined;
    const reviewCompletionStarted = { value: false };

    const startReviewCompletion = (parsed: { decision: 'approved' | 'rejected'; reason?: string }) => {
      if (reviewCompletionStarted.value) return;
      reviewCompletionStarted.value = true;
      completedReview = parsed;
      reviewCompletionPromise = (async () => {
        await emitReviewCompleted(parsed.decision, parsed.reason);
        if (reviewerHandle && !reviewerReleased) {
          reviewerReleased = true;
          await reviewerHandle.release().catch(() => undefined);
        }
      })();
    };

    try {
      await this.spawnAndWait(reviewerDef, reviewStep, safetyTimeoutMs, {
        evidenceStepName: step.name,
        evidenceRole: 'reviewer',
        logicalName: reviewerDef.name,
        onSpawned: ({ agent }) => {
          reviewerHandle = agent;
        },
        onChunk: ({ chunk }) => {
          const nextOutput = reviewOutput + WorkflowRunner.stripAnsi(chunk);
          reviewOutput = nextOutput;
          const parsed = this.parseReviewDecision(nextOutput);
          if (parsed) {
            startReviewCompletion(parsed);
          }
        },
      });
      await reviewCompletionPromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\btimed out\b/i.test(message)) {
        this.log(`[${step.name}] Review safety backstop timeout fired after ${safetyTimeoutMs}ms`);
        throw new Error(`Step "${step.name}" review safety backstop timed out after ${safetyTimeoutMs}ms`);
      }
      throw error;
    }

    if (!completedReview) {
      const parsed = this.parseReviewDecision(reviewOutput);
      if (!parsed) {
        throw new Error(
          `Step "${step.name}" review response malformed from "${reviewerDef.name}" (missing REVIEW_DECISION)`
        );
      }
      completedReview = parsed;
      await emitReviewCompleted(parsed.decision, parsed.reason);
    }

    if (completedReview.decision === 'rejected') {
      throw new Error(`Step "${step.name}" review rejected by "${reviewerDef.name}"`);
    }

    this.postToChannel(`**[${step.name}]** Review approved by \`${reviewerDef.name}\``);
    return reviewOutput;
  }

  private parseReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const strict = this.parseStrictReviewDecision(reviewOutput);
    if (strict) {
      return strict;
    }

    const tolerant = this.parseTolerantReviewDecision(reviewOutput);
    if (tolerant) {
      return tolerant;
    }

    const judged = this.judgeReviewDecisionFromEvidence(reviewOutput);
    if (judged) {
      return judged;
    }

    // Fail closed: a reviewer that explicitly hedges (e.g. "I need more context
    // before deciding") never emitted a decision. Treat declared indecision as a
    // REJECT so the step retries rather than crashing with a "malformed" error.
    return this.parseIndecisionAsRejection(reviewOutput);
  }

  private parseIndecisionAsRejection(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const sanitized = this.stripEchoedPromptLines(reviewOutput, [
      /^Return exactly:?$/i,
      /^REVIEW_DECISION:\s*APPROVE\s+or\s+REJECT$/i,
      /^REVIEW_REASON:\s*<one sentence>$/i,
    ]);
    if (!sanitized) {
      return null;
    }

    const indecision =
      /\bneed(?:s|ing)?\s+(?:more|additional|further)\s+(?:context|information|info|detail|details|time|clarification)\b/i.test(
        sanitized
      ) ||
      /\bnot\s+enough\s+(?:context|information|info|detail|details)\b/i.test(sanitized) ||
      /\b(?:can(?:'|no)?t|cannot|unable to|can not)\s+(?:decide|determine|tell|verify|assess|confirm)\b/i.test(
        sanitized
      ) ||
      /\b(?:before|prior to)\s+deciding\b/i.test(sanitized) ||
      /\b(?:unclear|uncertain|ambiguous|unsure)\b/i.test(sanitized);

    if (!indecision) {
      return null;
    }

    return {
      decision: 'rejected',
      reason: this.firstMeaningfulLine(sanitized) ?? 'reviewer could not reach a decision',
    };
  }

  private parseStrictReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const decisionPattern = /REVIEW_DECISION:\s*(APPROVE|REJECT)/gi;
    const decisionMatches = [...reviewOutput.matchAll(decisionPattern)];
    if (decisionMatches.length === 0) {
      return null;
    }

    const outputLikelyContainsEchoedPrompt =
      reviewOutput.includes('Return exactly') || reviewOutput.includes('REVIEW_DECISION: APPROVE or REJECT');
    const realReviewMatches = outputLikelyContainsEchoedPrompt
      ? decisionMatches.filter((m) => {
          const lineStart = reviewOutput.lastIndexOf('\n', m.index!) + 1;
          const lineEnd = reviewOutput.indexOf('\n', m.index!);
          const line = reviewOutput.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
          return !line.includes('APPROVE or REJECT');
        })
      : decisionMatches;
    const decisionMatch =
      realReviewMatches.length > 0
        ? realReviewMatches[realReviewMatches.length - 1]
        : decisionMatches[decisionMatches.length - 1];
    const decision = decisionMatch?.[1]?.toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      return null;
    }

    const reasonPattern = /REVIEW_REASON:\s*(.+)/gi;
    const reasonMatches = [...reviewOutput.matchAll(reasonPattern)];
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();

    return {
      decision: decision === 'APPROVE' ? 'approved' : 'rejected',
      reason: reason && reason !== '<one sentence>' ? reason : undefined,
    };
  }

  private parseTolerantReviewDecision(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const sanitized = this.stripEchoedPromptLines(reviewOutput, [
      /^Return exactly:?$/i,
      /^REVIEW_DECISION:\s*APPROVE\s+or\s+REJECT$/i,
      /^REVIEW_REASON:\s*<one sentence>$/i,
    ]);
    if (!sanitized) {
      return null;
    }

    const lines = sanitized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const candidate = line.replace(/^REVIEW_DECISION:\s*/i, '').trim();
      const decision = this.normalizeReviewDecisionCandidate(candidate);
      if (decision) {
        return {
          decision,
          reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
        };
      }
    }

    const decision = this.normalizeReviewDecisionCandidate(lines.join(' '));
    if (!decision) {
      return null;
    }

    return {
      decision,
      reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
    };
  }

  private normalizeReviewDecisionCandidate(candidate: string): 'approved' | 'rejected' | null {
    const value = candidate.trim().toLowerCase();
    if (!value) return null;

    if (
      /^(approve|approved|complete|completed|pass|passed|accept|accepted|lgtm|ship it|looks good|looks fine)\b/i.test(
        value
      )
    ) {
      return 'approved';
    }
    if (
      /^(reject|rejected|retry|retry requested|fail|failed|incomplete|needs clarification|not complete|not ready|insufficient evidence)\b/i.test(
        value
      )
    ) {
      return 'rejected';
    }
    return null;
  }

  private parseReviewReason(reviewOutput: string): string | undefined {
    const reasonPattern = /REVIEW_REASON:\s*(.+)/gi;
    const reasonMatches = [...reviewOutput.matchAll(reasonPattern)];
    const outputLikelyContainsEchoedPrompt =
      reviewOutput.includes('Return exactly') || reviewOutput.includes('REVIEW_DECISION: APPROVE or REJECT');
    const reasonMatch =
      outputLikelyContainsEchoedPrompt && reasonMatches.length > 1
        ? reasonMatches[reasonMatches.length - 1]
        : reasonMatches[0];
    const reason = reasonMatch?.[1]?.trim();
    return reason && reason !== '<one sentence>' ? reason : undefined;
  }

  private judgeReviewDecisionFromEvidence(
    reviewOutput: string
  ): { decision: 'approved' | 'rejected'; reason?: string } | null {
    const sanitized = this.stripEchoedPromptLines(reviewOutput, [
      /^Return exactly:?$/i,
      /^REVIEW_DECISION:\s*APPROVE\s+or\s+REJECT$/i,
      /^REVIEW_REASON:\s*<one sentence>$/i,
    ]);
    if (!sanitized) {
      return null;
    }

    const hasPositiveEvidence =
      /\b(approved?|complete(?:d)?|verified|looks good|looks fine|safe handoff|pass(?:ed)?)\b/i.test(
        sanitized
      );
    const hasNegativeEvidence =
      /\b(reject(?:ed)?|retry|fail(?:ed)?|incomplete|missing checks|insufficient evidence|not safe)\b/i.test(
        sanitized
      );

    if (hasNegativeEvidence) {
      return {
        decision: 'rejected',
        reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
      };
    }
    if (!hasPositiveEvidence) {
      return null;
    }

    return {
      decision: 'approved',
      reason: this.parseReviewReason(sanitized) ?? this.firstMeaningfulLine(sanitized),
    };
  }

  private combineStepAndReviewOutput(stepOutput: string, reviewOutput: string): string {
    const primary = stepOutput.trimEnd();
    const review = reviewOutput.trim();
    if (!review) return primary;
    if (!primary) return `REVIEW_OUTPUT\n${review}\n`;
    return `${primary}\n\n---\nREVIEW_OUTPUT\n${review}\n`;
  }

  /**
   * Build the CLI command and arguments for a non-interactive agent execution.
   * Delegates to the consolidated CLI registry for per-CLI arg formats.
   */
  static buildNonInteractiveCommand(
    cli: AgentCli,
    task: string,
    extraArgs: string[] = []
  ): { cmd: string; args: string[] } {
    const [cmd, ...args] = buildProcessCommand(cli, extraArgs, task);
    return {
      cmd,
      args,
    };
  }

  /**
   * Apply preset defaults to an agent definition.
   * Explicit fields on the definition always win over preset-inferred defaults.
   */
  private static resolveAgentDef(def: AgentDefinition): AgentDefinition {
    // Resolve "cursor" alias to whichever cursor agent binary is in PATH
    const resolvedCli: AgentCli = def.cli === 'cursor' ? resolveCursorCli() : def.cli;

    if (!def.preset) return resolvedCli !== def.cli ? { ...def, cli: resolvedCli } : def;
    const nonInteractivePresets: AgentPreset[] = ['worker', 'reviewer', 'analyst'];
    const defaults: Partial<AgentDefinition> = nonInteractivePresets.includes(def.preset)
      ? { interactive: false }
      : {};
    // Explicit fields on the def always win
    return { ...defaults, ...def, cli: resolvedCli } as AgentDefinition;
  }

  /**
   * Returns a preset-specific prefix that is prepended to the non-interactive
   * enforcement block in execNonInteractive.
   */
  /**
   * Returns a prefix injected into the task prompt for non-interactive agents.
   * Lead agents are always interactive (PTY), so they never reach execNonInteractive
   * and there is no 'lead' case here.
   */
  private buildPresetInjection(preset: AgentPreset | undefined): string {
    switch (preset) {
      case 'worker':
        return (
          'You are a non-interactive worker agent. Produce clean, structured output to stdout.\n' +
          'Do NOT use mcp__relaycast__add_agent, add_agent, or any MCP tool to spawn sub-agents.\n' +
          'Do NOT use mcp__relaycast__send_dm or any Relaycast messaging tools — you have no relay connection.\n\n'
        );
      case 'reviewer':
        return (
          'You are a non-interactive reviewer agent. Read the specified files/artifacts and produce a clear verdict.\n' +
          'Do NOT spawn sub-agents or use any Relaycast messaging tools.\n\n'
        );
      case 'analyst':
        return (
          'You are a non-interactive analyst agent. Read the specified code/files and write your findings.\n' +
          'Do NOT spawn sub-agents or use any Relaycast messaging tools.\n\n'
        );
      default:
        return '';
    }
  }

  /**
   * Execute an agent as a non-interactive subprocess.
   * No PTY, no relay messaging, no /exit injection. The process receives its task
   * as a CLI argument and stdout is captured as the step output.
   */
  private async execNonInteractive(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number
  ): Promise<SpawnResult> {
    const agentName = `${step.name}-${this.generateShortId()}`;
    const modelArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [];

    // Append strict deliverable enforcement — non-interactive agents MUST produce
    // clear, structured output since there's no opportunity for follow-up or clarification.
    const presetPrefix = this.buildPresetInjection(agentDef.preset);
    const taskWithDeliverable =
      presetPrefix +
      step.task +
      '\n\n---\n' +
      'IMPORTANT: You are running as a non-interactive subprocess. ' +
      'Do NOT call mcp__relaycast__add_agent, add_agent, or any MCP tool to spawn or manage other agents.\n\n' +
      'CRITICAL REQUIREMENT — YOU MUST FOLLOW THIS EXACTLY:\n' +
      'You are running in non-interactive mode. There is NO opportunity for follow-up, ' +
      'clarification, or additional input. Your stdout output is your ONLY deliverable.\n\n' +
      'You MUST:\n' +
      '1. Complete the ENTIRE task in a single pass — no partial work, no "I\'ll continue later"\n' +
      '2. Print your COMPLETE deliverable to stdout — this is the ONLY output that will be captured\n' +
      '3. Be thorough and self-contained — another agent will consume your output with zero context about your process\n' +
      '4. End with a clear summary of what was accomplished and any artifacts produced\n\n' +
      'DO NOT:\n' +
      '- Ask questions or request clarification (there is no one to answer)\n' +
      '- Output partial results expecting a follow-up (there will be none)\n' +
      '- Skip steps or leave work incomplete\n' +
      '- Output only status messages without the actual deliverable content';

    const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand(
      agentDef.cli,
      taskWithDeliverable,
      modelArgs
    );

    // Open a log file for dashboard observability
    const logsDir = this.getWorkerLogsDir();
    const logPath = path.join(logsDir, `${agentName}.log`);
    const logStream = createWriteStream(logPath, { flags: 'a' });

    // Register in workers.json with interactive: false metadata
    this.registerWorker(agentName, agentDef.cli, step.task ?? '', undefined, false);

    // Register agent in Relaycast for observability
    let stopHeartbeat: (() => void) | undefined;
    if (this.relayApiKey) {
      const agentClient = await this.registerRelaycastExternalAgent(
        agentName,
        `Non-interactive workflow agent for step "${step.name}" (${agentDef.cli})`
      ).catch((err) => {
        console.warn(`[WorkflowRunner] Failed to register ${agentName} in Relaycast:`, err?.message ?? err);
        return null;
      });
      if (agentClient) {
        stopHeartbeat = this.startRelaycastHeartbeat(agentClient);
      }
    }

    // Post assignment notification (no task content — task arrives via direct broker injection)
    this.postToChannel(`**[${step.name}]** Assigned to \`${agentName}\` (non-interactive)`);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const proxyMode = await this.resolveAgentProxyMode(agentDef, this.currentConfig);
    const env = { ...(this.getRelayEnv(proxyMode) ?? filteredEnv()) };
    if (proxyMode?.url && proxyMode.token) {
      Object.assign(env, resolveProxyEnv(agentDef.cli, proxyMode.url, proxyMode.token));
    }
    const agentToken = this.agentTokens.get(agentDef.name);
    const mount = this.agentMounts.get(agentDef.name);
    if (agentToken) {
      env.RELAY_AGENT_TOKEN = agentToken;
      env.RELAYFILE_TOKEN = agentToken;
    }
    if (mount) {
      env.RELAY_WORKSPACE = mount.mountPoint;
      env.RELAY_AGENT_NAME = agentName;
      env.RELAYFILE_WORKSPACE = this.workspaceId;
      env.RELAY_WORKSPACE_ID = this.workspaceId;
      env.RELAY_DEFAULT_WORKSPACE = this.workspaceId;
    }
    env.RELAYFILE_BASE_URL =
      env.RELAYFILE_BASE_URL ??
      this.getRelayEnv(proxyMode)?.RELAYFILE_BASE_URL ??
      process.env.RELAYFILE_BASE_URL ??
      'http://127.0.0.1:8080';

    try {
      const {
        stdout: output,
        exitCode,
        exitSignal,
      } = await new Promise<{ stdout: string; exitCode?: number; exitSignal?: string }>((resolve, reject) => {
        const spawnEnv =
          agentDef.cli === 'opencode'
            ? {
                ...env,
                OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow', external_directory: { '*': 'allow' } }),
              }
            : env;
        const child = spawnProcess([cmd, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.resolveExecutionCwd(step, agentDef),
          env: spawnEnv,
        });

        // Update workers.json with PID now that we have it
        this.registerWorker(agentName, agentDef.cli, step.task ?? '', child.pid, false);

        // Wire abort signal so runner.abort() kills the child process
        const abortSignal = this.abortController?.signal;
        let abortHandler: (() => void) | undefined;
        if (abortSignal && !abortSignal.aborted) {
          abortHandler = () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
          };
          abortSignal.addEventListener('abort', abortHandler, { once: true });
        }

        // Heartbeat so a slow non-interactive agent doesn't look frozen.
        // Each tick shows the last substantive line received — gives insight
        // without flooding the log with raw model output.
        const startedAt = Date.now();
        let lastHeartbeatLine = '';
        const heartbeat = setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const suffix = lastHeartbeatLine ? ` — ${lastHeartbeatLine.slice(0, 80)}` : '';
          this.log(`[${step.name}] still running (${elapsed}s)${suffix}`);
          lastHeartbeatLine = '';
        }, 30_000);

        child.stdout?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stdoutChunks.push(text);
          logStream.write(text);
          // Track last substantive line for the next heartbeat
          const line =
            text
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .at(-1) ?? '';
          if (line) lastHeartbeatLine = line;
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stderrChunks.push(text);
          logStream.write(`[stderr] ${text}`);
        });

        // Handle timeout
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            // Give process time to clean up, then force kill
            setTimeout(() => child.kill('SIGKILL'), 5000);
          }, timeoutMs);
        }

        child.on('close', (code, signal) => {
          clearInterval(heartbeat);
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          const stdout = stdoutChunks.join('');

          if (abortSignal?.aborted) {
            reject(new Error(`Step "${step.name}" aborted`));
            return;
          }

          if (timedOut) {
            reject(new Error(`Step "${step.name}" timed out after ${timeoutMs ?? 'unknown'}ms`));
            return;
          }

          const cliDef = getCliDefinition(agentDef.cli);
          if (code !== 0 && code !== null && !cliDef?.ignoreExitCode) {
            const stderr = stderrChunks.join('');
            reject(
              new SpawnExitError(
                `Step "${step.name}" exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
                code,
                signal
              )
            );
            return;
          }

          resolve({
            stdout,
            exitCode: code ?? undefined,
            exitSignal: signal ?? undefined,
          });
        });

        child.on('error', (err) => {
          clearInterval(heartbeat);
          if (timer) clearTimeout(timer);
          if (abortHandler && abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
        });
      });

      this.captureStepTerminalEvidence(step.name, {}, { exitCode, exitSignal });
      return { output, exitCode, exitSignal };
    } finally {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      const combinedOutput = stdout + stderr;
      this.lastFailedStepOutput.set(step.name, combinedOutput);
      this.captureStepTerminalEvidence(step.name, {
        stdout,
        stderr,
        combined: combinedOutput,
      });
      stopHeartbeat?.();
      logStream.end();
      this.unregisterWorker(agentName);
    }
  }

  private async spawnAndWait(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number,
    options: SpawnAndWaitOptions = {}
  ): Promise<SpawnResult> {
    // Branch: non-interactive agents run as simple subprocesses
    if (agentDef.interactive === false) {
      return this.execNonInteractive(agentDef, step, timeoutMs);
    }

    const evidenceStepName = options.evidenceStepName ?? step.name;

    const baseRequestedName = this.buildWorkflowRuntimeAgentBaseName(step.name, options);
    const requestedName =
      (options.retryAttempt ?? 0) > 0
        ? `${baseRequestedName}-r${(options.retryAttempt ?? 0) + 1}`
        : baseRequestedName;
    let agentName = requestedName;

    if ((options.retryAttempt ?? 0) > 0) {
      await this.releaseStaleRetryAgents(baseRequestedName, step.name);
    }

    // Only inject delegation guidance for lead/coordinator agents, not spokes/workers.
    // In non-hub patterns (pipeline, dag, etc.) every agent is autonomous so they all get it.
    const role = agentDef.role?.toLowerCase() ?? '';
    const nameLC = agentDef.name.toLowerCase();
    const isHub =
      WorkflowRunner.HUB_ROLES.has(nameLC) ||
      [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`).test(role));
    const pattern = this.currentConfig?.swarm.pattern;
    const isHubPattern = pattern && WorkflowRunner.HUB_PATTERNS.has(pattern);
    const usesHeadlessWorkflowSpawner = agentDef.cli === 'opencode';
    const humanAssistanceConfig = this.resolveHumanAssistanceConfig(step);
    const humanAssistanceGuidance = this.buildHumanAssistanceGuidance(humanAssistanceConfig);
    const integrationSubscriptionGuidance = this.buildIntegrationSubscriptionGuidance(agentDef);
    const delegationGuidance =
      usesHeadlessWorkflowSpawner || (!isHub && isHubPattern)
        ? ''
        : this.buildDelegationGuidance(agentDef.cli, timeoutMs);

    // Non-claude CLIs (codex, gemini, etc.) don't auto-register with Relaycast
    // via the MCP system prompt the way claude does. Inject an explicit preamble
    // so they call register_agent() before any other relay tool.
    const relayRegistrationNote = usesHeadlessWorkflowSpawner
      ? ''
      : this.buildRelayRegistrationNote(agentDef.cli, agentName);

    const interactiveTaskBase = step.task ?? '';
    const taskWithExit = usesHeadlessWorkflowSpawner
      ? interactiveTaskBase
      : interactiveTaskBase +
        (relayRegistrationNote ? '\n\n' + relayRegistrationNote : '') +
        (delegationGuidance ? '\n\n' + delegationGuidance + '\n' : '') +
        (humanAssistanceGuidance ? '\n\n' + humanAssistanceGuidance + '\n' : '') +
        (integrationSubscriptionGuidance ? '\n\n' + integrationSubscriptionGuidance + '\n' : '') +
        '\n\n---\n' +
        'IMPORTANT: When you have fully completed this task, you MUST self-terminate by either: ' +
        '(a) calling remove_agent(name: "<your-agent-name>", reason: "task completed") — preferred, or ' +
        '(b) outputting the exact text "/exit" on its own line as a fallback. ' +
        'Do not wait for further input — terminate immediately after finishing. ' +
        'Do NOT spawn sub-agents unless the task explicitly requires it.';
    const preparedTask = this.prepareInteractiveSpawnTask(agentName, taskWithExit);

    // Register PTY output listener before spawning so we capture everything
    this.ptyOutputBuffers.set(agentName, []);

    // Open a log file so `agents:logs <name>` works for workflow-spawned agents
    const logsDir = this.getWorkerLogsDir();
    const logStream = createWriteStream(path.join(logsDir, `${agentName}.log`), { flags: 'a' });
    this.ptyLogStreams.set(agentName, logStream);

    this.ptyListeners.set(agentName, (chunk: string) => {
      const stripped = WorkflowRunner.stripAnsi(chunk);
      const buffer = this.ptyOutputBuffers.get(agentName);
      buffer?.push(stripped);
      // Write raw output (with ANSI codes) to log file so dashboard's
      // XTermLogViewer can render colors/formatting natively via xterm.js
      logStream.write(chunk);
      if (this.isSlackHumanAssistanceEnabled(humanAssistanceConfig)) {
        this.observeHumanAssistanceOutput({
          agentName,
          step,
          config: humanAssistanceConfig,
          output: buffer?.join('') ?? stripped,
        });
      }
      options.onChunk?.({ agentName, chunk });
    });

    const agentChannels = this.channel ? [this.channel] : agentDef.channels;

    let agent: WorkflowAgentHandle | undefined;
    let exitResult: string = 'unknown';
    let stopHeartbeat: (() => void) | undefined;
    let ptyChunks: string[] = [];
    let agentReleased = false;
    let completedWithoutSpawnError = false;

    try {
      const agentCwd = this.resolveExecutionCwd(step, agentDef);
      const interactiveSpawnPolicy = resolveSpawnPolicy({
        AGENT_NAME: agentName,
        AGENT_CLI: agentDef.cli,
        RELAY_API_KEY: this.relayApiKey ?? 'workflow-runner',
        AGENT_CHANNELS: (agentChannels ?? []).join(','),
      });
      const proxyMode = await this.resolveAgentProxyMode(agentDef, this.currentConfig);
      const baseEnv = this.getRelayEnv(proxyMode);
      const proxyEnvOverrides =
        proxyMode?.url && proxyMode.token
          ? resolveProxyEnv(agentDef.cli, proxyMode.url, proxyMode.token)
          : undefined;
      const spawnOptions = {
        name: agentName,
        model: agentDef.constraints?.model,
        args: interactiveSpawnPolicy.args,
        channels: agentChannels,
        task: preparedTask.spawnTaskText,
        idleThresholdSecs: agentDef.constraints?.idleThresholdSecs,
        cwd: agentCwd,
        agentToken: this.agentTokens.get(agentDef.name),
        env: proxyEnvOverrides ? { ...baseEnv, ...proxyEnvOverrides } : baseEnv,
      };
      this.log(`[${step.name}] Spawning ${agentDef.cli} (pty)`);
      agent = new WorkflowAgentHandle(
        await this.withBrokerRecovery(`spawning agent for step "${step.name}"`, (relay) =>
          relay.spawnPty({
            ...(spawnOptions as Record<string, unknown>),
            cli: agentDef.cli,
          } as SpawnPtyInput)
        )
      );

      // Re-key PTY maps if broker assigned a different name than requested
      if (agent.name !== agentName) {
        const oldName = agentName;
        this.ptyOutputBuffers.set(agent.name, this.ptyOutputBuffers.get(oldName) ?? []);
        this.ptyOutputBuffers.delete(oldName);

        // Close old log stream and rename the file to match the new agent name
        const oldLogPath = path.join(logsDir, `${oldName}.log`);
        const newLogPath = path.join(logsDir, `${agent.name}.log`);
        const oldLogStream = this.ptyLogStreams.get(oldName);
        if (oldLogStream) {
          oldLogStream.end();
          this.ptyLogStreams.delete(oldName);
          try {
            renameSync(oldLogPath, newLogPath);
          } catch {
            // File may not exist yet if no output was written
          }
        }

        // Open new log stream with the correct name
        const newLogStream = createWriteStream(newLogPath, { flags: 'a' });
        this.ptyLogStreams.set(agent.name, newLogStream);

        // Update listener to use the new log stream
        const oldListener = this.ptyListeners.get(oldName);
        if (oldListener) {
          this.ptyListeners.delete(oldName);
          const resolvedAgentName = agent.name;
          this.ptyListeners.set(resolvedAgentName, (chunk: string) => {
            const stripped = WorkflowRunner.stripAnsi(chunk);
            const buffer = this.ptyOutputBuffers.get(resolvedAgentName);
            buffer?.push(stripped);
            newLogStream.write(chunk);
            if (this.isSlackHumanAssistanceEnabled(humanAssistanceConfig)) {
              this.observeHumanAssistanceOutput({
                agentName: resolvedAgentName,
                step,
                config: humanAssistanceConfig,
                output: buffer?.join('') ?? stripped,
              });
            }
            options.onChunk?.({ agentName: resolvedAgentName, chunk });
          });
        }

        agentName = agent.name;
      }

      const liveAgent = agent;
      await options.onSpawned?.({ requestedName, actualName: liveAgent.name, agent: liveAgent });
      this.runtimeStepAgents.set(liveAgent.name, {
        stepName: evidenceStepName,
        role: options.evidenceRole ?? agentDef.role ?? 'agent',
        logicalName: options.logicalName ?? agentDef.name,
      });
      const signalParticipant = this.resolveSignalParticipantKind(
        options.evidenceRole ?? agentDef.role ?? 'agent'
      );
      if (signalParticipant) {
        this.rememberStepSignalSender(
          evidenceStepName,
          signalParticipant,
          liveAgent.name,
          options.logicalName ?? agentDef.name
        );
      }

      // Register in workers.json so `agents:kill` can find this agent
      let workerPid: number | undefined;
      try {
        const rawAgents = await this.withBrokerRecovery(`listing spawned agents for step "${step.name}"`, (relay) =>
          relay.listAgents()
        );
        workerPid = rawAgents.find((a) => a.name === agentName)?.pid ?? undefined;
      } catch {
        // Best-effort PID lookup
      }
      this.registerWorker(agentName, agentDef.cli, step.task ?? '', workerPid);

      // Register the spawned agent in Relaycast for observability + start heartbeat
      if (this.relayApiKey) {
        const agentClient = await this.registerRelaycastExternalAgent(
          liveAgent.name,
          `Workflow agent for step "${step.name}" (${agentDef.cli})`
        ).catch((err) => {
          console.warn(
            `[WorkflowRunner] Failed to register ${liveAgent.name} in Relaycast:`,
            err?.message ?? err
          );
          return null;
        });

        // Keep the agent online in the dashboard while it's working
        if (agentClient) {
          stopHeartbeat = this.startRelaycastHeartbeat(agentClient);
        }
      }

      // Invite the spawned agent to the workflow channel
      if (this.channel && this.relayApiKey) {
        const channelAgent = await this.ensureRelaycastRunnerAgent().catch(() => null);
        await channelAgent?.channels.invite(this.channel, agent.name).catch(() => {});
      }

      // Keep operational assignment chatter out of the agent coordination channel.
      this.log(`[${step.name}] Assigned to ${agent.name}`);

      // Register agent handle for hub-mediated nudging
      this.activeAgentHandles.set(agentName, agent);

      // Wait for agent to exit, with idle nudging if configured
      exitResult = await this.waitForExitWithIdleNudging(
        agent,
        agentDef,
        step,
        timeoutMs,
        preparedTask.promptTaskText,
        options.preserveOnIdle ?? this.shouldPreserveIdleSupervisor(agentDef, step, options.evidenceRole)
      );

      // Stop heartbeat now that agent has exited
      stopHeartbeat?.();

      if (exitResult === 'timeout') {
        // Grace-period fallback: before failing, check if the agent completed
        // its work but just failed to self-terminate. Run verification if
        // configured — a passing gate + timeout is better than a hard failure.
        let timeoutRecovered = false;
        if (step.verification) {
          const ptyOutput = (this.ptyOutputBuffers.get(agentName) ?? []).join('');
          const verificationResult = this.runVerification(
            step.verification,
            ptyOutput,
            step.name,
            preparedTask.promptTaskText,
            { allowFailure: true }
          );
          if (verificationResult.passed) {
            this.log(`[${step.name}] Agent timed out but verification passed — treating as complete`);
            this.postToChannel(
              `**[${step.name}]** Agent idle after completing work — verification passed, releasing`
            );
            await agent.release().catch(() => undefined);
            agentReleased = true;
            timeoutRecovered = true;
          }
        }
        if (!timeoutRecovered) {
          await agent.release().catch(() => undefined);
          agentReleased = true;
          throw new Error(`Step "${step.name}" timed out after ${timeoutMs ?? 'unknown'}ms`);
        }
      }

      if (exitResult === 'force-released') {
        agentReleased = true;
        throw new Error(
          `Step "${step.name}" failed — agent was force-released after exhausting idle nudges without completing`
        );
      }
      if (exitResult === 'released') {
        agentReleased = true;
      }
      completedWithoutSpawnError = true;
    } finally {
      // Snapshot PTY chunks before cleanup — we need them for output reading below
      ptyChunks = this.ptyOutputBuffers.get(agentName) ?? [];
      this.lastFailedStepOutput.set(step.name, ptyChunks.join(''));
      if (ptyChunks.length > 0 || agent?.exitCode !== undefined || agent?.exitSignal !== undefined) {
        this.captureStepTerminalEvidence(
          evidenceStepName,
          {
            stdout: ptyChunks.length > 0 ? ptyChunks.join('') : undefined,
            combined: ptyChunks.length > 0 ? ptyChunks.join('') : undefined,
          },
          {
            exitCode: agent?.exitCode,
            exitSignal: agent?.exitSignal,
          },
          {
            sender: options.logicalName ?? agentDef.name,
            actor: agent?.name ?? agentName,
            role: options.evidenceRole ?? agentDef.role ?? 'agent',
          }
        );
      }

      if (!completedWithoutSpawnError && agent && !agentReleased) {
        await agent.release().catch(() => undefined);
      }

      // Always clean up PTY resources — prevents fd leaks if spawnPty or waitForExit throws
      stopHeartbeat?.();
      this.activeAgentHandles.delete(agentName);
      this.ptyOutputBuffers.delete(agentName);
      this.ptyListeners.delete(agentName);
      const stream = this.ptyLogStreams.get(agentName);
      if (stream) {
        stream.end();
        this.ptyLogStreams.delete(agentName);
      }
      this.unregisterWorker(agentName);
      this.supervisedRuntimeAgents.delete(agentName);
      this.runtimeStepAgents.delete(agentName);
      if (preparedTask.taskTmpFile) {
        await unlink(preparedTask.taskTmpFile).catch(() => undefined);
      }
    }

    let output: string;
    if (ptyChunks.length > 0) {
      output = ptyChunks.join('');
    } else {
      // Legacy fallback: summary file
      const summaryPath = path.join(this.summaryDir, `${step.name}.md`);
      output = existsSync(summaryPath)
        ? await readFile(summaryPath, 'utf-8')
        : exitResult === 'timeout'
          ? 'Agent completed (released after idle timeout)'
          : exitResult === 'released'
            ? 'Agent completed (idle — treated as done)'
            : `Agent exited (${exitResult})`;
    }

    if (ptyChunks.length === 0) {
      this.captureStepTerminalEvidence(
        evidenceStepName,
        { stdout: output, combined: output },
        { exitCode: agent?.exitCode, exitSignal: agent?.exitSignal },
        {
          sender: options.logicalName ?? agentDef.name,
          actor: agent?.name ?? agentName,
          role: options.evidenceRole ?? agentDef.role ?? 'agent',
        }
      );
    }

    return {
      output,
      exitCode: agent?.exitCode,
      exitSignal: agent?.exitSignal,
      promptTaskText: preparedTask.promptTaskText,
    };
  }

  private resolveRelayfileRuntimeConfig(config: RelayYamlConfig | undefined): RelayfileRuntimeConfig | undefined {
    const relayfileConfig = config?.integrations?.relayfile;
    const hasExplicitWorkflowCredentials = Boolean(relayfileConfig?.workspaceId || relayfileConfig?.token);
    if (relayfileConfig?.localRoot && !hasExplicitWorkflowCredentials) return undefined;

    const workspaceId =
      relayfileConfig?.workspaceId ??
      process.env.RELAYFILE_WORKSPACE_ID ??
      process.env.RELAYFILE_WORKSPACE ??
      process.env.RELAYFILE_WORKSPACE_ID_0;
    const token = relayfileConfig?.token ?? process.env.RELAYFILE_TOKEN ?? process.env.RELAYFILE_ACL_TOKEN;

    if (!workspaceId || !token) return undefined;

    return {
      baseUrl: relayfileConfig?.baseUrl ?? process.env.RELAYFILE_BASE_URL ?? 'https://file.agentrelay.com',
      workspaceId,
      token,
      source: hasExplicitWorkflowCredentials ? 'config' : undefined,
    };
  }

  private async resolveRelayfileRuntimeConfigForUse(
    config: RelayYamlConfig | undefined,
    options: { ensureMount?: boolean } = {}
  ): Promise<RelayfileRuntimeConfig | undefined> {
    let runtime = this.relayfileRuntimeConfig ?? this.resolveRelayfileRuntimeConfig(config);
    if (!runtime) {
      runtime = await this.resolveRelayfileRuntimeConfigFromLocalCredentials(config);
    }
    if (!runtime) return undefined;
    if (this.relayfileRuntimeTokenNeedsRefresh(runtime)) {
      runtime = (await this.issueFreshRelayfileRuntimeToken(runtime).catch(() => undefined)) ?? runtime;
    }

    const changed =
      !this.relayfileRuntimeConfig ||
      this.relayfileRuntimeConfig.workspaceId !== runtime.workspaceId ||
      this.relayfileRuntimeConfig.token !== runtime.token ||
      this.relayfileRuntimeConfig.baseUrl !== runtime.baseUrl;
    this.relayfileRuntimeConfig = runtime;
    if (changed) this.relayfileClient = undefined;

    if (options.ensureMount) {
      await this.ensureRelayfileIntegrationMount(runtime, config);
    }
    return runtime;
  }

  private getRelayfileClient(): RelayFileClient {
    const runtime = this.relayfileRuntimeConfig ?? this.resolveRelayfileRuntimeConfig(this.currentConfig);
    if (!runtime) {
      throw new Error(
        'Relayfile integration is not ready. Declare integrations.relayfile or connect Relayfile/Pear locally, ' +
          'or set RELAYFILE_TOKEN and RELAYFILE_WORKSPACE_ID.'
      );
    }
    if (!this.relayfileClient) {
      this.relayfileRuntimeConfig = runtime;
      this.relayfileClient = new RelayFileClient({
        baseUrl: runtime.baseUrl,
        token: runtime.token,
      });
    }
    return this.relayfileClient;
  }

  private collectRelayfileSubscriptions(config: RelayYamlConfig): ResolvedRelayfileSubscription[] {
    const subscriptions: ResolvedRelayfileSubscription[] = [];
    for (const sub of config.integrations?.subscriptions ?? []) {
      const paths = this.resolveSubscriptionPaths(sub);
      if (paths.length === 0) continue;
      subscriptions.push({
        name: sub.name,
        paths,
        events: this.normalizeRelayfileEventFilters(sub.events ?? (sub.event ? [sub.event] : undefined)),
        provider: sub.provider,
        targetAgents: sub.agents ?? (sub.agent ? [sub.agent] : undefined),
        source: 'workflow',
      });
    }

    for (const agent of config.agents) {
      for (const [idx, watch] of (agent.watch ?? []).entries()) {
        if (!watch.paths?.length) continue;
        subscriptions.push({
          name: `${agent.name}.watch.${idx + 1}`,
          paths: watch.paths,
          events: this.normalizeRelayfileEventFilters(watch.events),
          targetAgents: [agent.name],
          source: 'agent',
          ownerAgent: agent.name,
        });
      }
      for (const sub of agent.subscriptions ?? []) {
        const paths = this.resolveSubscriptionPaths(sub);
        if (paths.length === 0) continue;
        subscriptions.push({
          name: sub.name,
          paths,
          events: this.normalizeRelayfileEventFilters(sub.events ?? (sub.event ? [sub.event] : undefined)),
          provider: sub.provider,
          targetAgents: [agent.name],
          source: 'agent',
          ownerAgent: agent.name,
        });
      }
    }

    return subscriptions;
  }

  private resolveSubscriptionPaths(sub: { path?: string; paths?: string[] }): string[] {
    const paths = [...(sub.paths ?? []), ...(sub.path ? [sub.path] : [])]
      .map((p) => p.trim())
      .filter(Boolean);
    return [...new Set(paths)];
  }

  private normalizeRelayfileEventFilters(events: readonly string[] | undefined): string[] | undefined {
    if (!events || events.length === 0) return undefined;
    const normalized = events.map((event) => this.normalizeRelayfileEventName(event));
    return [...new Set(normalized)];
  }

  private normalizeRelayfileEventName(event: string): string {
    const trimmed = event.trim();
    if (trimmed === 'created') return 'file.created';
    if (trimmed === 'updated') return 'file.updated';
    if (trimmed === 'deleted') return 'file.deleted';
    return trimmed;
  }

  private async startRelayfileEventSubscriptions(config: RelayYamlConfig): Promise<void> {
    const subscriptions = this.collectRelayfileSubscriptions(config);
    this.relayfileEventSubscriptions.length = 0;
    this.relayfileEventSubscriptions.push(...subscriptions);
    if (subscriptions.length === 0) return;

    const runtime = await this.resolveRelayfileRuntimeConfigForUse(config, { ensureMount: true });
    if (!runtime) {
      throw new Error(
        'Relayfile subscriptions are configured, but no Relayfile credentials are available. ' +
          'Connect Relayfile/Pear locally, or set RELAYFILE_TOKEN and RELAYFILE_WORKSPACE_ID.'
      );
    }
    const client = this.getRelayfileClient();

    this.seenRelayfileEventIds.clear();
    await this.ensureRelayfileEventStream(client, runtime);
    for (const subscription of subscriptions) {
      this.relayfileEventSubscriptionHandles.push(
        client.subscribe(
          subscription.paths,
          (event) => {
            void this.handleRelayfileEvent(event).catch((err) => {
              this.log(`Relayfile subscription handler failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          },
          {
            coalesce: 'none',
            aclToken: runtime.token,
          }
        )
      );
    }
    this.log(`Relayfile subscriptions active (${subscriptions.length})`);
  }

  private async stopRelayfileEventSubscriptions(): Promise<void> {
    const handles = this.relayfileEventSubscriptionHandles.splice(0);
    await Promise.allSettled(handles.map((handle) => handle.unsubscribe()));
    await this.relayfileEventStream?.unsubscribe().catch(() => undefined);
    this.relayfileEventStream = undefined;
  }

  private async ensureRelayfileEventStream(client: RelayFileClient, runtime: RelayfileRuntimeConfig): Promise<void> {
    if (!this.relayfileEventStream) {
      this.relayfileEventStream = client.open({
        workspaceId: runtime.workspaceId,
        aclToken: runtime.token,
        replayOnStart: 'none',
      });
    }
    await this.relayfileEventStream.ready;
  }

  private async waitForRelayfileEvent(
    subscription: ResolvedRelayfileSubscription,
    timeoutMs = 10 * 60_000,
    predicate?: (event: NormalizedRelayfileEvent) => Promise<boolean> | boolean
  ): Promise<NormalizedRelayfileEvent> {
    const runtime = await this.resolveRelayfileRuntimeConfigForUse(this.currentConfig, { ensureMount: true });
    if (!runtime) {
      throw new Error('waitFor event gates require Relayfile credentials');
    }
    const client = this.getRelayfileClient();
    await this.ensureRelayfileEventStream(client, runtime);

    let handle: Subscription | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return await new Promise<NormalizedRelayfileEvent>((resolve, reject) => {
      let settled = false;
      const waiter: RelayfileEventWaiter = {
        name: subscription.name,
        subscription,
        resolve: (event) => {
          void Promise.resolve(predicate ? predicate(event) : true)
            .then((accepted) => {
              if (!accepted) return;
              settled = true;
              cleanup();
              resolve(event);
            })
            .catch((err) => {
              settled = true;
              cleanup();
              reject(err);
            });
        },
      };
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        const idx = this.relayfileEventWaiters.indexOf(waiter);
        if (idx !== -1) this.relayfileEventWaiters.splice(idx, 1);
        void handle?.unsubscribe().catch(() => undefined);
      };

      try {
        handle = client.subscribe(
          subscription.paths,
          (event) => {
            void this.handleRelayfileEvent(event).catch((err) => {
              settled = true;
              cleanup();
              reject(err);
            });
          },
          {
            coalesce: 'none',
            aclToken: runtime.token,
          }
        );
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      if (settled) return;
      this.relayfileEventWaiters.push(waiter);

      timeout = setTimeout(() => {
        settled = true;
        cleanup();
        reject(new Error(`Timed out waiting ${timeoutMs}ms for Relayfile event "${subscription.name}"`));
      }, timeoutMs);
    });
  }

  private resolveRelayfileEventWaiters(event: NormalizedRelayfileEvent): void {
    for (const waiter of [...this.relayfileEventWaiters]) {
      if (this.relayfileEventMatchesSubscription(event, waiter.subscription)) {
        waiter.resolve(event);
      }
    }
  }

  private normalizeRelayfileEvent(event: FilesystemEvent | ChangeEvent): NormalizedRelayfileEvent {
    if ('resource' in event) {
      return {
        eventId: event.id,
        type: event.type,
        path: event.resource.path,
        provider: event.resource.provider,
        timestamp: event.occurredAt,
        resourceKind: event.resource.kind,
        summary: event.summary as unknown as Record<string, unknown>,
        raw: event,
      };
    }
    return {
      eventId: event.eventId,
      type: event.type,
      path: event.path,
      revision: event.revision,
      provider: event.provider,
      timestamp: event.timestamp,
      raw: event,
    };
  }

  private relayfileEventTypeMatches(event: NormalizedRelayfileEvent, filters: string[]): boolean {
    if (filters.includes(event.type)) return true;
    if (event.type === 'relayfile.changed') {
      return filters.some((filter) => filter === 'file.created' || filter === 'file.updated' || filter === 'file.deleted');
    }
    return false;
  }

  private serializeRelayfileEvent(event: NormalizedRelayfileEvent): Record<string, unknown> {
    return {
      eventId: event.eventId,
      type: event.type,
      path: event.path,
      revision: event.revision,
      provider: event.provider,
      timestamp: event.timestamp,
      resourceKind: event.resourceKind,
      summary: event.summary,
    };
  }

  private async ensureRelayfileIntegrationMount(
    runtime: RelayfileRuntimeConfig,
    config: RelayYamlConfig | undefined
  ): Promise<void> {
    const relayfileConfig = config?.integrations?.relayfile;
    if (!relayfileConfig) return;
    if (relayfileConfig.mount === false) return;
    if (this.relayfileIntegrationMount) return;

    const configuredLocalRoot =
      relayfileConfig.localRoot ??
      process.env.RELAYFILE_LOCAL_ROOT ??
      process.env.RELAYFILE_MOUNT_ROOT;
    const mountPoint = configuredLocalRoot ? WorkflowRunner.resolveEnvVars(configuredLocalRoot) : undefined;

    try {
      const handle = await ensureRelayfileMount({
        relayfileUrl: runtime.baseUrl,
        workspace: runtime.workspaceId,
        token: runtime.token,
        mountPoint,
      });
      this.relayfileIntegrationMount = handle;
      this.log(
        `Relayfile integration mount ready at ${handle.mountPoint}${typeof handle.pid === 'number' ? ` (pid ${handle.pid})` : ''}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Relayfile integration mount could not be started automatically: ${message}`);
      this.postToChannel(`Relayfile integration mount could not be started automatically: ${message}`);
    }
  }

  private async stopRelayfileIntegrationMount(): Promise<void> {
    const mount = this.relayfileIntegrationMount;
    this.relayfileIntegrationMount = undefined;
    if (!mount) return;
    await mount.stop().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Relayfile integration mount shutdown failed: ${message}`);
    });
  }

  private async handleRelayfileEvent(rawEvent: FilesystemEvent | ChangeEvent): Promise<void> {
    const event = this.normalizeRelayfileEvent(rawEvent);
    if (!event.eventId || this.seenRelayfileEventIds.has(event.eventId)) return;
    this.seenRelayfileEventIds.add(event.eventId);

    this.resolveRelayfileEventWaiters(event);

    for (const subscription of this.relayfileEventSubscriptions) {
      if (!this.relayfileEventMatchesSubscription(event, subscription)) continue;
      await this.injectRelayfileEventToSubscribedAgents(subscription, event).catch((err) => {
        this.log(
          `Failed to inject Relayfile event ${event.eventId} for "${subscription.name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }
  }

  private relayfileEventMatchesSubscription(
    event: NormalizedRelayfileEvent,
    subscription: ResolvedRelayfileSubscription
  ): boolean {
    if (subscription.provider && event.provider && subscription.provider !== event.provider) return false;
    if (subscription.events && !this.relayfileEventTypeMatches(event, subscription.events)) return false;
    return subscription.paths.some((glob) => WorkflowRunner.pathGlobMatches(glob, event.path));
  }

  private async injectRelayfileEventToSubscribedAgents(
    subscription: ResolvedRelayfileSubscription,
    event: NormalizedRelayfileEvent
  ): Promise<void> {
    const targets = this.resolveActiveSubscriptionTargets(subscription);
    if (targets.length === 0) return;

    const text = [
      `INTEGRATION_EVENT: ${subscription.name}`,
      `source: relayfile`,
      `provider: ${event.provider ?? subscription.provider ?? 'unknown'}`,
      `type: ${event.type}`,
      `path: ${event.path}`,
      `revision: ${event.revision}`,
      `eventId: ${event.eventId}`,
      event.timestamp ? `timestamp: ${event.timestamp}` : undefined,
      '',
      'Read the Relayfile path if you need the full payload, then continue the workflow.',
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    for (const agentName of targets) {
      await this.withBrokerRecovery(`injecting Relayfile event into "${agentName}"`, (relay) =>
        relay.sendMessage({
          from: 'workflow-runner',
          to: agentName,
          text,
        })
      );
    }
  }

  private resolveActiveSubscriptionTargets(subscription: ResolvedRelayfileSubscription): string[] {
    const targets: string[] = [];
    const configuredTargets = subscription.targetAgents;
    for (const [runtimeName] of this.activeAgentHandles) {
      const meta = this.runtimeStepAgents.get(runtimeName);
      if (
        !configuredTargets ||
        configuredTargets.includes(runtimeName) ||
        (meta?.logicalName && configuredTargets.includes(meta.logicalName))
      ) {
        targets.push(runtimeName);
      }
    }
    return targets;
  }

  private buildIntegrationSubscriptionGuidance(agentDef: AgentDefinition): string {
    const config = this.currentConfig;
    if (!config) return '';
    const subscriptions = this.collectRelayfileSubscriptions(config).filter((subscription) => {
      if (!subscription.targetAgents) return true;
      return subscription.targetAgents.includes(agentDef.name);
    });
    if (subscriptions.length === 0) return '';

    const lines = subscriptions.map((subscription) => {
      const events = subscription.events?.join(', ') ?? 'all file events';
      return `- ${subscription.name}: ${subscription.paths.join(', ')} (${events})`;
    });
    return [
      '---',
      'RELAYFILE INTEGRATION EVENTS:',
      'This agent is subscribed to Relayfile events. While you are running, the workflow runner may inject an INTEGRATION_EVENT message with provider, type, path, revision, and eventId.',
      'When one arrives, read the Relayfile path if needed and continue the task using that event.',
      ...lines,
    ].join('\n');
  }

  private static pathGlobMatches(glob: string, candidate: string): boolean {
    const normalizedGlob = glob.startsWith('/') ? glob : `/${glob}`;
    const normalizedCandidate = candidate.startsWith('/') ? candidate : `/${candidate}`;
    const pattern = normalizedGlob
      .split(/(\*\*)/)
      .map((part) => {
        if (part === '**') return '.*';
        return part
          .split(/(\*)/)
          .map((inner) => (inner === '*' ? '[^/]*' : WorkflowRunner.escapeRegExp(inner)))
          .join('');
      })
      .join('');
    return new RegExp(`^${pattern}$`).test(normalizedCandidate);
  }

  private static escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private resolveHumanAssistanceConfig(step: WorkflowStep): HumanAssistanceConfig | undefined {
    if (step.humanAssistance === false) return undefined;
    return step.humanAssistance ?? this.currentConfig?.swarm.humanAssistance;
  }

  private isSlackHumanAssistanceEnabled(config: HumanAssistanceConfig | undefined): boolean {
    return Boolean(config?.slack);
  }

  private buildHumanAssistanceGuidance(config: HumanAssistanceConfig | undefined): string {
    if (!this.isSlackHumanAssistanceEnabled(config)) return '';

    return (
      '---\n' +
      'HUMAN ASSISTANCE — Slack question bridge:\n' +
      'If you are blocked by a missing decision or clarification, print one line beginning with ' +
      'HUMAN_QUESTION followed by a colon and your concise question. Then stop and wait.\n' +
      'The workflow runner will post the question to Slack, wait for a human reply, and inject ' +
      'a HUMAN_ANSWER line back into your session. Do not repeat the question while waiting.'
    );
  }

  private observeHumanAssistanceOutput(input: {
    agentName: string;
    step: WorkflowStep;
    config: HumanAssistanceConfig | undefined;
    output: string;
  }): void {
    if (!this.isSlackHumanAssistanceEnabled(input.config)) return;

    const renderedQuestion = this.selectBestHumanQuestion(this.extractHumanQuestionCandidates(input.output));
    const declaredQuestion = this.extractDeclaredHumanQuestionFromTask(input.step.task);
    const question =
      declaredQuestion && this.shouldPreferDeclaredHumanQuestion(declaredQuestion, renderedQuestion)
        ? declaredQuestion
        : renderedQuestion;
    if (!question) return;
    const key = `${input.step.name}:${input.agentName}`;
    if (this.hasAnsweredSimilarHumanQuestion(key, question)) return;
    this.scheduleSlackHumanQuestion(input.agentName, input.step, input.config!, question);
  }

  private extractDeclaredHumanQuestionFromTask(task: string | undefined): string | undefined {
    if (!task) return undefined;
    const marker = /(?:followed by|with)\s+this\s+exact\s+question\s*:/i.exec(task);
    if (!marker) return undefined;
    const afterMarker = task.slice(marker.index + marker[0].length);
    const lines = afterMarker.split(/\r?\n/).map((line) => line.trim());
    const questionLines: string[] = [];
    for (const line of lines) {
      if (!line) {
        if (questionLines.length > 0) break;
        continue;
      }
      if (/^(after|then|when|finally)\b/i.test(line) && questionLines.length > 0) break;
      questionLines.push(line.replace(/^`|`$/g, ''));
      if (/[?!.]$/.test(line)) break;
    }
    const question = questionLines.join(' ').replace(/\s+/g, ' ').trim();
    return question || undefined;
  }

  private shouldPreferDeclaredHumanQuestion(declaredQuestion: string, renderedQuestion: string | undefined): boolean {
    if (!renderedQuestion) return true;
    if (this.humanQuestionLooksCompacted(renderedQuestion)) return true;
    const declaredFingerprint = this.humanQuestionFingerprint(declaredQuestion);
    const renderedFingerprint = this.humanQuestionFingerprint(renderedQuestion);
    return Boolean(
      declaredFingerprint &&
        renderedFingerprint &&
        (declaredFingerprint.includes(renderedFingerprint) ||
          renderedFingerprint.includes(declaredFingerprint) ||
          this.areHumanQuestionFingerprintsSimilar(declaredFingerprint, renderedFingerprint))
    );
  }

  private humanQuestionLooksCompacted(question: string): boolean {
    const words = question.trim().split(/\s+/).filter(Boolean);
    const longestWord = words.reduce((max, word) => Math.max(max, word.length), 0);
    return words.length <= 4 || longestWord >= 28;
  }

  private extractHumanQuestionCandidates(output: string): string[] {
    const pattern = /^[^\r\nA-Za-z0-9_]*HUMAN_QUESTION:\s*(.+)$/gim;
    const candidates: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      const question = match[1]?.trim().replace(/\s+/g, ' ');
      if (question) candidates.push(question);
    }
    return candidates;
  }

  private selectBestHumanQuestion(candidates: string[]): string | undefined {
    let best: { question: string; score: number } | undefined;
    for (const question of candidates) {
      const score = this.humanQuestionReadabilityScore(question);
      if (!best || score > best.score || (score === best.score && question.length > best.question.length)) {
        best = { question, score };
      }
    }
    return best?.question;
  }

  private humanQuestionReadabilityScore(question: string): number {
    const words = question.trim().split(/\s+/).filter(Boolean);
    const spaces = (question.match(/\s/g) ?? []).length;
    const longestWord = words.reduce((max, word) => Math.max(max, word.length), 0);
    const punctuation = (question.match(/[?.,:;]/g) ?? []).length;
    return question.length + spaces * 12 + words.length * 3 + punctuation * 2 - Math.max(0, longestWord - 24) * 8;
  }

  private scheduleSlackHumanQuestion(
    agentName: string,
    step: WorkflowStep,
    config: HumanAssistanceConfig,
    question: string
  ): void {
    if (this.pendingHumanQuestions.has(agentName)) return;
    const key = `${step.name}:${agentName}`;
    if (this.hasAnsweredSimilarHumanQuestion(key, question)) return;

    const existing = this.pendingHumanQuestionDrafts.get(agentName);
    if (existing) {
      existing.question = this.selectBestHumanQuestion([existing.question, question]) ?? question;
      existing.step = step;
      existing.config = config;
      return;
    }

    const draft = {
      agentName,
      step,
      config,
      question,
      timer: setTimeout(() => {
        this.pendingHumanQuestionDrafts.delete(agentName);
        const key = `${draft.step.name}:${draft.agentName}`;
        const selected = this.selectBestHumanQuestion([draft.question]);
        if (
          !selected ||
          this.hasSeenSimilarHumanQuestion(key, selected) ||
          this.hasAnsweredSimilarHumanQuestion(key, selected)
        ) {
          return;
        }
        this.rememberHumanQuestion(key, selected);
        this.startSlackHumanQuestion(draft.agentName, draft.step, draft.config, selected);
      }, 1200),
    };
    this.pendingHumanQuestionDrafts.set(agentName, draft);
  }

  private clearPendingHumanQuestionDrafts(): void {
    for (const draft of this.pendingHumanQuestionDrafts.values()) {
      clearTimeout(draft.timer);
    }
    this.pendingHumanQuestionDrafts.clear();
  }

  private rememberHumanQuestion(scope: string, question: string): void {
    this.rememberHumanQuestionInMap(this.seenHumanQuestionKeys, scope, question);
  }

  private rememberAnsweredHumanQuestion(scope: string, question: string): void {
    this.rememberHumanQuestionInMap(this.answeredHumanQuestionKeys, scope, question);
  }

  private rememberHumanQuestionInMap(
    map: Map<string, Array<{ fingerprint: string; at: number }>>,
    scope: string,
    question: string
  ): void {
    const now = Date.now();
    const fingerprint = this.humanQuestionFingerprint(question);
    const existing = map.get(scope) ?? [];
    const fresh = existing.filter((entry) => now - entry.at < 10 * 60_000);
    fresh.push({ fingerprint, at: now });
    map.set(scope, fresh);
  }

  private hasSeenSimilarHumanQuestion(scope: string, question: string): boolean {
    return this.hasSimilarHumanQuestionInMap(this.seenHumanQuestionKeys, scope, question);
  }

  private hasAnsweredSimilarHumanQuestion(scope: string, question: string): boolean {
    return this.hasSimilarHumanQuestionInMap(this.answeredHumanQuestionKeys, scope, question);
  }

  private hasSimilarHumanQuestionInMap(
    map: Map<string, Array<{ fingerprint: string; at: number }>>,
    scope: string,
    question: string
  ): boolean {
    const fingerprint = this.humanQuestionFingerprint(question);
    if (!fingerprint) return false;
    const now = Date.now();
    const existing = map.get(scope) ?? [];
    return existing.some((entry) => {
      if (now - entry.at > 10 * 60_000) return false;
      return this.areHumanQuestionFingerprintsSimilar(entry.fingerprint, fingerprint);
    });
  }

  private humanQuestionFingerprint(question: string): string {
    return question.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  private areHumanQuestionFingerprintsSimilar(left: string, right: string): boolean {
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.includes(right) || right.includes(left)) return true;
    const distance = this.boundedEditDistance(left, right, Math.max(3, Math.floor(Math.max(left.length, right.length) * 0.12)));
    return distance !== undefined;
  }

  private boundedEditDistance(left: string, right: string, maxDistance: number): number | undefined {
    if (Math.abs(left.length - right.length) > maxDistance) return undefined;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
      const current = [i];
      let rowMin = current[0]!;
      for (let j = 1; j <= right.length; j++) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        const value = Math.min(
          previous[j]! + 1,
          current[j - 1]! + 1,
          previous[j - 1]! + cost
        );
        current[j] = value;
        rowMin = Math.min(rowMin, value);
      }
      if (rowMin > maxDistance) return undefined;
      previous = current;
    }

    const distance = previous[right.length]!;
    return distance <= maxDistance ? distance : undefined;
  }

  private startSlackHumanQuestion(
    agentName: string,
    step: WorkflowStep,
    config: HumanAssistanceConfig,
    question: string
  ): void {
    if (this.pendingHumanQuestions.has(agentName)) return;

    const task = this.askSlackAndInjectAnswer(agentName, step, config, question).finally(() => {
      this.pendingHumanQuestions.delete(agentName);
    });
    this.pendingHumanQuestions.set(agentName, task);
    task.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[${step.name}] Slack human question failed: ${message}`);
      this.postToChannel(`**[${step.name}]** Slack human question failed: ${message}`);
    });
  }

  private async waitForPendingHumanQuestion(agentName: string): Promise<boolean> {
    const pendingQuestion = this.pendingHumanQuestions.get(agentName);
    if (pendingQuestion) {
      await pendingQuestion;
      return true;
    }

    const draft = this.pendingHumanQuestionDrafts.get(agentName);
    if (!draft) return false;

    await this.delay(1500);
    const started = this.pendingHumanQuestions.get(agentName);
    if (started) await started;
    return true;
  }

  private async askSlackAndInjectAnswer(
    agentName: string,
    step: WorkflowStep,
    config: HumanAssistanceConfig,
    question: string
  ): Promise<void> {
    const slackConfig = typeof config.slack === 'object' && config.slack !== null ? config.slack : {};
    this.log(`[${step.name}] ${agentName} requested human input via Slack`);
    this.postToChannel(`**[${step.name}]** \`${agentName}\` asked a human question via Slack`);

    const text = `Workflow step "${step.name}" agent "${agentName}" asks:\n\n${question}`;
    const preferRelayfile =
      Boolean(this.currentConfig?.integrations?.relayfile) ||
      (!process.env.SLACK_BOT_TOKEN && !process.env.SLACK_CLOUD_API_TOKEN);

    let result: { answer: { text: string; path?: string; eventId?: string } };
    if (preferRelayfile) {
      try {
        result = await this.askSlackViaRelayfile({
          channel: slackConfig.channel,
          text,
          mentions: slackConfig.mentions,
          timeoutMs: slackConfig.timeoutMs,
        });
      } catch (err) {
        if (this.currentConfig?.integrations?.relayfile) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.log(`[${step.name}] Relayfile Slack bridge unavailable, falling back to Slack API: ${message}`);
        result = await new SlackClient().askQuestion({
          channel: slackConfig.channel,
          text,
          mentions: slackConfig.mentions,
          timeoutMs: slackConfig.timeoutMs,
          ignoreUserIds: slackConfig.ignoreUserIds,
        });
      }
    } else {
      result = await new SlackClient().askQuestion({
        channel: slackConfig.channel,
        text,
        mentions: slackConfig.mentions,
        timeoutMs: slackConfig.timeoutMs,
        ignoreUserIds: slackConfig.ignoreUserIds,
      });
    }

    this.log(`[${step.name}] Received Slack human answer; injecting into ${agentName}`);
    this.rememberAnsweredHumanQuestion(`${step.name}:${agentName}`, question);
    await this.injectAnswerToAgent({
      agentName,
      stepName: step.name,
      source: 'slack',
      text: `HUMAN_ANSWER: ${result.answer.text}`,
    });
  }

  private async askSlackViaRelayfile(input: {
    channel?: string;
    text: string;
    mentions?: string[];
    timeoutMs?: number;
  }): Promise<{ answer: { text: string; path?: string; eventId?: string } }> {
    const channel = input.channel ?? process.env.SLACK_DEFAULT_CHANNEL;
    if (!channel) {
      throw new Error('Relayfile Slack human assistance requires a channel or SLACK_DEFAULT_CHANNEL');
    }

    const runtimeConfig = await this.resolveRelayfileRuntimeConfigForUse(this.currentConfig, {
      ensureMount: Boolean(this.currentConfig?.integrations?.relayfile),
    });
    if (!runtimeConfig) {
      const localRoot = await this.resolveRelayfileLocalRoot();
      if (localRoot) {
        return this.askSlackViaLocalRelayfile({ ...input, channel, localRoot });
      }
    }

    if (!this.relayfileRuntimeConfig) {
      throw new Error('Relayfile Slack human assistance requires Relayfile runtime configuration');
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime: RelayfileRuntimeConfig | undefined = this.relayfileRuntimeConfig;
      if (!runtime) break;
      try {
        return await this.askSlackViaRelayfileRuntime({
          ...input,
          channel,
          runtime,
        });
      } catch (err) {
        if (attempt > 0 || !this.isRelayfileAuthExpiredError(err)) throw err;
        const refreshed: RelayfileRuntimeConfig | undefined =
          (await this.issueFreshRelayfileRuntimeToken(runtime).catch(() => undefined)) ??
          (await this.resolveRelayfileRuntimeConfigFromLocalCredentials(this.currentConfig));
        if (!refreshed || refreshed.token === runtime.token) throw err;
        this.log('Relayfile credentials expired; refreshed Relayfile workspace token and retrying Slack question');
        this.relayfileRuntimeConfig = refreshed;
        this.relayfileClient = undefined;
      }
    }

    throw new Error('Relayfile Slack human assistance requires Relayfile runtime configuration');
  }

  private async askSlackViaRelayfileRuntime(input: {
    channel: string;
    text: string;
    mentions?: string[];
    timeoutMs?: number;
    runtime: RelayfileRuntimeConfig;
  }): Promise<{ answer: { text: string; path?: string; eventId?: string } }> {
    const client = this.getRelayfileClient();
    const runtime = input.runtime;
    const channel = await this.resolveRelayfileSlackChannelId({
      channel: input.channel,
      client,
      runtime,
    });

    const startedAt = Date.now();
    const messagePath = `/slack/channels/${this.sanitizeRelayfilePathSegment(channel)}/messages/wb-relayflows-human-question-${Date.now()}-${this.generateShortId()}.json`;
    const messageText = `${(input.mentions ?? []).join(' ')}${input.mentions?.length ? ' ' : ''}${input.text}`;

    await client.writeFile({
      workspaceId: runtime.workspaceId,
      path: messagePath,
      baseRevision: '0',
      contentType: 'application/json',
      content: JSON.stringify(
        {
          text: messageText,
          idempotencyKey: path.basename(messagePath, '.json'),
        },
        null,
        2
      ),
    });

    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    let questionThreadTs: string | undefined;
    const channelPrefix = `/slack/channels/${this.sanitizeRelayfilePathSegment(channel)}`;
    let answerText: string | undefined;
    const event = await this.waitForRelayfileEvent(
      {
        name: 'slack-human-answer',
        paths: this.slackHumanAnswerSubscriptionPaths(channelPrefix, input.channel),
        provider: 'slack',
        source: 'workflow',
      },
      timeoutMs,
      async (event) => {
        if (event.path === messagePath) return false;
        if (event.timestamp && Date.parse(event.timestamp) < startedAt) return false;
        questionThreadTs ??= await this.readRelayfileSlackMessageThreadTs(messagePath);
        if (!questionThreadTs) return false;
        const answer = await this.readRelayfileSlackAnswer(event.path, messageText);
        if (!answer) return false;
        if (!this.slackAnswerMatchesQuestionThread(answer.payload, event.path, questionThreadTs)) {
          return false;
        }
        answerText = answer.text;
        return true;
      }
    );

    return { answer: { text: answerText ?? '', path: event.path, eventId: event.eventId } };
  }

  private slackHumanAnswerSubscriptionPaths(channelPrefix: string, requestedChannel: string): string[] {
    const paths = new Set<string>([`${channelPrefix}/**`]);
    const slug = this.slackChannelAliasSlug(requestedChannel);
    if (slug) paths.add(`${channelPrefix}__${slug}/**`);
    return [...paths];
  }

  private isRelayfileAuthExpiredError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /token has expired|jwt expired|unauthorized|401/i.test(message);
  }

  private async askSlackViaLocalRelayfile(input: {
    channel: string;
    text: string;
    mentions?: string[];
    timeoutMs?: number;
    localRoot: string;
  }): Promise<{ answer: { text: string; path?: string } }> {
    const startedAt = Date.now();
    const channel = await this.resolveLocalSlackChannelId(input.localRoot, input.channel);
    const messageDir = await this.resolveLocalSlackMessageDir(input.localRoot, channel);
    await mkdir(messageDir, { recursive: true });

    const messageText = `${(input.mentions ?? []).join(' ')}${input.mentions?.length ? ' ' : ''}${input.text}`;
    const messagePath = path.join(
      messageDir,
      `wb-relayflows-human-question-${Date.now()}-${this.generateShortId()}.json`
    );
    await writeFile(
      messagePath,
      JSON.stringify(
        {
          text: messageText,
          idempotencyKey: path.basename(messagePath, '.json'),
        },
        null,
        2
      ),
      'utf8'
    );

    const timeoutMs = input.timeoutMs ?? 10 * 60_000;
    this.log(`Wrote Slack question through local Relayfile mount: ${messagePath}`);

    return await this.waitForLocalSlackAnswer({
      localRoot: input.localRoot,
      channel,
      questionPath: messagePath,
      questionText: messageText,
      startedAt,
      timeoutMs,
    });
  }

  private async waitForLocalSlackAnswer(input: {
    localRoot: string;
    channel: string;
    questionPath: string;
    questionText: string;
    startedAt: number;
    timeoutMs: number;
  }): Promise<{ answer: { text: string; path?: string } }> {
    const check = async (): Promise<{ answer: { text: string; path?: string } } | undefined> => {
      for (const candidate of await this.listLocalSlackAnswerFiles(input.localRoot, input.channel)) {
        if (candidate === input.questionPath) continue;
        const info = await stat(candidate).catch(() => undefined);
        if (!info || info.mtimeMs < input.startedAt) continue;
        const content = await readFile(candidate, 'utf8').catch(() => '');
        const parsed = this.tryParseJson(content);
        const answerText = this.extractTextFromSlackRelayfilePayload(parsed ?? content);
        if (!answerText) continue;
        if (answerText.trim() === input.questionText.trim()) continue;
        if (answerText.includes('Workflow step "') && answerText.includes(' asks:')) continue;
        return { answer: { text: answerText.trim(), path: candidate } };
      }
      return undefined;
    };

    const existing = await check();
    if (existing) return existing;

    const watchDirs = await this.resolveLocalSlackWatchDirs(input.localRoot, input.channel);
    return await new Promise((resolve, reject) => {
      const watchers: Array<ReturnType<typeof watch>> = [];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        for (const watcher of watchers) watcher.close();
      };
      try {
        for (const dir of watchDirs) {
          watchers.push(watch(dir, { persistent: false }, () => {
            void check().then((answer) => {
              if (!answer) return;
              cleanup();
              resolve(answer);
            }).catch((err) => {
              cleanup();
              reject(err);
            });
          }));
        }
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting ${input.timeoutMs}ms for a Slack answer via local Relayfile mount`));
      }, input.timeoutMs);
    });
  }

  private async resolveRelayfileLocalRoot(config?: RelayYamlConfig): Promise<string | undefined> {
    const configured =
      config?.integrations?.relayfile?.localRoot ??
      this.currentConfig?.integrations?.relayfile?.localRoot ??
      process.env.RELAYFILE_LOCAL_ROOT ??
      process.env.RELAYFILE_MOUNT_ROOT;
    if (configured) return WorkflowRunner.resolveEnvVars(configured);

    const workspaceId =
      config?.integrations?.relayfile?.workspaceId ??
      this.currentConfig?.integrations?.relayfile?.workspaceId ??
      process.env.RELAYFILE_WORKSPACE_ID ??
      process.env.RELAYFILE_WORKSPACE;
    const pearRoot = path.join(
      homedir(),
      '.agentworkforce',
      'pear',
      'relayfile',
      'workspaces'
    );
    if (!pearRoot.trim()) return undefined;

    if (workspaceId) {
      const candidate = path.join(pearRoot, workspaceId);
      if (await this.pathExists(candidate)) return candidate;
    }

    const entries = await readdir(pearRoot, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(pearRoot, entry.name);
      if (
        !(await this.pathExists(path.join(candidate, 'slack'))) &&
        !(await this.pathExists(path.join(candidate, 'discovery', 'slack')))
      ) {
        continue;
      }
      const info = await stat(candidate).catch(() => undefined);
      candidates.push({ path: candidate, mtimeMs: info?.mtimeMs ?? 0 });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.path;
  }

  private async resolveRelayfileSlackChannelId(input: {
    channel: string;
    client: RelayFileClient;
    runtime: RelayfileRuntimeConfig;
  }): Promise<string> {
    const normalized = this.normalizeSlackChannelIdentifier(input.channel);
    if (this.looksLikeSlackChannelId(normalized)) return normalized;

    for (const indexPath of ['/slack/channels/_index.json', '/discovery/slack/channels/_index.json']) {
      const content = await this.readRelayfileSlackLookupFile(input.client, input.runtime.workspaceId, indexPath);
      const match = this.findSlackChannelIndexMatch(this.parseSlackChannelIndex(content ?? ''), normalized);
      if (match) return match.id;
    }

    for (const aliasPath of this.slackChannelByNameAliasPaths(normalized)) {
      const content = await this.readRelayfileSlackLookupFile(input.client, input.runtime.workspaceId, aliasPath);
      const alias = this.parseSlackChannelAlias(content ?? '');
      if (alias?.id) return alias.id;
    }

    const localRoot = await this.resolveRelayfileLocalRoot(this.currentConfig);
    if (localRoot) {
      let localMatch: string | undefined;
      try {
        localMatch = await this.resolveLocalSlackChannelId(localRoot, normalized);
      } catch (err) {
        if (!this.isSlackChannelNotFoundError(err)) throw err;
      }
      if (localMatch) return localMatch;
    }

    const cloudMatch = await this.resolveSlackChannelIdFromCloudOptions(normalized);
    if (cloudMatch) return cloudMatch;

    throw new Error(
      `Slack channel "${input.channel}" was not found in Relayfile's synced Slack metadata or Slack integration options. ` +
        'Use a Slack channel name that the connected Slack integration can see, or pass a Slack channel id.'
    );
  }

  private async readRelayfileSlackLookupFile(
    client: RelayFileClient,
    workspaceId: string,
    path: string
  ): Promise<string | undefined> {
    try {
      const file = await client.readFile(workspaceId, path);
      return typeof file?.content === 'string' ? file.content : undefined;
    } catch (err) {
      if (this.isRelayfileAuthExpiredError(err)) throw err;
      return undefined;
    }
  }

  private async resolveLocalSlackChannelId(localRoot: string, channel: string): Promise<string> {
    const normalized = this.normalizeSlackChannelIdentifier(channel);
    if (this.looksLikeSlackChannelId(normalized)) return normalized;

    for (const indexPath of [
      path.join(localRoot, 'slack', 'channels', '_index.json'),
      path.join(localRoot, 'discovery', 'slack', 'channels', '_index.json'),
    ]) {
      const raw = await readFile(indexPath, 'utf8').catch(() => undefined);
      if (!raw) continue;
      const match = this.findSlackChannelIndexMatch(this.parseSlackChannelIndex(raw), normalized);
      if (match) return match.id;
    }

    for (const byNameDir of [
      path.join(localRoot, 'slack', 'channels', 'by-name'),
      path.join(localRoot, 'discovery', 'slack', 'channels', 'by-name'),
    ]) {
      const match = await this.resolveLocalSlackByNameAlias(byNameDir, normalized);
      if (match) return match;
    }

    const directEntries = await readdir(path.join(localRoot, 'slack', 'channels'), { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of directEntries) {
      if (!entry.isDirectory()) continue;
      const [id, ...nameParts] = entry.name.split('__');
      const name = nameParts.join('__');
      if (!id || !this.looksLikeSlackChannelId(id) || !name) continue;
      if (this.slackChannelLookupKey(name) === this.slackChannelLookupKey(normalized)) return id;
    }

    throw new Error(`Slack channel "${channel}" was not found in the local Relayfile Slack channel index`);
  }

  private isSlackChannelNotFoundError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /not found/i.test(message);
  }

  private async resolveLocalSlackByNameAlias(byNameDir: string, normalized: string): Promise<string | undefined> {
    const entries = await readdir(byNameDir, { withFileTypes: true }).catch(() => []);
    const matches: string[] = [];
    const targetKey = this.slackChannelLookupKey(normalized);

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filenameKey = this.slackChannelLookupKey(entry.name.slice(0, -'.json'.length));
      if (filenameKey !== targetKey && !filenameKey.startsWith(`${targetKey}-`)) continue;

      const raw = await readFile(path.join(byNameDir, entry.name), 'utf8').catch(() => undefined);
      const alias = this.parseSlackChannelAlias(raw ?? '');
      if (!alias?.id) continue;
      if (alias.name && this.slackChannelLookupKey(alias.name) !== targetKey && filenameKey !== targetKey) continue;
      matches.push(alias.id);
    }

    const uniqueMatches = Array.from(new Set(matches));
    if (uniqueMatches.length > 1) {
      throw new Error(`Slack channel "${normalized}" is ambiguous in Relayfile's Slack channel by-name aliases`);
    }
    return uniqueMatches[0];
  }

  private parseSlackChannelIndex(raw: string): Array<{ id: string; name?: string; title?: string }> {
    const parsed = this.tryParseJson(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (!id) return [];
      return [
        {
          id,
          name: typeof record.name === 'string' ? record.name : undefined,
          title: typeof record.title === 'string' ? record.title : undefined,
        },
      ];
    });
  }

  private parseSlackChannelAlias(raw: string): { id: string; name?: string; title?: string } | undefined {
    const parsed = this.tryParseJson(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;
    if (!id) return undefined;
    return {
      id,
      name: typeof record.name === 'string' ? record.name : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
    };
  }

  private findSlackChannelIndexMatch(
    entries: Array<{ id: string; name?: string; title?: string }>,
    normalized: string
  ): { id: string } | undefined {
    const matches = entries.filter((entry) => {
      return [entry.id, entry.name, entry.title]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => this.slackChannelLookupKey(value) === this.slackChannelLookupKey(normalized));
    });
    if (matches.length > 1) {
      throw new Error(`Slack channel "${normalized}" is ambiguous in Relayfile's Slack channel index`);
    }
    return matches[0];
  }

  private async resolveSlackChannelIdFromCloudOptions(normalized: string): Promise<string | undefined> {
    const storedAuth = await readStoredAuth().catch(() => null);
    if (!storedAuth) return undefined;

    let activeAuth: StoredAuth = storedAuth;
    const fetchCloud = async (requestPath: string): Promise<Response> => {
      const result = await authorizedApiFetch(activeAuth, requestPath, { method: 'GET' });
      activeAuth = result.auth;
      return result.response;
    };

    try {
      const whoamiResponse = await fetchCloud('/api/v1/auth/whoami');
      if (!whoamiResponse.ok) return undefined;
      const workspaceId = this.accountWorkspaceIdFromWhoami(await whoamiResponse.json().catch(() => null));
      if (!workspaceId) return undefined;

      const entries = await this.fetchSlackChannelOptions(workspaceId, fetchCloud);
      const match = this.findSlackChannelIndexMatch(entries, normalized);
      return match?.id;
    } catch {
      return undefined;
    }
  }

  private async fetchSlackChannelOptions(
    workspaceId: string,
    fetchCloud: (requestPath: string) => Promise<Response>
  ): Promise<Array<{ id: string; name?: string; title?: string }>> {
    const optionsPath = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack/options/channels`;
    const optionsResponse = await fetchCloud(optionsPath);
    if (optionsResponse.ok) {
      return this.parseSlackChannelOptionsPayload(await optionsResponse.json().catch(() => null));
    }

    const entries: Array<{ id: string; name?: string; title?: string }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const legacyResponse = await fetchCloud(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack/channels/available${query}`
      );
      if (!legacyResponse.ok) return entries;
      const parsed = this.parseLegacySlackChannelOptionsPayload(await legacyResponse.json().catch(() => null));
      entries.push(...parsed.entries);
      cursor = parsed.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);

    return entries;
  }

  private parseSlackChannelOptionsPayload(payload: unknown): Array<{ id: string; name?: string; title?: string }> {
    if (!payload || typeof payload !== 'object') return [];
    const options = (payload as Record<string, unknown>).options;
    if (!Array.isArray(options)) return [];

    return options.flatMap((option) => {
      if (!option || typeof option !== 'object') return [];
      const record = option as Record<string, unknown>;
      const id = typeof record.value === 'string' ? record.value : undefined;
      if (!id) return [];
      const label = typeof record.label === 'string' ? record.label : undefined;
      return [
        {
          id,
          name: label ? this.normalizeSlackChannelIdentifier(label) : undefined,
          title: label,
        },
      ];
    });
  }

  private parseLegacySlackChannelOptionsPayload(payload: unknown): {
    entries: Array<{ id: string; name?: string; title?: string }>;
    nextCursor?: string;
  } {
    if (!payload || typeof payload !== 'object') return { entries: [] };
    const record = payload as Record<string, unknown>;
    const channels = Array.isArray(record.channels) ? record.channels : [];
    const entries = channels.flatMap((channel) => {
      if (!channel || typeof channel !== 'object') return [];
      const channelRecord = channel as Record<string, unknown>;
      const id = typeof channelRecord.id === 'string' ? channelRecord.id : undefined;
      if (!id) return [];
      const name = typeof channelRecord.name === 'string' ? channelRecord.name : undefined;
      return [{ id, name, title: name ? `#${name}` : undefined }];
    });
    const nextCursor = typeof record.nextCursor === 'string' && record.nextCursor.trim() ? record.nextCursor : undefined;
    return { entries, nextCursor };
  }

  private accountWorkspaceIdFromWhoami(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    const currentWorkspace = record.currentWorkspace;
    if (currentWorkspace && typeof currentWorkspace === 'object') {
      const id = (currentWorkspace as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id;
    }
    for (const key of ['workspaceId', 'workspace_id', 'currentWorkspaceId']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  }

  private slackChannelByNameAliasPaths(normalized: string): string[] {
    const slug = this.slackChannelAliasSlug(normalized);
    if (!slug) return [];
    return [`/slack/channels/by-name/${slug}.json`, `/discovery/slack/channels/by-name/${slug}.json`];
  }

  private slackChannelAliasSlug(channel: string): string {
    return this.normalizeSlackChannelIdentifier(channel)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private normalizeSlackChannelIdentifier(channel: string): string {
    return channel.trim().replace(/^#/, '');
  }

  private slackChannelLookupKey(channel: string): string {
    return this.normalizeSlackChannelIdentifier(channel).toLowerCase();
  }

  private looksLikeSlackChannelId(channel: string): boolean {
    return /^[cdg][a-z0-9]{8,}$/i.test(channel);
  }

  private async resolveRelayfileRuntimeConfigFromLocalCredentials(config?: RelayYamlConfig): Promise<RelayfileRuntimeConfig | undefined> {
    const localRoot = await this.resolveRelayfileLocalRoot(config);
    if (!localRoot) return undefined;

    const credentialFiles = [
      path.join(localRoot, 'discovery', 'slack', '.relay', 'creds.json'),
      path.join(localRoot, 'slack', '.relay', 'creds.json'),
    ];
    for (const candidate of credentialFiles) {
      const raw = await readFile(candidate, 'utf8').catch(() => undefined);
      if (!raw) continue;
      const parsed = this.tryParseJson(raw);
      if (!parsed || typeof parsed !== 'object') continue;
      const token = (parsed as Record<string, unknown>).token;
      if (typeof token !== 'string' || !token.trim()) continue;
      const workspaceId = this.relayfileWorkspaceIdFromJwt(token);
      if (!workspaceId) continue;
      return {
        baseUrl:
          this.currentConfig?.integrations?.relayfile?.baseUrl ??
          config?.integrations?.relayfile?.baseUrl ??
          process.env.RELAYFILE_BASE_URL ??
          'https://file.agentrelay.com',
        workspaceId,
        token,
        source: 'local-creds',
      };
    }
    return undefined;
  }

  private relayfileRuntimeTokenNeedsRefresh(runtime: RelayfileRuntimeConfig): boolean {
    const expiresAt = this.relayfileJwtExpiresAtMs(runtime.token);
    if (!expiresAt) return false;
    return expiresAt - Date.now() <= 5 * 60_000;
  }

  private relayfileJwtExpiresAtMs(token: string): number | undefined {
    const payload = this.relayfileJwtPayload(token);
    const exp = payload?.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return undefined;
    return exp * 1000;
  }

  private relayfileJwtPayload(token: string): Record<string, unknown> | undefined {
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return undefined;
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private relayfileJwtScopes(token: string): string[] {
    const payload = this.relayfileJwtPayload(token);
    const scopes = payload?.scopes;
    if (!Array.isArray(scopes)) return [];
    return scopes.filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0);
  }

  private relayfileRefreshScopes(runtime: RelayfileRuntimeConfig): string[] {
    const scopes = this.relayfileJwtScopes(runtime.token);
    const workspaceScopes = scopes.filter((scope) => /^workspace:[^:]+:(read|write):\//.test(scope));
    if (workspaceScopes.length > 0) return workspaceScopes;
    const relayfilePathScopes = scopes.filter((scope) => /^relayfile:fs:(read|write):\//.test(scope));
    if (relayfilePathScopes.length > 0) return relayfilePathScopes;

    const hasFullRead = scopes.includes('fs:read') || scopes.includes('relayfile:fs:read:/**');
    const hasFullWrite = scopes.includes('fs:write') || scopes.includes('relayfile:fs:write:/**');
    const next: string[] = [];
    if (hasFullRead) next.push('relayfile:fs:read:/**');
    if (hasFullWrite) next.push('relayfile:fs:write:/**');
    if (next.length > 0) return next;

    return [
      'relayfile:fs:read:/slack/channels/**',
      'relayfile:fs:write:/slack/channels/**',
      'relayfile:fs:read:/discovery/slack/**',
    ];
  }

  private async issueFreshRelayfileRuntimeToken(runtime: RelayfileRuntimeConfig): Promise<RelayfileRuntimeConfig | undefined> {
    if (!runtime.workspaceId.trim()) return undefined;
    const storedAuth = await readStoredAuth().catch(() => null);
    if (!storedAuth) return undefined;

    const setup = RelayfileSetup.fromCloudTokens(storedAuth, {
      cloudApiUrl: storedAuth.apiUrl,
      requestTimeoutMs: 15_000,
    });
    const handle = await setup.joinWorkspace(runtime.workspaceId, {
      agentName: 'relayflows',
      scopes: this.relayfileRefreshScopes(runtime),
    });
    const token = handle.getToken();
    if (!token.trim()) return undefined;
    return {
      ...runtime,
      baseUrl: handle.info.relayfileUrl || runtime.baseUrl,
      workspaceId: handle.workspaceId || runtime.workspaceId,
      token,
    };
  }

  private async resolveLocalSlackMessageDir(localRoot: string, channel: string): Promise<string> {
    const channelId = this.sanitizeRelayfilePathSegment(channel);
    const directChannelRoot = path.join(localRoot, 'slack', 'channels');
    const directEntries = await readdir(directChannelRoot, { withFileTypes: true }).catch(() => []);
    const direct = directEntries.find((entry) => entry.isDirectory() && entry.name.startsWith(channelId));
    if (direct) return path.join(directChannelRoot, direct.name, 'messages');

    return path.join(directChannelRoot, channelId, 'messages');
  }

  private async resolveLocalSlackWatchDirs(localRoot: string, channel: string): Promise<string[]> {
    const channelId = this.sanitizeRelayfilePathSegment(channel);
    const dirs = new Set<string>();
    dirs.add(path.join(localRoot, 'discovery', 'slack', 'channels', channelId, 'messages'));
    dirs.add(path.join(localRoot, 'slack', 'channels', channelId, 'messages'));

    const directChannelRoot = path.join(localRoot, 'slack', 'channels');
    const directEntries = await readdir(directChannelRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of directEntries) {
      if (entry.isDirectory() && entry.name.startsWith(channelId)) {
        dirs.add(path.join(directChannelRoot, entry.name, 'messages'));
      }
    }

    const existing: string[] = [];
    for (const dir of dirs) {
      if (await this.pathExists(dir)) existing.push(dir);
    }
    return existing.length > 0 ? existing : [await this.resolveLocalSlackMessageDir(localRoot, channel)];
  }

  private async listLocalSlackAnswerFiles(localRoot: string, channel: string): Promise<string[]> {
    const channelId = this.sanitizeRelayfilePathSegment(channel);
    const dirs = new Set<string>();
    dirs.add(path.join(localRoot, 'discovery', 'slack', 'channels', channelId, 'messages'));
    dirs.add(path.join(localRoot, 'slack', 'channels', channelId, 'messages'));

    const directChannelRoot = path.join(localRoot, 'slack', 'channels');
    const directEntries = await readdir(directChannelRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of directEntries) {
      if (entry.isDirectory() && entry.name.startsWith(channelId)) {
        dirs.add(path.join(directChannelRoot, entry.name, 'messages'));
      }
    }

    const files: string[] = [];
    for (const dir of dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
    return files;
  }

  private async pathExists(candidate: string): Promise<boolean> {
    return stat(candidate)
      .then(() => true)
      .catch(() => false);
  }

  private async readRelayfileSlackMessageThreadTs(path: string): Promise<string | undefined> {
    const runtime = this.relayfileRuntimeConfig;
    if (!runtime) return undefined;
    const file = await this.getRelayfileClient().readFile(runtime.workspaceId, path).catch(() => undefined);
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!content.trim()) return undefined;
    const parsed = this.tryParseJson(content);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    for (const key of ['externalId', 'thread_ts', 'ts', 'id']) {
      const value = record[key];
      if (typeof value === 'string' && /^\d+\.\d+$/.test(value.trim())) return value.trim();
    }
    return undefined;
  }

  private async readRelayfileSlackAnswer(
    path: string,
    questionText: string
  ): Promise<{ text: string; payload: unknown } | undefined> {
    const runtime = this.relayfileRuntimeConfig;
    if (!runtime) return undefined;
    const file = await this.getRelayfileClient().readFile(runtime.workspaceId, path).catch(() => undefined);
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!content.trim()) return undefined;

    const parsed = this.tryParseJson(content);
    const payload = parsed ?? content;
    const text = this.extractTextFromSlackRelayfilePayload(payload);
    if (!text) return undefined;
    if (text.trim() === questionText.trim()) return undefined;
    if (text.includes('Workflow step "') && text.includes(' asks:')) return undefined;
    return { text: text.trim(), payload };
  }

  private async readRelayfileSlackAnswerText(path: string, questionText: string): Promise<string | undefined> {
    return (await this.readRelayfileSlackAnswer(path, questionText))?.text;
  }

  private slackAnswerMatchesQuestionThread(payload: unknown, eventPath: string, questionThreadTs: string): boolean {
    const normalizedThread = questionThreadTs.replace('.', '_');
    if (eventPath.includes(`/threads/${normalizedThread}/`) || eventPath.includes(`/messages/${normalizedThread}/`)) {
      return true;
    }
    const threadTs = this.extractSlackThreadTs(payload);
    return threadTs === questionThreadTs;
  }

  private extractSlackThreadTs(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    for (const key of ['thread_ts', 'ts']) {
      const value = record[key];
      if (typeof value === 'string' && /^\d+\.\d+$/.test(value.trim())) return value.trim();
    }
    const rawEvent = record.raw_event;
    if (rawEvent && typeof rawEvent === 'object') {
      const nested = this.extractSlackThreadTs(rawEvent);
      if (nested) return nested;
    }
    const data = record.data;
    if (data && typeof data === 'object') return this.extractSlackThreadTs(data);
    return undefined;
  }

  private extractTextFromSlackRelayfilePayload(payload: unknown): string | undefined {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    for (const key of ['text', 'body', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') {
        const nested = this.extractTextFromSlackRelayfilePayload(value);
        if (nested) return nested;
      }
    }
    const data = record.data;
    if (data && typeof data === 'object') return this.extractTextFromSlackRelayfilePayload(data);
    return undefined;
  }

  private tryParseJson(value: string): unknown | undefined {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }

  private relayfileWorkspaceIdFromJwt(token: string): string | undefined {
    const parts = token.split('.');
    if (parts.length < 2) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
      const workspaceId = payload.wks ?? payload.workspaceId ?? payload.workspace_id;
      return typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  private sanitizeRelayfilePathSegment(value: string): string {
    return value.replace(/^#/, '').replace(/[^A-Za-z0-9_.=-]/g, '_');
  }

  private async injectAnswerToAgent(input: {
    agentName: string;
    text: string;
    stepName: string;
    source: 'slack';
  }): Promise<void> {
    if (!this.activeAgentHandles.has(input.agentName)) {
      throw new Error(
        `Cannot inject ${input.source} answer into "${input.agentName}" because that agent is not active`
      );
    }
    if (!this.relay) {
      throw new Error('Cannot inject human answer because the workflow broker is not connected');
    }

    this.log(`[${input.stepName}] Injecting ${input.source} answer into ${input.agentName}`);
    if (typeof this.relay.sendInput === 'function') {
      void this.relay.sendInput(input.agentName, `${input.text}\r`).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (/aborted due to timeout|operation was aborted|timeout/i.test(message)) return;
        this.log(`[${input.stepName}] PTY input dispatch reported an error for ${input.agentName}: ${message}`);
      });
      // The current broker writes PTY input before replying, but does not ack the
      // successful write. Give the dispatch a moment to leave this process.
      await this.delay(500);
    } else {
      await Promise.race([
        this.withBrokerRecovery(`injecting ${input.source} answer into "${input.agentName}"`, (relay) =>
          relay.sendMessage({
            from: 'workflow-runner',
            to: input.agentName,
            text: input.text,
          })
        ),
        this.delay(20_000).then(() => {
          throw new Error(`Timed out injecting ${input.source} answer into "${input.agentName}"`);
        }),
      ]);
    }
    this.log(`[${input.stepName}] Injected ${input.source} answer into ${input.agentName}`);
    this.postToChannel(`**[${input.stepName}]** Injected ${input.source} answer into \`${input.agentName}\``);
  }

  // ── Idle nudging ────────────────────────────────────────────────────────

  /** Patterns where a hub agent coordinates spoke agents. */
  private static readonly HUB_PATTERNS = new Set<string>([
    'fan-out',
    'hub-spoke',
    'hierarchical',
    'map-reduce',
    'scatter-gather',
    'supervisor',
    'saga',
    'auction',
  ]);

  /** Roles that indicate a coordinator/lead agent (eligible for delegation guidance). */
  private static readonly HUB_ROLES = new Set([
    'lead',
    'hub',
    'coordinator',
    'supervisor',
    'orchestrator',
    'auctioneer',
  ]);

  private isLeadLikeAgent(agentDef: AgentDefinition, roleOverride?: string): boolean {
    if (agentDef.preset === 'lead') return true;

    const role = (roleOverride ?? agentDef.role ?? '').toLowerCase();
    const nameLC = agentDef.name.toLowerCase();
    return [...WorkflowRunner.HUB_ROLES].some(
      (hubRole) =>
        new RegExp(`\\b${hubRole}\\b`, 'i').test(nameLC) || new RegExp(`\\b${hubRole}\\b`, 'i').test(role)
    );
  }

  private shouldPreserveIdleSupervisor(
    agentDef: AgentDefinition,
    step: WorkflowStep,
    evidenceRole?: string
  ): boolean {
    if (evidenceRole && /\bowner\b/i.test(evidenceRole)) {
      return true;
    }

    if (!this.isLeadLikeAgent(agentDef, evidenceRole)) {
      return false;
    }

    const task = step.task ?? '';
    return /\b(wait|waiting|monitor|supervis|check inbox|check.*channel|poll|DONE|_DONE|signal|handoff)\b/i.test(
      task
    );
  }

  private async releaseAgentIfVerificationPassedAfterHumanInput(
    agent: WorkflowAgentHandle,
    step: WorkflowStep,
    promptTaskText?: string
  ): Promise<boolean> {
    if (!step.verification || step.verification.type !== 'output_contains') return false;
    const ptyOutput = (this.ptyOutputBuffers.get(agent.name) ?? []).join('');
    const verificationPassed = this.outputContainsVerificationToken(
      ptyOutput,
      step.verification.value,
      promptTaskText
    );
    if (!verificationPassed) return false;

    this.log(`[${step.name}] Slack human answer received and verification passed — releasing ${agent.name}`);
    this.postToChannel(
      `**[${step.name}]** Slack human answer received and verification passed — releasing \`${agent.name}\``
    );
    await agent.release('human answer verification passed').catch(() => undefined);
    return true;
  }

  /**
   * Wait for agent exit with idle detection and nudging.
   * If no idle nudge config is set, falls through to simple waitForExit.
   */
  private async waitForExitWithIdleNudging(
    agent: WorkflowAgentHandle,
    agentDef: AgentDefinition,
    step: WorkflowStep,
    timeoutMs?: number,
    promptTaskText?: string,
    preserveIdleSupervisor = false
  ): Promise<'exited' | 'timeout' | 'released' | 'force-released'> {
    const nudgeConfig = this.currentConfig?.swarm.idleNudge;
    if (!nudgeConfig) {
      if (preserveIdleSupervisor) {
        this.log(
          `[${step.name}] Supervising agent "${agent.name}" may idle while waiting — using exit-only completion`
        );
        return agent.waitForExit(timeoutMs);
      }

      // Idle = done: race exit against idle, but only accept idle if verification passes.
      const idleLoopStart = Date.now();
      while (true) {
        const elapsed = Date.now() - idleLoopStart;
        const remaining = timeoutMs != null ? Math.max(0, timeoutMs - elapsed) : undefined;
        if (remaining != null && remaining <= 0) {
          if (this.pendingHumanQuestions.has(agent.name) || this.pendingHumanQuestionDrafts.has(agent.name)) {
            this.log(`[${step.name}] Agent "${agent.name}" is blocked on Slack human input`);
            this.postToChannel(
              `**[${step.name}]** Agent \`${agent.name}\` is blocked on Slack human input`
            );
            await this.waitForPendingHumanQuestion(agent.name);
            if (await this.releaseAgentIfVerificationPassedAfterHumanInput(agent, step, promptTaskText)) {
              return 'released';
            }
            continue;
          }
          return 'timeout';
        }
        const result = await Promise.race([
          agent.waitForExit(remaining).then((r) => ({ kind: 'exit' as const, result: r })),
          agent.waitForIdle(remaining).then((r) => ({ kind: 'idle' as const, result: r })),
        ]);
        if (result.kind === 'idle' && result.result === 'idle') {
          if (this.pendingHumanQuestions.has(agent.name) || this.pendingHumanQuestionDrafts.has(agent.name)) {
            this.log(`[${step.name}] Agent "${agent.name}" is waiting for a Slack human answer`);
            this.postToChannel(
              `**[${step.name}]** Agent \`${agent.name}\` is waiting for a Slack human answer`
            );
            await this.waitForPendingHumanQuestion(agent.name);
            if (await this.releaseAgentIfVerificationPassedAfterHumanInput(agent, step, promptTaskText)) {
              return 'released';
            }
            continue;
          }
          // Check verification before treating idle as complete.
          if (step.verification && step.verification.type === 'output_contains') {
            const token = step.verification.value;
            const ptyOutput = (this.ptyOutputBuffers.get(agent.name) ?? []).join('');
            const verificationPassed = this.outputContainsVerificationToken(ptyOutput, token, promptTaskText);
            if (!verificationPassed) {
              // The broker fires agent_idle only once per idle transition.
              // If the agent is still working (will produce output then idle again),
              // continuing the loop works. But if the agent is permanently idle,
              // waitForIdle won't resolve again. Wait briefly for new output,
              // then release and let upstream verification handle the result.
              this.log(
                `[${step.name}] Agent "${agent.name}" went idle but verification not yet passed — waiting for more output`
              );
              const idleGraceSecs = this.resolveHumanAssistanceConfig(step) ? 90 : 15;
              const graceResult = await Promise.race([
                agent.waitForExit(idleGraceSecs * 1000).then((r) => ({ kind: 'exit' as const, result: r })),
                agent.waitForIdle(idleGraceSecs * 1000).then((r) => ({ kind: 'idle' as const, result: r })),
              ]);
              if (graceResult.kind === 'idle' && graceResult.result === 'idle') {
                // Agent went idle again after producing output — re-check verification
                continue;
              }
              if (graceResult.kind === 'exit' && graceResult.result !== 'timeout') {
                return graceResult.result as 'exited' | 'timeout' | 'released';
              }
              // Grace period timed out — agent is permanently idle without verification.
              // Release and let upstream executeAgentStep handle verification.
              this.log(
                `[${step.name}] Agent "${agent.name}" still idle after ${idleGraceSecs}s grace — releasing`
              );
              this.postToChannel(
                `**[${step.name}]** Agent \`${agent.name}\` idle — releasing (verification pending)`
              );
              await agent.release().catch(() => undefined);
              return 'released';
            }
          }
          this.log(`[${step.name}] Agent "${agent.name}" went idle — treating as complete`);
          this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — treating as complete`);
          await agent.release().catch(() => undefined);
          return 'released';
        }
        // Exit won the race, or idle returned 'exited'/'timeout' — pass through.
        return result.result as 'exited' | 'timeout' | 'released';
      }
    }

    const nudgeAfterMs = nudgeConfig.nudgeAfterMs ?? 120_000;
    const escalateAfterMs = nudgeConfig.escalateAfterMs ?? 120_000;
    const maxNudges = nudgeConfig.maxNudges ?? 1;

    let nudgeCount = 0;
    let preservedSupervisorNoticeSent = false;
    const startTime = Date.now();

    while (true) {
      // Calculate remaining time from overall timeout
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs ? timeoutMs - elapsed : undefined;
      if (remaining !== undefined && remaining <= 0) {
        return 'timeout';
      }

      // nudgeAfterMs = how long to wait before nudging (first interval).
      // escalateAfterMs = how long to wait between subsequent nudges.
      //
      // We wait for exit, not for idle. The broker's idle_threshold_secs is
      // only 30s by default, so racing waitForExit vs waitForIdle would nudge
      // after 30s of PTY silence regardless of nudgeAfterMs. Instead, we give
      // the agent the full nudgeAfterMs window to finish before nudging.
      const windowMs = nudgeCount === 0 ? nudgeAfterMs : escalateAfterMs;
      const waitMs = remaining !== undefined ? Math.min(windowMs, remaining) : windowMs;

      const exitResult = await agent.waitForExit(waitMs);

      if (exitResult !== 'timeout') {
        // Agent actually exited or was released — done
        return exitResult;
      }

      if (this.pendingHumanQuestions.has(agent.name) || this.pendingHumanQuestionDrafts.has(agent.name)) {
        this.log(`[${step.name}] Agent "${agent.name}" is blocked on Slack human input`);
        this.postToChannel(
          `**[${step.name}]** Agent \`${agent.name}\` is blocked on Slack human input`
        );
        await this.waitForPendingHumanQuestion(agent.name);
        continue;
      }

      // Agent is still running after the window expired.
      if (timeoutMs !== undefined && Date.now() - startTime >= timeoutMs) {
        return 'timeout';
      }

      // Nudge if we haven't exhausted the limit
      if (nudgeCount < maxNudges) {
        await this.nudgeIdleAgent(agent, agentDef, step);
        nudgeCount++;
        this.postToChannel(`**[${step.name}]** Agent \`${agent.name}\` idle — nudge #${nudgeCount} sent`);
        this.emit({ type: 'step:nudged', runId: this.currentRunId ?? '', stepName: step.name, nudgeCount });
        continue;
      }

      if (preserveIdleSupervisor) {
        if (!preservedSupervisorNoticeSent) {
          this.log(
            `[${step.name}] Supervising agent "${agent.name}" stayed idle after ${nudgeCount} nudge(s) — preserving until exit or timeout`
          );
          this.postToChannel(
            `**[${step.name}]** Supervising agent \`${agent.name}\` is waiting on handoff — keeping it alive until it exits or the step times out`
          );
          preservedSupervisorNoticeSent = true;
        }
        continue;
      }

      // Exhausted nudges — force-release
      this.postToChannel(
        `**[${step.name}]** Agent \`${agent.name}\` still idle after ${nudgeCount} nudge(s) — force-releasing`
      );
      this.emit({ type: 'step:force-released', runId: this.currentRunId ?? '', stepName: step.name });
      await agent.release().catch(() => undefined);
      return 'force-released';
    }
  }

  /**
   * Send a nudge to an idle agent. Uses hub-mediated nudge for hub patterns,
   * or direct system injection otherwise.
   */
  private async nudgeIdleAgent(
    agent: WorkflowAgentHandle,
    agentDef: AgentDefinition,
    step: WorkflowStep
  ): Promise<void> {
    if (!this.relay) return;
    const hubAgent = this.resolveHubForNudge(agentDef);

    if (hubAgent) {
      // Hub-mediated: tell the hub to check on the idle agent (sent as the hub).
      try {
        await this.withBrokerRecovery(`nudging idle agent "${agent.name}" via hub`, (relay) =>
          relay.sendMessage({
            from: hubAgent.name,
            to: agent.name,
            text: `Agent ${agent.name} appears idle on step "${step.name}". Check on them and remind them to /exit when done.`,
          })
        );
        return; // Hub nudge succeeded
      } catch {
        // Fall through to direct nudge
      }
    }

    // Direct system injection from the workflow runner.
    await this.withBrokerRecovery(`nudging idle agent "${agent.name}" directly`, (relay) =>
      relay.sendMessage({
        from: 'workflow-runner',
        to: agent.name,
        text: "You appear idle. If you've completed your task, output /exit. If still working, continue.",
      })
    )
      .catch(() => {
        // Non-critical — don't break workflow
      });
  }

  /**
   * Find the hub agent for hub-mediated nudging.
   * Returns the hub's live Agent handle if this is a hub pattern and the idle agent is not the hub.
   */
  private resolveHubForNudge(idleAgentDef: AgentDefinition): WorkflowAgentHandle | undefined {
    const pattern = this.currentConfig?.swarm.pattern;
    if (!pattern || !WorkflowRunner.HUB_PATTERNS.has(pattern)) {
      return undefined;
    }

    // Find an interactive agent with a hub-like role
    const agents = this.currentConfig?.agents ?? [];

    for (const agentDef of agents) {
      // Skip non-interactive and the idle agent itself
      if (agentDef.interactive === false) continue;
      if (agentDef.name === idleAgentDef.name) continue;

      const role = agentDef.role?.toLowerCase() ?? '';
      const nameLC = agentDef.name.toLowerCase();

      if (
        WorkflowRunner.HUB_ROLES.has(nameLC) ||
        [...WorkflowRunner.HUB_ROLES].some((r) => new RegExp(`\\b${r}\\b`).test(role))
      ) {
        // Found a hub candidate — check if we have a live handle
        const handle = this.activeAgentHandles.get(agentDef.name);
        if (handle) return handle;
      }
    }

    return undefined;
  }

  // ── Verification ────────────────────────────────────────────────────────

  private runVerification(
    check: VerificationCheck,
    output: string,
    stepName: string,
    injectedTaskText?: string,
    options?: VerificationOptions
  ): VerificationResult {
    try {
      const result = runVerification(
        check,
        output,
        stepName,
        injectedTaskText,
        { ...options, cwd: this.cwd },
        {
          recordStepToolSideEffect: (name, effect) => this.recordStepToolSideEffect(name, effect),
          getOrCreateStepEvidenceRecord: (name) => this.getOrCreateStepEvidenceRecord(name),
          log: (message) => this.log(message),
        }
      );

      this.updateCustomVerificationFailure(stepName, check, result.error);
      return result;
    } catch (error) {
      this.updateCustomVerificationFailure(
        stepName,
        check,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private updateCustomVerificationFailure(
    stepName: string,
    check: VerificationCheck,
    errorMessage?: string
  ): void {
    if (check.type !== 'custom' || !check.value || !errorMessage) {
      this.lastCustomVerificationFailure.delete(stepName);
      return;
    }

    const marker = `custom check "${check.value}" failed\n`;
    const markerIndex = errorMessage.indexOf(marker);
    const output =
      markerIndex === -1 ? errorMessage.trim() : errorMessage.slice(markerIndex + marker.length).trim();

    this.lastCustomVerificationFailure.set(stepName, {
      command: check.value,
      output,
    });
  }

  // ── State helpers ─────────────────────────────────────────────────────

  private findNeedsHumanExhaustedStep(
    errorHandling: ErrorHandlingConfig | undefined,
    stepStates: Map<string, StepState>
  ): StepState | undefined {
    if (errorHandling?.strategy !== 'retry' || errorHandling.onExhaustion !== 'needs-human') {
      return undefined;
    }

    const repairRetries = errorHandling.repairRetries ?? 0;
    if (repairRetries <= 0) return undefined;

    return [...stepStates.values()].find(
      (state) => state.row.status === 'failed' && state.row.retryCount >= repairRetries
    );
  }

  private buildNeedsHumanError(failedStep: StepState): string {
    const stepName = failedStep.row.stepName;
    const stepError = failedStep.row.error ?? 'repair budget exhausted';
    const evidence = (
      failedStep.row.output ??
      this.lastFailedStepOutput.get(stepName) ??
      ''
    ).trim();
    const suffix = evidence ? `\n\nLast evidence:\n${evidence.slice(-2000)}` : '';
    return `Step "${stepName}" exhausted its repair budget and needs human input: ${stepError}${suffix}`;
  }

  private async completeNeedsHumanRun(
    runId: string,
    workflow: WorkflowDefinition,
    stepStates: Map<string, StepState>,
    failedStep: StepState
  ): Promise<void> {
    const errorMsg = this.buildNeedsHumanError(failedStep);
    await this.updateRunStatus(runId, 'needs_human', errorMsg);
    this.emit({
      type: 'run:needs-human',
      runId,
      stepName: failedStep.row.stepName,
      error: errorMsg,
    });

    const outcomes = this.collectOutcomes(stepStates, workflow.steps);
    this.postToChannel(`Workflow **${workflow.name}** needs human input: ${failedStep.row.stepName}`);
    this.logRunSummary(workflow.name, outcomes, runId, 'needs_human');
    if (this.trajectory) {
      const summary = this.trajectory.buildRunSummary(outcomes);
      const confidence = this.trajectory.computeConfidence(outcomes);
      const learnings = this.trajectory.extractLearnings(outcomes);
      const challenges = this.trajectory.extractChallenges(outcomes);
      await this.trajectory.abandon(errorMsg, {
        summary,
        confidence,
        learnings,
        challenges,
      });
    }
  }

  private async updateRunStatus(runId: string, status: WorkflowRunStatus, error?: string): Promise<void> {
    const patch: Partial<WorkflowRunRow> = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'needs_human') {
      patch.completedAt = new Date().toISOString();
    }
    if (error) {
      patch.error = error;
    }
    await this.db.updateRun(runId, patch);
  }

  private async markStepFailed(
    state: StepState,
    error: string,
    runId: string,
    exitInfo?: { exitCode?: number; exitSignal?: string },
    completionReason?: WorkflowStepCompletionReason
  ): Promise<void> {
    this.captureStepTerminalEvidence(state.row.stepName, {}, exitInfo);
    state.row.status = 'failed';
    state.row.error = error;
    state.row.completionReason = completionReason;
    state.row.completedAt = new Date().toISOString();
    await this.db.updateStep(state.row.id, {
      status: 'failed',
      error,
      completionReason,
      completedAt: state.row.completedAt,
      updatedAt: new Date().toISOString(),
    });
    this.emit({
      type: 'step:failed',
      runId,
      stepName: state.row.stepName,
      error,
      exitCode: exitInfo?.exitCode,
      exitSignal: exitInfo?.exitSignal,
    });
    this.finalizeStepEvidence(state.row.stepName, 'failed', state.row.completedAt, completionReason);
  }

  private async captureAgentReport(
    runId: string,
    stepName: string,
    agentDef: AgentDefinition | undefined,
    cwd: string | undefined,
    startedAt: number | undefined,
    completedAt: number
  ): Promise<void> {
    if (!agentDef || !cwd || !startedAt) return;

    try {
      const report = await collectCliSession({
        cli: agentDef.cli,
        cwd,
        startedAt,
        completedAt,
      });
      if (!report) return;

      const totalTokens = this.getTotalReportTokens(report);
      if (this.budgetTracker && report.tokens) {
        this.budgetTracker.recordUsage(stepName, report.tokens);
        this.budgetTracker.isOverBudget(stepName);
        const budgetStatus = this.budgetTracker.getBudgetStatus(stepName);
        if (budgetStatus.agentLimitExceeded) {
          const stepBudget = this.budgetTracker.getStepBudgetStatus(stepName);
          const used =
            stepBudget?.used?.toLocaleString('en-US') ?? totalTokens?.toLocaleString('en-US') ?? '0';
          const limit = stepBudget?.limit?.toLocaleString('en-US') ?? '--';
          this.log(`[budget] Step ${stepName} exceeded its agent budget (${used} of ${limit})`);
        }
      }

      this.agentReports.set(stepName, report);
      this.emit({ type: 'step:agent-report', runId, stepName, report });
      await this.persistAgentReport(runId, stepName, report);
    } catch (error) {
      this.log(
        `[${stepName}] CLI session collection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async markDownstreamSkipped(
    failedStepName: string,
    allSteps: WorkflowStep[],
    stepStates: Map<string, StepState>,
    runId: string
  ): Promise<void> {
    const queue = [failedStepName];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const step of allSteps) {
        if (step.dependsOn?.includes(current)) {
          const state = stepStates.get(step.name);
          if (state && state.row.status === 'pending') {
            state.row.status = 'skipped';
            await this.db.updateStep(state.row.id, {
              status: 'skipped',
              updatedAt: new Date().toISOString(),
            });
            this.emit({ type: 'step:skipped', runId, stepName: step.name });
            this.postToChannel(`**[${step.name}]** Skipped — upstream dependency "${current}" failed`);
            await this.trajectory?.stepSkipped(step, `Upstream dependency "${current}" failed`);
            await this.trajectory?.decide(
              `Whether to skip ${step.name}`,
              'skip',
              `Upstream dependency "${current}" failed`
            );
            queue.push(step.name);
          }
        }
      }
    }
  }

  // ── startFrom dependency resolution ─────────────────────────────────

  /**
   * Walk the dependsOn graph backwards from a target step to collect ALL
   * transitive dependencies (i.e. every step that must complete before
   * the target step can run). The target step itself is NOT included.
   */
  private collectTransitiveDeps(targetStep: string, steps: WorkflowStep[]): Set<string> {
    const stepMap = new Map<string, WorkflowStep>();
    for (const s of steps) stepMap.set(s.name, s);

    const deps = new Set<string>();
    const queue = [...(stepMap.get(targetStep)?.dependsOn ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (deps.has(current)) continue;
      deps.add(current);
      const step = stepMap.get(current);
      if (step?.dependsOn) {
        for (const dep of step.dependsOn) {
          if (!deps.has(dep)) queue.push(dep);
        }
      }
    }

    return deps;
  }

  // ── Control flow helpers ──────────────────────────────────────────────

  private checkAborted(): void {
    if (this.abortController?.signal.aborted) {
      throw new Error('Workflow aborted');
    }
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.pauseResolver = resolve;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Channel messaging ──────────────────────────────────────────────────

  /**
   * Build a metadata note about non-interactive workers for inclusion in interactive agent tasks.
   * Returns undefined if there are no non-interactive agents.
   */
  private buildNonInteractiveAwareness(
    agentMap: Map<string, AgentDefinition>,
    stepStates: Map<string, StepState>
  ): string | undefined {
    return this.channelMessenger.buildNonInteractiveAwareness(agentMap, stepStates);
  }

  /**
   * Build guidance that encourages agents to autonomously delegate subtasks
   * to helper agents when work is too complex for a single pass.
   */
  /**
   * Returns a relay registration preamble for CLIs that don't auto-call
   * `register` via the MCP system prompt (everyone except claude).
   *
   * Claude reads the Relaycast system prompt and registers on its own.
   * Codex, gemini, etc. have the MCP server configured with the workspace
   * key, but they won't call `register` unless explicitly told to.
   */
  private buildRelayRegistrationNote(cli: string, agentName: string): string {
    return this.channelMessenger.buildRelayRegistrationNote(cli, agentName);
  }

  private buildDelegationGuidance(cli: string, timeoutMs?: number): string {
    return this.channelMessenger.buildDelegationGuidance(cli, timeoutMs);
  }

  /** Post a message to the workflow channel. Fire-and-forget — never throws or blocks. */
  private postToChannel(text: string, options: ChannelEvidenceOptions = {}): void {
    if (!this.relayApiKey || !this.channel) return;
    this.recordChannelEvidence(text, options);

    const stepName = options.stepName ?? this.inferStepNameFromChannelText(text);
    if (stepName) {
      this.recordStepToolSideEffect(stepName, {
        type: 'post_channel_message',
        detail: text.slice(0, 240),
        raw: {
          actor: options.actor,
          role: options.role,
          target: options.target ?? this.channel,
          origin: options.origin ?? 'runner_post',
        },
      });
    }

    this.ensureRelaycastRunnerAgent()
      .then((agent) => agent.send(this.channel!, text))
      .catch(() => {
        // Non-critical — don't break workflow execution
      });
  }

  /** Post a rich completion report to the channel. */
  private postCompletionReport(
    workflowName: string,
    outcomes: StepOutcome[],
    summary: string,
    confidence: number
  ): void {
    this.channelMessenger.postCompletionReport(workflowName, outcomes, summary, confidence);
  }

  /** Post a failure report to the channel. */
  private postFailureReport(workflowName: string, outcomes: StepOutcome[], errorMsg: string): void {
    this.channelMessenger.postFailureReport(workflowName, outcomes, errorMsg);
  }

  /**
   * Log a human-readable run summary to the console after completion or failure.
   * Extracts the last meaningful lines from each step's raw PTY output.
   */
  private logRunSummary(
    workflowName: string,
    outcomes: StepOutcome[],
    runId: string,
    status: Extract<WorkflowRunStatus, 'completed' | 'failed' | 'needs_human'> = 'failed'
  ): void {
    const completed = outcomes.filter((o) => o.status === 'completed');
    const failed = outcomes.filter((o) => o.status === 'failed');
    const skipped = outcomes.filter((o) => o.status === 'skipped');
    const statusLabel =
      status === 'completed'
        ? chalk.green('COMPLETED')
        : status === 'needs_human'
          ? chalk.yellow('NEEDS HUMAN')
          : chalk.red('FAILED');

    console.log('');
    console.log(chalk.dim('━'.repeat(70)));
    console.log(`  Workflow "${workflowName}" — ${statusLabel}`);
    console.log(
      `  ${chalk.green(`${completed.length} passed`)}, ${chalk.red(`${failed.length} failed`)}, ${chalk.dim(`${skipped.length} skipped`)}`
    );
    console.log(chalk.dim('━'.repeat(70)));

    // Always show the summary table — with agent reports when available,
    // with just step/status/duration when not (non-interactive agents).
    console.log(
      formatRunSummaryTable(outcomes, this.agentReports, this.budgetTracker?.getRunSummaryBudgetData())
    );

    // Show errors and output excerpts for failed steps below the table
    for (const outcome of outcomes) {
      if (outcome.status !== 'failed') continue;

      if (outcome.error) {
        console.log(chalk.red(`  ${outcome.name}: ${outcome.error}`));
      }

      if (outcome.output) {
        const excerpt = this.extractOutputExcerpt(outcome.output);
        if (excerpt) {
          for (const line of excerpt.split('\n')) {
            console.log(`    ${line}`);
          }
        }
      }
    }

    // Point to detailed output files
    const outputDir = this.getStepOutputDir(runId);
    const logsDir = path.join(this.cwd, '.agent-relay', 'team', 'worker-logs');
    console.log('');
    console.log(`  Run ID:      ${runId}`);
    console.log(`  Step output: ${outputDir}`);
    console.log(`  Agent logs:  ${logsDir}`);
    console.log(chalk.dim('━'.repeat(70)));
    console.log('');
  }

  /**
   * Extract a useful excerpt from raw PTY output.
   * Looks for the agent's final text output (ignoring ANSI, system prompts, tool calls).
   */
  private extractOutputExcerpt(rawOutput: string): string {
    const stripped = WorkflowRunner.stripAnsi(rawOutput);

    // Split into lines, filter out noise
    const lines = stripped.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Skip system/UI chrome
      if (trimmed.startsWith('╭') || trimmed.startsWith('╰') || trimmed.startsWith('│')) return false;
      if (trimmed.startsWith('─')) return false;
      if (trimmed.startsWith('❯') || trimmed.startsWith('⏵')) return false;
      if (trimmed.startsWith('<system-reminder>') || trimmed.startsWith('</system-reminder>')) return false;
      if (/^\[?workflow\s/.test(trimmed)) return false;
      // Skip tool invocations
      if (/^(Read|Edit|Bash|Glob|Grep|Task|Explore|Write)\(/.test(trimmed)) return false;
      // Skip thinking indicators
      if (/^[·✳✻✽⏺]?\s*Sublimating/.test(trimmed)) return false;
      // Skip very short lines (likely UI fragments)
      if (trimmed.length < 10) return false;
      return true;
    });

    if (lines.length === 0) return '';

    // Take the last few meaningful lines (agent's final words)
    const tail = lines.slice(-5);
    const excerpt = tail.map((l) => l.trim().slice(0, 120)).join('\n');
    return excerpt.length > 0 ? `...\n${excerpt}` : '';
  }

  // ── Trajectory helpers ────────────────────────────────────────────────

  /** Analyze DAG structure for trajectory context. */
  private analyzeDAG(steps: WorkflowStep[]): string {
    const roots = steps.filter((s) => !s.dependsOn?.length);
    const withDeps = steps.filter((s) => s.dependsOn?.length);

    const parts = [`Parsed ${steps.length} steps`];
    if (roots.length > 1) {
      parts.push(`${roots.length} parallel tracks`);
    }
    if (withDeps.length > 0) {
      parts.push(`${withDeps.length} dependent steps`);
    }
    parts.push('DAG validated, no cycles');
    return parts.join(', ');
  }

  /** Collect step outcomes for trajectory synthesis. */
  private collectOutcomes(stepStates: Map<string, StepState>, steps?: WorkflowStep[]): StepOutcome[] {
    const stepsWithVerification = new Set(steps?.filter((s) => s.verification).map((s) => s.name) ?? []);
    const outcomes: StepOutcome[] = [];
    for (const [name, state] of stepStates) {
      const startedAtMs = state.row.startedAt ? Date.parse(state.row.startedAt) : Number.NaN;
      const completedAtMs = state.row.completedAt ? Date.parse(state.row.completedAt) : Number.NaN;
      const durationMs =
        Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
          ? Math.max(0, completedAtMs - startedAtMs)
          : undefined;
      outcomes.push({
        name,
        agent: state.row.agentName ?? 'deterministic',
        status:
          state.row.status === 'completed'
            ? 'completed'
            : state.row.status === 'skipped'
              ? 'skipped'
              : 'failed',
        attempts: state.row.retryCount + 1,
        output: state.row.output,
        error: state.row.error,
        verificationPassed: state.row.status === 'completed' && stepsWithVerification.has(name),
        durationMs,
        completionMode: state.row.completionReason
          ? this.buildStepCompletionDecision(name, state.row.completionReason)?.mode
          : undefined,
      });
    }
    return outcomes;
  }

  // ── ID generation ─────────────────────────────────────────────────────

  private persistRunIdHint(runId: string): void {
    const target = process.env.AGENT_RELAY_RUN_ID_FILE?.trim();
    if (!target) return;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, runId + '\n', 'utf8');
    } catch {
      // Ignore hint persistence failures.
    }
  }

  private generateId(): string {
    return randomBytes(12).toString('hex');
  }

  private generateShortId(): string {
    return randomBytes(4).toString('hex');
  }

  /** Strip ANSI escape codes from terminal output — delegates to pty.ts canonical regex. */
  private static stripAnsi(text: string): string {
    return stripAnsiFn(text);
  }

  /**
   * Strip TUI chrome from PTY-captured output before posting to a channel.
   * Removes: ANSI codes, unicode spinner/thinking characters, cursor-movement
   * artifacts, and collapses runs of blank lines to a single blank line.
   * The raw (ANSI-stripped) output is still written to disk for step chaining.
   */
  private static scrubForChannel(text: string): string {
    return scrubWorkflowOutputForChannel(text);
  }

  /** Sanitize a workflow name into a valid channel name. */
  private sanitizeChannelName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32);
  }

  /** Validate that a runId is safe for use in file paths (no traversal). */
  private validateRunId(runId: string): void {
    if (/[/\\]|^\.\.?$/.test(runId) || runId.includes('..')) {
      throw new Error(`Invalid runId: "${runId}" contains path traversal characters`);
    }
  }

  /** Directory for persisted step outputs: .agent-relay/step-outputs/{runId}/ */
  private getStepOutputDir(runId: string): string {
    this.validateRunId(runId);
    return path.join(this.cwd, '.agent-relay', 'step-outputs', runId);
  }

  /** Persist step output to disk and post full output as a channel message. */
  private async persistStepOutput(runId: string, stepName: string, output: string): Promise<void> {
    // 1. Write to disk
    const outputPath = path.join(this.getStepOutputDir(runId), `${stepName}.md`);
    try {
      const dir = this.getStepOutputDir(runId);
      mkdirSync(dir, { recursive: true });
      const cleaned = WorkflowRunner.stripAnsi(output);
      await writeFile(outputPath, cleaned);
    } catch {
      // Non-critical
    }
    this.recordStepToolSideEffect(stepName, {
      type: 'persist_step_output',
      detail: `Persisted step output to ${this.normalizeEvidencePath(outputPath)}`,
      raw: { path: outputPath },
    });

    // 2. Post scrubbed output as a single channel message (most recent tail only)
    const scrubbed = WorkflowRunner.scrubForChannel(output);
    if (scrubbed.length === 0) {
      this.postToChannel(`**[${stepName}]** Step completed — output written to disk`, { stepName });
      return;
    }

    const maxMsg = 2000;
    const preview = scrubbed.length > maxMsg ? scrubbed.slice(-maxMsg) : scrubbed;
    // Surface the final output preview in the local workflow log immediately.
    // Some deterministic wrappers grep stdout/stderr for completion sentinels,
    // and fire-and-forget channel delivery can arrive too late for single-step runs.
    this.log(`[${stepName}] Output:\n\`\`\`\n${preview}\n\`\`\``);
    this.postToChannel(`**[${stepName}] Output:**\n\`\`\`\n${preview}\n\`\`\``, { stepName });
  }

  private async persistAgentReport(runId: string, stepName: string, report: CliSessionReport): Promise<void> {
    const reportPath = path.join(this.getStepOutputDir(runId), `${stepName}.report.json`);
    try {
      mkdirSync(this.getStepOutputDir(runId), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    } catch {
      // Non-critical
    }
  }

  /** Scan .agent-relay/step-outputs/ for the most recent run directory containing the needed steps. */
  private findMostRecentRunWithSteps(stepNames: Set<string>): string | undefined {
    try {
      const baseDir = path.join(this.cwd, '.agent-relay', 'step-outputs');
      if (!existsSync(baseDir)) return undefined;

      const entries = readdirSync(baseDir);
      let best: { name: string; mtime: number } | undefined;

      for (const entry of entries) {
        const dirPath = path.join(baseDir, entry);
        try {
          const stat = statSync(dirPath);
          if (!stat.isDirectory()) continue;

          // Check if this directory has at least one of the needed step files
          const hasAny = [...stepNames].some((name) => existsSync(path.join(dirPath, `${name}.md`)));
          if (!hasAny) continue;

          if (!best || stat.mtimeMs > best.mtime) {
            best = { name: entry, mtime: stat.mtimeMs };
          }
        } catch {
          continue;
        }
      }

      return best?.name;
    } catch {
      return undefined;
    }
  }

  /** Load persisted step output from disk. */
  private loadStepOutput(runId: string, stepName: string): string | undefined {
    try {
      const filePath = path.join(this.getStepOutputDir(runId), `${stepName}.md`);
      if (!existsSync(filePath)) return undefined;
      return readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /** Match the best workflow from config given a set of cached step names. */
  private matchWorkflowFromCache(
    workflows: WorkflowDefinition[],
    cachedStepNames: Set<string>
  ): WorkflowDefinition | null {
    if (workflows.length === 1) return workflows[0];

    if (cachedStepNames.size === 0) {
      // No cached steps to disambiguate — ambiguous when multiple workflows exist
      this.log('[resume] Multiple workflows in config with empty cache — cannot disambiguate');
      return null;
    }

    // Score each workflow by how many cached steps match, excluding those with unknown steps
    const scored = workflows
      .map((candidate) => ({
        workflow: candidate,
        matchedSteps: candidate.steps.filter((step) => cachedStepNames.has(step.name)).length,
        unknownSteps: [...cachedStepNames].filter(
          (name) => !candidate.steps.some((step) => step.name === name)
        ).length,
      }))
      .filter((candidate) => candidate.unknownSteps === 0)
      .sort((a, b) => b.matchedSteps - a.matchedSteps);

    return scored[0]?.workflow ?? null;
  }

  private reconstructRunFromCache(
    runId: string,
    config?: RelayYamlConfig
  ): { run: WorkflowRunRow; stepStates: Map<string, StepState> } | null {
    const stepOutputDir = this.getStepOutputDir(runId);
    if (!existsSync(stepOutputDir)) return null;

    let resumeConfig = config ?? this.currentConfig;
    if (!resumeConfig) {
      // Attempt to load config from relay.yaml on disk (resume() may call before runWorkflowCore sets currentConfig)
      const yamlPath = path.join(this.cwd, 'relay.yaml');
      if (existsSync(yamlPath)) {
        try {
          const raw = readFileSync(yamlPath, 'utf-8');
          resumeConfig = this.parseYamlString(raw, yamlPath);
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(stepOutputDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const cachedStepNames = new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name.slice(0, -3))
        .filter(Boolean)
    );
    const workflows = resumeConfig.workflows ?? [];
    if (workflows.length === 0) return null;

    // Empty cache directory is valid — all steps will be re-run
    const workflow = this.matchWorkflowFromCache(workflows, cachedStepNames);
    if (!workflow) return null;

    // Use actual file modification times from cached outputs instead of synthetic timestamps
    const stepMtimes = new Map<string, string>();
    let earliestMtime = Date.now();
    for (const stepName of cachedStepNames) {
      try {
        const mdPath = path.join(stepOutputDir, `${stepName}.md`);
        const reportPath = path.join(stepOutputDir, `${stepName}.report.json`);
        const mdStat = existsSync(mdPath) ? statSync(mdPath) : null;
        const reportStat = existsSync(reportPath) ? statSync(reportPath) : null;
        // Use the latest mtime between .md and .report.json
        const mtime = Math.max(mdStat?.mtimeMs ?? 0, reportStat?.mtimeMs ?? 0);
        if (mtime > 0) {
          stepMtimes.set(stepName, new Date(mtime).toISOString());
          if (mtime < earliestMtime) earliestMtime = mtime;
        }
      } catch {
        // Fall back to current time if stat fails
      }
    }
    const fallbackTime = new Date().toISOString();

    const completedSteps = new Set(
      workflow.steps.filter((step) => cachedStepNames.has(step.name)).map((step) => step.name)
    );
    // Heuristic: mark the first eligible non-completed step as failed (the likely failure point)
    const failedStepName = workflow.steps.find(
      (step) =>
        !completedSteps.has(step.name) && (step.dependsOn ?? []).every((dep) => completedSteps.has(dep))
    )?.name;

    const runStartedAt = new Date(earliestMtime).toISOString();
    const run: WorkflowRunRow = {
      id: runId,
      workspaceId: this.workspaceId,
      workflowName: workflow.name,
      pattern: resumeConfig.swarm.pattern,
      status: 'failed',
      config: resumeConfig,
      startedAt: runStartedAt,
      createdAt: runStartedAt,
      updatedAt: fallbackTime,
    };

    const stepStates = new Map<string, StepState>();
    for (const step of workflow.steps) {
      const isNonAgent =
        step.type === 'deterministic' || step.type === 'worktree' || step.type === 'integration';
      const cachedOutput = completedSteps.has(step.name) ? this.loadStepOutput(runId, step.name) : undefined;
      const status: WorkflowStepStatus = completedSteps.has(step.name)
        ? 'completed'
        : step.name === failedStepName
          ? 'failed'
          : 'pending';

      const stepRow: WorkflowStepRow = {
        id: this.generateId(),
        runId,
        stepName: step.name,
        agentName: isNonAgent ? null : (step.agent ?? null),
        stepType: isNonAgent ? (step.type as 'deterministic' | 'worktree' | 'integration') : 'agent',
        status,
        task:
          step.type === 'deterministic'
            ? (step.command ?? '')
            : step.type === 'worktree'
              ? (step.branch ?? '')
              : step.type === 'integration'
                ? `${step.integration}.${step.action}`
                : (step.task ?? ''),
        dependsOn: step.dependsOn ?? [],
        output: cachedOutput,
        error: status === 'failed' ? 'Recovered from cached step outputs' : undefined,
        completedAt: status === 'completed' ? (stepMtimes.get(step.name) ?? fallbackTime) : undefined,
        retryCount: 0,
        createdAt: stepMtimes.get(step.name) ?? fallbackTime,
        updatedAt: stepMtimes.get(step.name) ?? fallbackTime,
      };
      stepStates.set(step.name, { row: stepRow });
    }

    return { run, stepStates };
  }

  /** Get or create the worker logs directory (.agent-relay/team/worker-logs) */
  private getWorkerLogsDir(): string {
    const logsDir = path.join(this.cwd, '.agent-relay', 'team', 'worker-logs');
    mkdirSync(logsDir, { recursive: true });
    return logsDir;
  }

  /** Register a spawned agent in workers.json so `agents:kill` can find it. */
  private registerWorker(
    agentName: string,
    cli: string,
    task: string,
    pid?: number,
    interactive = true
  ): void {
    // Track in memory first (no race condition)
    const workerEntry = {
      cli,
      task: task.slice(0, 500),
      spawnedAt: Date.now(),
      pid,
      interactive,
      logFile: path.join(this.getWorkerLogsDir(), `${agentName}.log`),
    };
    this.activeWorkers.set(agentName, workerEntry);

    // Serialize file writes with mutex to prevent race conditions
    this.workersFileLock = this.workersFileLock.then(() => {
      try {
        mkdirSync(path.dirname(this.workersPath), { recursive: true });
        // Filter out any existing entry with the same name before adding
        const existing = this.readWorkers().filter((w) => w.name !== agentName);
        existing.push({ name: agentName, ...workerEntry });
        this.writeWorkers(existing);
      } catch {
        // Non-critical — don't fail the workflow if workers.json can't be written
      }
    });
  }

  /** Remove a spawned agent from workers.json after it exits. */
  private unregisterWorker(agentName: string): void {
    // Remove from in-memory tracking first
    this.activeWorkers.delete(agentName);

    // Serialize file writes with mutex to prevent race conditions
    this.workersFileLock = this.workersFileLock.then(() => {
      try {
        const existing = this.readWorkers();
        const filtered = existing.filter((w) => w.name !== agentName);
        this.writeWorkers(filtered);
      } catch {
        // Non-critical
      }
    });
  }

  private readWorkers(): Array<Record<string, unknown>> {
    try {
      if (!existsSync(this.workersPath)) return [];
      const raw = JSON.parse(readFileSync(this.workersPath, 'utf-8'));
      return Array.isArray(raw?.workers) ? raw.workers : [];
    } catch {
      return [];
    }
  }

  private writeWorkers(workers: Array<Record<string, unknown>>): void {
    writeFileSync(this.workersPath, JSON.stringify({ workers }, null, 2));
  }
}
