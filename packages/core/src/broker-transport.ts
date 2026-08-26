import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import {
  HarnessDriverClient,
  type BrokerEvent,
  type ListAgent,
  type RuntimeSpawnOptions,
  type SendMessageInput,
  type SpawnedAgentHandle,
  type SpawnPtyInput,
} from '@agent-relay/harness-driver';
import { RelayCast, RelayError, type AgentClient } from '@relaycast/sdk';

const BROKER_CONNECTION_FILENAME = 'connection.json';
const SHARED_BROKER_LOCK_DIRNAME = '.relayflows-start.lock';
const SHARED_BROKER_LEASE_DIRNAME = 'relayflows-runs';
const SHARED_BROKER_OWNER_FILENAME = 'relayflows-owner.json';
const SHARED_BROKER_LOCK_POLL_MS = 200;
const SHARED_BROKER_DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const BROKER_OPERATION_MAX_ATTEMPTS = 3;
const BROKER_OPERATION_RETRY_DELAY_MS = 1_000;

export type BrokerTransportMode = 'legacy' | 'shadow' | 'adapter';

export interface BrokerRunContext {
  runId: string;
  brokerName: string;
  channel: string;
  relaycastDisabled: boolean;
}

export interface BrokerTransportHooks {
  onEvent: (event: BrokerEvent) => void;
  onLog: (message: string) => void;
  getActiveAgentNames: () => string[];
}

/** Broker-owned lifecycle handle returned to the workflow runtime. */
export interface BrokerAgentHandle {
  readonly name: string;
  readonly runtime: SpawnedAgentHandle['runtime'];
  readonly exitCode: number | undefined;
  readonly exitSignal: string | undefined;
  waitForExit(timeoutMs?: number): ReturnType<SpawnedAgentHandle['waitForExit']>;
  waitForIdle(timeoutMs?: number): ReturnType<SpawnedAgentHandle['waitForIdle']>;
  release(reason?: string): Promise<{ name: string }>;
}

/**
 * Broker transport boundary used by WorkflowRunner.
 *
 * Implementations own broker connection/recovery, event subscription, worker
 * lifecycle operations, Relaycast messaging, and shared lock/lease files.
 */
export interface BrokerTransportPort {
  readonly mode: BrokerTransportMode;
  readonly apiKey: string | undefined;
  readonly apiKeyAutoCreated: boolean;
  readonly connected: boolean;
  ensureApiKey(channel: string): Promise<void>;
  start(context: BrokerRunContext, hooks: BrokerTransportHooks): Promise<void>;
  spawnPty(input: SpawnPtyInput, operation: string): Promise<BrokerAgentHandle>;
  listAgents(operation: string): Promise<ListAgent[]>;
  release(name: string, reason: string | undefined, operation: string): Promise<{ name: string }>;
  sendMessage(input: SendMessageInput, operation: string): Promise<{ event_id: string; targets: string[] }>;
  /** Returns `pty` when written to stdin and `message` for the compatibility fallback. */
  sendInput(name: string, text: string, operation: string): Promise<'pty' | 'message'>;
  createAndJoinChannel(channel: string, topic?: string): Promise<void>;
  startExternalAgentHeartbeat(name: string, persona?: string): Promise<(() => void) | undefined>;
  inviteAgent(channel: string, name: string): Promise<void>;
  postToChannel(channel: string, text: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface HarnessBrokerTransportOptions {
  mode?: BrokerTransportMode;
  cwd: string;
  relay?: RuntimeSpawnOptions;
  resolveRelayEnv?: () => NodeJS.ProcessEnv | undefined;
}

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

/** Resolve the rollout selector without changing the legacy default. */
export function resolveBrokerTransportMode(
  explicitMode?: BrokerTransportMode,
  env: NodeJS.ProcessEnv = process.env
): BrokerTransportMode {
  const candidate = explicitMode ?? env.RELAYFLOWS_INTEGRATION_TRANSPORT ?? 'legacy';
  if (candidate === 'legacy' || candidate === 'shadow' || candidate === 'adapter') {
    return candidate;
  }
  throw new Error(
    `Invalid broker transport mode "${candidate}". Expected legacy, shadow, or adapter.`
  );
}

class HarnessBrokerAgentHandle implements BrokerAgentHandle {
  constructor(private readonly inner: SpawnedAgentHandle) {}

  get name(): string {
    return this.inner.name;
  }

  get runtime(): SpawnedAgentHandle['runtime'] {
    return this.inner.runtime;
  }

  get exitCode(): number | undefined {
    return this.inner.exitCode;
  }

  get exitSignal(): string | undefined {
    return this.inner.exitSignal;
  }

  waitForExit(timeoutMs?: number): ReturnType<SpawnedAgentHandle['waitForExit']> {
    return this.inner.waitForExit(timeoutMs);
  }

  waitForIdle(timeoutMs?: number): ReturnType<SpawnedAgentHandle['waitForIdle']> {
    return this.inner.waitForIdle(timeoutMs);
  }

  release(reason?: string): Promise<{ name: string }> {
    return this.inner.release(reason);
  }
}

/** Legacy-compatible transport backed by the published harness-driver and Relaycast SDK. */
export class HarnessBrokerTransport implements BrokerTransportPort {
  readonly mode: BrokerTransportMode;
  private readonly cwd: string;
  private readonly relayOptions: RuntimeSpawnOptions;
  private readonly resolveRelayEnv: () => NodeJS.ProcessEnv | undefined;
  private relay?: HarnessDriverClient;
  private context?: BrokerRunContext;
  private hooks?: BrokerTransportHooks;
  private recoveryPromise?: Promise<void>;
  private relaycast?: RelayCast;
  private relaycastAgent?: AgentClient;
  private _apiKey?: string;
  private _apiKeyAutoCreated = false;
  /** @internal retained for focused lock/lease tests. */
  private sharedBrokerLease?: SharedBrokerLease;
  private listenerDisposers: Array<() => void> = [];

  constructor(options: HarnessBrokerTransportOptions) {
    this.mode = options.mode ?? 'legacy';
    this.cwd = options.cwd;
    this.relayOptions = options.relay ?? {};
    this.resolveRelayEnv = options.resolveRelayEnv ?? (() => undefined);
  }

  get apiKey(): string | undefined {
    return this._apiKey;
  }

  get apiKeyAutoCreated(): boolean {
    return this._apiKeyAutoCreated;
  }

  get connected(): boolean {
    return this.relay !== undefined;
  }

  async ensureApiKey(channel: string): Promise<void> {
    if (this._apiKey) return;

    const envKey = this.relayOptions.env?.RELAY_API_KEY ?? process.env.RELAY_API_KEY;
    if (envKey) {
      this._apiKey = envKey;
      return;
    }

    const workspaceName = `relay-${channel}-${randomBytes(4).toString('hex')}`;
    const baseUrl = this.getRelaycastBaseUrl();
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

    this._apiKey = apiKey;
    this._apiKeyAutoCreated = true;
    const dashboardPort = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';
    fetch(`http://127.0.0.1:${dashboardPort}/api/relay-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
      .then((response) => {
        if (!response.ok) {
          console.warn(`[WorkflowRunner] dashboard key push failed: HTTP ${response.status}`);
        }
      })
      .catch(() => {
        // Dashboard not running — silently ignore.
      });
  }

  async start(context: BrokerRunContext, hooks: BrokerTransportHooks): Promise<void> {
    this.context = context;
    this.hooks = hooks;
    this.relaycast = undefined;
    this.relaycastAgent = undefined;
    await this.startOrReuseSharedBroker(context);
    if (!this.relay) {
      throw new Error('Broker client was not initialized');
    }
    this.wireRelayClient();
  }

  async spawnPty(input: SpawnPtyInput, operation: string): Promise<BrokerAgentHandle> {
    const handle = await this.withBrokerRecovery(operation, (relay) => relay.spawnPty(input));
    return new HarnessBrokerAgentHandle(handle);
  }

  listAgents(operation: string): Promise<ListAgent[]> {
    return this.withBrokerRecovery(operation, (relay) => relay.listAgents());
  }

  release(name: string, reason: string | undefined, operation: string): Promise<{ name: string }> {
    return this.withBrokerRecovery(operation, (relay) => relay.release(name, reason));
  }

  sendMessage(
    input: SendMessageInput,
    operation: string
  ): Promise<{ event_id: string; targets: string[] }> {
    return this.withBrokerRecovery(operation, (relay) => relay.sendMessage(input));
  }

  async sendInput(name: string, text: string, operation: string): Promise<'pty' | 'message'> {
    const relay = this.relay;
    if (!relay) {
      throw new Error(`Broker unavailable while ${operation}`);
    }
    if (typeof relay.sendInput === 'function') {
      await relay.sendInput(name, `${text}\r`);
      return 'pty';
    }
    await this.sendMessage({ from: 'workflow-runner', to: name, text }, operation);
    return 'message';
  }

  async createAndJoinChannel(channel: string, topic?: string): Promise<void> {
    const agent = await this.ensureRelaycastRunnerAgent();
    try {
      await agent.channels.create({ name: channel, ...(topic ? { topic } : {}) });
    } catch (error) {
      if (!(error instanceof RelayError && error.code === 'name_conflict')) {
        throw error;
      }
    }
    await agent.channels.join(channel);
  }

  async startExternalAgentHeartbeat(
    name: string,
    persona?: string
  ): Promise<(() => void) | undefined> {
    const agent = await this.registerRelaycastExternalAgent(name, persona);
    if (!agent) return undefined;
    const beat = () => {
      agent.heartbeat().catch(() => {});
    };
    const timer = setInterval(beat, 30_000);
    timer.unref();
    beat();
    return () => clearInterval(timer);
  }

  async inviteAgent(channel: string, name: string): Promise<void> {
    const agent = await this.ensureRelaycastRunnerAgent();
    await agent.channels.invite(channel, name);
  }

  async postToChannel(channel: string, text: string): Promise<void> {
    const agent = await this.ensureRelaycastRunnerAgent();
    await agent.send(channel, text);
  }

  async shutdown(): Promise<void> {
    this.clearRelayListeners();
    const relay = this.relay;
    const lease = this.sharedBrokerLease;
    this.sharedBrokerLease = undefined;
    this.relay = undefined;
    this.recoveryPromise = undefined;

    if (!relay) {
      if (lease) safeUnlinkSync(lease.leasePath);
      this.resetRunState();
      return;
    }

    if (!lease) {
      await relay.shutdown();
      this.resetRunState();
      return;
    }

    safeUnlinkSync(lease.leasePath);
    const liveLeases = this.countLiveSharedBrokerLeases(lease.stateDir);
    if (liveLeases === 0 && (lease.startedBroker || this.isWorkflowOwnedSharedBroker(lease))) {
      await relay.shutdown();
      safeUnlinkSync(lease.connectionPath);
      safeUnlinkSync(lease.ownerPath);
    } else {
      const disconnect = (relay as { disconnect?: () => void }).disconnect;
      if (typeof disconnect === 'function') disconnect.call(relay);
    }
    this.resetRunState();
  }

  private resetRunState(): void {
    this.context = undefined;
    this.hooks = undefined;
    this.relaycast = undefined;
    this.relaycastAgent = undefined;
  }

  private wireRelayClient(): void {
    const relay = this.relay;
    const hooks = this.hooks;
    if (!relay || !hooks) return;
    this.clearRelayListeners();
    this.listenerDisposers.push(relay.onEvent(hooks.onEvent));
    const unsubBrokerExit = relay.onBrokerExit?.((info) => {
      if (this.relay?.brokerPid === info.pid) {
        this.relay = undefined;
      }
      hooks.onLog(
        `Broker exited (pid: ${info.pid ?? '?'}, code: ${info.code ?? '?'}, signal: ${info.signal ?? '?'})`
      );
    });
    if (unsubBrokerExit) this.listenerDisposers.push(unsubBrokerExit);
    relay.connectEvents();
  }

  private clearRelayListeners(): void {
    for (const dispose of this.listenerDisposers) {
      try {
        dispose();
      } catch {
        // Best-effort event cleanup.
      }
    }
    this.listenerDisposers = [];
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

  private async recoverBroker(reason: string): Promise<void> {
    const context = this.context;
    const hooks = this.hooks;
    if (!context || !hooks) {
      throw new Error(`Broker unavailable and no recovery context exists (${reason})`);
    }
    if (this.recoveryPromise) {
      await this.recoveryPromise;
      return;
    }
    const activeAgents = hooks.getActiveAgentNames();
    if (activeAgents.length > 0) {
      throw new Error(
        `Broker recovery is unsafe while ${activeAgents.length} agent${activeAgents.length === 1 ? ' is' : 's are'} still active: ${activeAgents.slice(0, 3).join(', ')}`
      );
    }

    this.recoveryPromise = (async () => {
      hooks.onLog(`Broker unavailable (${reason}); restarting...`);
      await this.shutdown().catch(() => undefined);
      await this.start(context, hooks);
      hooks.onLog('Broker restarted');
    })();
    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = undefined;
    }
  }

  private async withBrokerRecovery<T>(
    operation: string,
    work: (relay: HarnessDriverClient) => Promise<T>
  ): Promise<T> {
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
          if (!this.isRetryableProtocolError(error)) throw error;
        }
      }
      if (attempt >= BROKER_OPERATION_MAX_ATTEMPTS) break;
      await this.recoverBroker(`${operation} failed`);
      await sleepMs(BROKER_OPERATION_RETRY_DELAY_MS * attempt);
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Broker operation failed during ${operation}: ${message}`);
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
    if (!conn) return null;
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
        return () => rmSync(lockDir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      try {
        const stats = statSync(lockDir);
        if (Date.now() - stats.mtimeMs > staleAfterMs) {
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
      JSON.stringify({ pid: process.pid, runId, startedBroker, createdAt: new Date().toISOString() }),
      'utf-8'
    );
    return { stateDir, connectionPath, ownerPath, leasePath, startedBroker };
  }

  private writeSharedBrokerOwner(lease: SharedBrokerLease): void {
    const conn = readBrokerConnectionFile(lease.connectionPath);
    writeFileSync(
      lease.ownerPath,
      JSON.stringify({ pid: conn?.pid, createdByPid: process.pid, createdAt: new Date().toISOString() }),
      'utf-8'
    );
  }

  private isWorkflowOwnedSharedBroker(lease: SharedBrokerLease): boolean {
    const conn = readBrokerConnectionFile(lease.connectionPath);
    if (!conn) return false;
    try {
      const owner = JSON.parse(readFileSync(lease.ownerPath, 'utf-8')) as { pid?: unknown };
      return owner.pid === conn.pid;
    } catch {
      return false;
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

  private async startOrReuseSharedBroker(context: BrokerRunContext): Promise<void> {
    const brokerCwd = this.getBrokerCwd();
    const stateDir = this.getBrokerStateDir(brokerCwd);
    const connectionPath = path.join(stateDir, BROKER_CONNECTION_FILENAME);
    const startupTimeoutMs =
      this.relayOptions.startupTimeoutMs ?? SHARED_BROKER_DEFAULT_STARTUP_TIMEOUT_MS;
    const lease = this.createSharedBrokerLease(stateDir, connectionPath, context.runId, false);
    this.sharedBrokerLease = lease;

    const existing = await this.tryConnectSharedBroker(connectionPath, brokerCwd);
    if (existing) {
      this.hooks?.onLog('Reusing shared broker...');
      this.relay = existing;
      return;
    }

    const releaseLock = await this.acquireSharedBrokerStartLock(stateDir, startupTimeoutMs);
    try {
      const lockedExisting = await this.tryConnectSharedBroker(connectionPath, brokerCwd);
      if (lockedExisting) {
        this.hooks?.onLog('Reusing shared broker...');
        this.relay = lockedExisting;
        return;
      }

      this.hooks?.onLog('Starting broker...');
      // relayOptions.env is the caller-configured base (credentials, runtime
      // settings); resolveRelayEnv is the runner's richer per-run resolution
      // and wins where both define a key. Without the base merge, an embedder
      // passing relay.env but no resolveRelayEnv loses its environment.
      const relayEnv = {
        ...(this.relayOptions.env ?? {}),
        ...(this.resolveRelayEnv() ?? {}),
        AGENT_RELAY_STATE_DIR: stateDir,
      };
      this.relay = await HarnessDriverClient.spawn({
        ...this.relayOptions,
        cwd: brokerCwd,
        brokerName: context.brokerName,
        channels: context.relaycastDisabled ? [] : [context.channel],
        binaryArgs: { ...(this.relayOptions.binaryArgs ?? {}), persist: true, stateDir },
        env: relayEnv,
        requestTimeoutMs: this.relayOptions.requestTimeoutMs ?? 120_000,
        onStderr: (line: string) => {
          const trimmed = line.trim();
          if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) return;
          console.log(`${chalk.dim.yellow('[broker]')} ${line}`);
        },
      });
      lease.startedBroker = true;
      this.writeSharedBrokerOwner(lease);
    } finally {
      releaseLock();
    }
  }

  private getRelaycastBaseUrl(): string {
    return (
      this.relayOptions.env?.RELAYCAST_BASE_URL ??
      process.env.RELAYCAST_BASE_URL ??
      'https://api.relaycast.dev'
    );
  }

  private getRelaycastClient(): RelayCast {
    if (!this._apiKey) throw new Error('No Relaycast API key available');
    if (!this.relaycast) {
      this.relaycast = new RelayCast({ apiKey: this._apiKey, baseUrl: this.getRelaycastBaseUrl() });
    }
    return this.relaycast;
  }

  private async ensureRelaycastRunnerAgent(): Promise<AgentClient> {
    if (this.relaycastAgent) return this.relaycastAgent;
    const rc = this.getRelaycastClient();
    let registration;
    try {
      registration = await rc.agents.register({ name: 'WorkflowRunner', type: 'agent' });
    } catch (error) {
      if (error instanceof RelayError && error.code === 'name_conflict') {
        registration = await rc.agents.register({
          name: `WorkflowRunner-${randomBytes(4).toString('hex')}`,
          type: 'agent',
        });
      } else {
        throw error;
      }
    }
    this.relaycastAgent = rc.as(registration.token);
    return this.relaycastAgent;
  }

  private async registerRelaycastExternalAgent(
    name: string,
    persona?: string
  ): Promise<AgentClient | null> {
    const rc = this.getRelaycastClient();
    try {
      const registration = await rc.agents.register({
        name,
        type: 'agent',
        ...(persona ? { persona } : {}),
      });
      return rc.as(registration.token);
    } catch (error) {
      if (error instanceof RelayError && error.code === 'name_conflict') return null;
      throw error;
    }
  }
}
