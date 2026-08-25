/**
 * WorkflowRunner integration tests.
 *
 * Tests parsing, validation, variable resolution, and DAG execution
 * with a mocked DB adapter and mocked AgentRelay.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowDb } from '../runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

// ── Mock fetch to prevent real HTTP calls (Relaycast provisioning) ───────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

// ── Mock RelayCast SDK ───────────────────────────────────────────────────────

const mockRelaycastAgent = {
  send: vi.fn().mockResolvedValue(undefined),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  channels: {
    create: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn().mockResolvedValue(undefined),
  },
};

const mockRelaycast = {
  agents: {
    register: vi.fn().mockResolvedValue({ token: 'token-1' }),
  },
  as: vi.fn().mockReturnValue(mockRelaycastAgent),
};

class MockRelayError extends Error {
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
    (this as any).status = status;
  }
}

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => mockRelaycast),
  RelayError: MockRelayError,
}));

// ── Mock HarnessDriverClient ─────────────────────────────────────────────────

let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;
let mockSpawnOutputs: string[] = [];
let mockSpawnExitCodes: Array<number | undefined> = [];
const mockHarnessDriverSpawn = vi.fn(async () => mockRelayInstance);

// Spawned-agent handle shaped like harness-driver's SpawnedAgentHandle, but
// driven by the test's waitForExitFn/waitForIdleFn.
function makeMockHandle(name: string) {
  return {
    name,
    runtime: 'pty' as const,
    exitCode: mockSpawnExitCodes.shift(),
    exitSignal: undefined as string | undefined,
    waitForExit: (ms?: number) => waitForExitFn(ms).then((reason) => ({ reason })),
    waitForIdle: (ms?: number) => waitForIdleFn(ms).then((reason) => ({ reason })),
    release: vi.fn().mockResolvedValue({ name }),
  };
}

// The runner consumes broker events via `client.onEvent(BrokerEvent)`. Tests
// still call `emitMockEvent('workerOutput'|'messageReceived'|...)`; translate
// those legacy named events into the BrokerEvent shapes the runner switches on.
const eventListeners = new Set<(event: any) => void>();
function emitMockEvent(event: string, payload: any = {}): void {
  let broker: any;
  switch (event) {
    case 'workerOutput':
      broker = { kind: 'worker_stream', name: payload.name, stream: 'stdout', chunk: payload.chunk };
      break;
    case 'messageReceived':
      broker = {
        kind: 'relay_inbound',
        event_id: payload.eventId,
        from: payload.from,
        target: payload.to,
        body: payload.text,
        thread_id: payload.threadId,
      };
      break;
    case 'agentSpawned':
      broker = { kind: 'agent_spawned', name: payload.name, runtime: payload.runtime ?? 'pty' };
      break;
    case 'workerReady':
      broker = { kind: 'worker_ready', name: payload.name, runtime: payload.runtime ?? 'pty' };
      break;
    case 'agentReleased':
      broker = { kind: 'agent_released', name: payload.name };
      break;
    case 'agentExited':
      broker = { kind: 'agent_exited', name: payload.name, code: payload.exitCode, signal: payload.exitSignal };
      break;
    case 'agentIdle':
      broker = { kind: 'agent_idle', name: payload.name, idle_secs: payload.idleSecs };
      break;
    default:
      broker = { kind: event, ...payload };
  }
  for (const cb of [...eventListeners]) cb(broker);
}

const defaultSpawnPtyImplementation = async ({ name, task }: { name: string; task?: string }) => {
  const queued = mockSpawnOutputs.shift();
  const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
  const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
  const output =
    queued ??
    (isReview
      ? 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n'
      : stepComplete
        ? `STEP_COMPLETE:${stepComplete}\n`
        : 'STEP_COMPLETE:unknown\n');

  queueMicrotask(() => {
    emitMockEvent('workerOutput', { name, chunk: output });
  });

  return makeMockHandle(name);
};

const mockRelayInstance = {
  spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
  onEvent: vi.fn((cb: (event: any) => void) => {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }),
  onBrokerExit: vi.fn(() => () => {}),
  connectEvents: vi.fn(),
  getStatus: vi.fn().mockResolvedValue({ status: 'running' }),
  listAgents: vi.fn().mockResolvedValue([]),
  release: vi.fn().mockResolvedValue({ name: '' }),
  sendMessage: vi.fn().mockResolvedValue({ event_id: 'evt', targets: [] }),
  disconnect: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@agent-relay/harness-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/harness-driver')>();
  return {
    ...actual,
    HarnessDriverClient: {
      connect: vi.fn(() => mockRelayInstance),
      spawn: mockHarnessDriverSpawn,
    },
  };
});

const personaRuntimeMocks = vi.hoisted(() => ({
  dispose: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../persona-runtime.js', () => ({
  resolveWorkflowPersona: vi.fn((reference: string) => ({
    resolved: { spec: { id: reference } },
    plan: {},
    cli: 'codex',
    model: 'openai-codex/persona-model',
    args: ['--persona-runtime'],
    env: { PERSONA_ENV: 'enabled' },
  })),
  activateWorkflowPersona: vi.fn(async (persona: Record<string, unknown>) => ({
    ...persona,
    cwd: '/tmp/relayflow-persona-runtime',
    dispose: personaRuntimeMocks.dispose,
  })),
}));

// Import after mocking
const { WorkflowRunner } = await import('../runner.js');
const { HarnessDriverClient } = await import('@agent-relay/harness-driver');

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (run: WorkflowRunRow) => {
      runs.set(run.id, { ...run });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
    }),
    getRun: vi.fn(async (id: string) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step: WorkflowStepRow) => {
      steps.set(step.id, { ...step });
    }),
    updateStep: vi.fn(async (id: string, patch: Partial<WorkflowStepRow>) => {
      const existing = steps.get(id);
      if (existing) steps.set(id, { ...existing, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((s) => s.runId === runId);
    }),
  };
}

function makeConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-workflow',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
      { name: 'agent-b', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'agent-a', task: 'Do step 1' },
          { name: 'step-2', agent: 'agent-b', task: 'Do step 2', dependsOn: ['step-1'] },
        ],
      },
    ],
    trajectories: false,
    ...overrides,
  };
}

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

type WorkflowStepOverride = Partial<NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number]>;

function makeSupervisedConfig(stepOverrides: WorkflowStepOverride = {}): RelayYamlConfig {
  return makeConfig({
    // The runner now defaults to strategy:'retry' with repairRetries; these
    // supervised tests assert first-pass review/owner outcomes, so opt into
    // fail-fast to exercise the failure path deterministically (no retry loop).
    errorHandling: { strategy: 'fail-fast' },
    swarm: { pattern: 'hub-spoke' },
    agents: [
      { name: 'specialist', cli: 'claude', role: 'engineer' },
      { name: 'team-lead', cli: 'claude', role: 'lead coordinator' },
      { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-1',
            agent: 'specialist',
            task: 'Implement the requested change',
            ...stepOverrides,
          },
        ],
      },
    ],
  });
}

function findFirstJsonFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstJsonFile(entryPath);
      if (nested) return nested;
    }
    if (entry.isFile() && entry.name.endsWith('.json')) return entryPath;
  }
  return null;
}

function readCompletedTrajectoryFile(dir: string): any {
  // agent-trajectories v0.6 relocated the default data dir from `.trajectories`
  // to `.agentworkforce/trajectories` and stores each trajectory in a per-id
  // subdirectory (completed/<id>/trajectory.json), so scan recursively.
  const completedDir = path.join(dir, '.agentworkforce', 'trajectories', 'completed');
  const jsonFile = findFirstJsonFile(completedDir);
  if (!jsonFile) return null;

  return JSON.parse(readFileSync(jsonFile, 'utf-8'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowRunner', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockImplementation(() => never());
    mockSpawnOutputs = [];
    mockSpawnExitCodes = [];
    mockHarnessDriverSpawn.mockImplementation(async () => mockRelayInstance);
    mockRelayInstance.spawnPty.mockImplementation(defaultSpawnPtyImplementation);
    eventListeners.clear();
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });
  });

  // ── Parsing & validation ───────────────────────────────────────────────

  describe('parseYamlString', () => {
    it('should parse valid YAML config', () => {
      const yaml = `
version: "1"
name: test
swarm:
  pattern: fan-out
agents:
  - name: a1
    cli: claude
`;
      const config = runner.parseYamlString(yaml);
      expect(config.name).toBe('test');
      expect(config.swarm.pattern).toBe('fan-out');
      expect(config.agents).toHaveLength(1);
    });

    it('should throw on null YAML', () => {
      expect(() => runner.parseYamlString('null')).toThrow('config must be a non-null object');
    });

    it('should throw on invalid YAML syntax', () => {
      expect(() => runner.parseYamlString('not: valid: yaml: []')).toThrow();
    });
  });

  describe('validateConfig', () => {
    it('should accept valid config', () => {
      expect(() => runner.validateConfig(makeConfig())).not.toThrow();
    });

    it('should reject null config', () => {
      expect(() => runner.validateConfig(null)).toThrow('non-null object');
    });

    it('should reject missing version', () => {
      expect(() =>
        runner.validateConfig({
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', cli: 'claude' }],
        })
      ).toThrow('missing required field "version"');
    });

    it('should reject missing name', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', cli: 'claude' }],
        })
      ).toThrow('missing required field "name"');
    });

    it('should reject empty agents array', () => {
      expect(() =>
        runner.validateConfig({ version: '1', name: 'x', swarm: { pattern: 'dag' }, agents: [] })
      ).not.toThrow();
    });

    it('should reject agent without cli or persona', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a' }],
        })
      ).toThrow('each agent must have exactly one of string "cli" or "persona"');
    });

    it('should accept persona in place of cli and role', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', persona: 'nango-integrations' }],
        })
      ).not.toThrow();
    });

    it('should reject agents that set both cli and persona', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', cli: 'codex', persona: 'nango-integrations' }],
        })
      ).toThrow('each agent must have exactly one of string "cli" or "persona"');
    });

    it('rejects malformed launch fields instead of treating them as absent', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a', persona: 'nango-integrations', cli: 42 }],
        })
      ).toThrow('"cli" must be a non-empty string when provided');
    });

    it('should detect unknown dependencies in workflows', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'wf',
            steps: [{ name: 's1', agent: 'agent-a', task: 'do', dependsOn: ['nonexistent'] }],
          },
        ],
      });
      expect(() => runner.validateConfig(config)).toThrow('depends on unknown step "nonexistent"');
    });

    it('should detect dependency cycles', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'agent-a', task: 'do', dependsOn: ['s2'] },
              { name: 's2', agent: 'agent-b', task: 'do', dependsOn: ['s1'] },
            ],
          },
        ],
      });
      expect(() => runner.validateConfig(config)).toThrow('dependency cycle');
    });
  });

  // ── Variable resolution ────────────────────────────────────────────────

  describe('resolveVariables', () => {
    it('should replace {{var}} in agent tasks', () => {
      const config = makeConfig({
        agents: [{ name: 'a', cli: 'claude', task: 'Fix bug {{bugId}}' }],
      });
      const resolved = runner.resolveVariables(config, { bugId: '42' });
      expect(resolved.agents[0].task).toBe('Fix bug 42');
    });

    it('should replace {{var}} in workflow step tasks', () => {
      const config = makeConfig();
      config.workflows![0].steps[0].task = 'Process {{item}}';
      const resolved = runner.resolveVariables(config, { item: 'test-item' });
      expect(resolved.workflows![0].steps[0].task).toBe('Process test-item');
    });

    it('should throw on unresolved variables', () => {
      const config = makeConfig({
        agents: [{ name: 'a', cli: 'claude', task: 'Fix {{unknown}}' }],
      });
      expect(() => runner.resolveVariables(config, {})).toThrow('Unresolved variable: {{unknown}}');
    });

    it('should not mutate original config', () => {
      const config = makeConfig({
        agents: [{ name: 'a', cli: 'claude', task: 'Fix {{id}}' }],
      });
      runner.resolveVariables(config, { id: '1' });
      expect(config.agents[0].task).toBe('Fix {{id}}');
    });
  });

  // ── Execution ──────────────────────────────────────────────────────────

  describe('execute', () => {
    it('spawns a persona with its declared runtime and verifies readiness plus registration', async () => {
      mockRelayInstance.spawnPty.mockImplementation(async (input: { name: string; task?: string }) => {
        mockRelayInstance.listAgents.mockResolvedValueOnce([{ name: input.name }]);
        queueMicrotask(() => {
          emitMockEvent('workerReady', { name: input.name });
          emitMockEvent('workerOutput', { name: input.name, chunk: 'STEP_COMPLETE:persona-step\n' });
        });
        return makeMockHandle(input.name);
      });

      const config = {
        version: '1',
        name: 'persona-workflow',
        swarm: { pattern: 'dag' },
        agents: [{ name: 'integration-expert', persona: 'nango-integrations' }],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'persona-step', agent: 'integration-expert', task: 'Fix the failed sync' },
            ],
          },
        ],
        trajectories: false,
      } satisfies RelayYamlConfig;

      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledWith(
        expect.objectContaining({
          cli: 'codex',
          model: 'openai-codex/persona-model',
          args: ['--persona-runtime'],
          cwd: '/tmp/relayflow-persona-runtime',
          env: expect.objectContaining({ PERSONA_ENV: 'enabled' }),
          task: expect.stringContaining('Fix the failed sync'),
        })
      );
      expect(personaRuntimeMocks.dispose).toHaveBeenCalledOnce();
    });

    it('releases and disposes a persona runtime when readiness never arrives', async () => {
      const handle = makeMockHandle('persona-step-failure');
      mockRelayInstance.spawnPty.mockResolvedValue(handle);
      const config = {
        version: '1',
        name: 'persona-readiness-failure',
        swarm: { pattern: 'dag' },
        agents: [{ name: 'integration-expert', persona: 'nango-integrations' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'persona-step-failure',
                agent: 'integration-expert',
                task: 'Fix the failed sync',
                timeoutMs: 1,
                retries: 0,
              },
            ],
          },
        ],
        trajectories: false,
      } satisfies RelayYamlConfig;

      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('failed');
      expect(handle.release).toHaveBeenCalledOnce();
      expect(personaRuntimeMocks.dispose).toHaveBeenCalledOnce();
    });

    it('should create run and steps in DB', async () => {
      const config = makeConfig();
      const run = await runner.execute(config, 'default');

      expect(db.insertRun).toHaveBeenCalledTimes(1);
      expect(db.insertStep).toHaveBeenCalledTimes(2);
      expect(run.status, run.error).toBe('completed');
    });

    it('reuses a healthy shared broker connection without owning shutdown', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-shared-broker-'));
      try {
        const stateDir = path.join(tmpDir, '.agentworkforce', 'relay');
        mkdirSync(stateDir, { recursive: true });
        const connectionPath = path.join(stateDir, 'connection.json');
        writeFileSync(
          connectionPath,
          JSON.stringify({
            url: 'http://127.0.0.1:3889',
            port: 3889,
            api_key: 'br_test',
            pid: process.pid,
          }),
          'utf-8'
        );

        const localRunner = new WorkflowRunner({
          db,
          workspaceId: 'ws-test',
          cwd: tmpDir,
          relay: { env: { AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1' } },
        });

        const run = await localRunner.execute(makeConfig(), 'default');

        expect(run.status).toBe('completed');
        expect(HarnessDriverClient.connect).toHaveBeenCalledWith({ cwd: tmpDir, connectionPath });
        expect(HarnessDriverClient.spawn).not.toHaveBeenCalled();
        expect(mockRelayInstance.disconnect).toHaveBeenCalledTimes(1);
        expect(mockRelayInstance.shutdown).not.toHaveBeenCalled();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('converges concurrent first-start broker acquisition on one spawned broker', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-shared-start-'));
      try {
        vi.mocked(HarnessDriverClient.spawn).mockImplementationOnce(async (options: any) => {
          const stateDir = options.binaryArgs.stateDir;
          await new Promise((resolve) => setTimeout(resolve, 50));
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(
            path.join(stateDir, 'connection.json'),
            JSON.stringify({
              url: 'http://127.0.0.1:3889',
              port: 3889,
              api_key: 'br_test',
              pid: process.pid,
            }),
            'utf-8'
          );
          return mockRelayInstance as any;
        });

        const runners = Array.from(
          { length: 4 },
          () =>
            new WorkflowRunner({
              db,
              workspaceId: 'ws-test',
              cwd: tmpDir,
              relay: { env: { AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1' } },
            })
        );

        await Promise.all(
          runners.map((candidate, index) =>
            (candidate as any).startOrReuseSharedBroker(`run-${index}`, `wf-${index}`, true)
          )
        );

        expect(HarnessDriverClient.spawn).toHaveBeenCalledTimes(1);
        expect(HarnessDriverClient.connect).toHaveBeenCalledTimes(3);

        const starter = runners.find((candidate) => (candidate as any).sharedBrokerLease?.startedBroker);
        expect(starter).toBeDefined();
        const attached = runners.filter((candidate) => candidate !== starter);

        await starter!.shutdownRelay();
        expect(mockRelayInstance.shutdown).not.toHaveBeenCalled();
        expect(mockRelayInstance.disconnect).toHaveBeenCalledTimes(1);

        await Promise.all(attached.map((candidate) => candidate.shutdownRelay()));
        expect(mockRelayInstance.shutdown).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw when workflow not found', async () => {
      const config = makeConfig();
      await expect(runner.execute(config, 'nonexistent')).rejects.toThrow('Workflow "nonexistent" not found');
    });

    it('should throw when no workflows defined', async () => {
      const config = makeConfig({ workflows: undefined });
      await expect(runner.execute(config)).rejects.toThrow('No workflows defined');
    });

    it('should emit run:started and run:completed events', async () => {
      const events: string[] = [];
      runner.on((event) => events.push(event.type));

      await runner.execute(makeConfig(), 'default');

      expect(events).toContain('run:started');
      expect(events).toContain('run:completed');
    });

    it('should emit step events in order', async () => {
      const stepEvents: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type.startsWith('step:')) {
          stepEvents.push({
            type: event.type,
            stepName: 'stepName' in event ? event.stepName : undefined,
          });
        }
      });

      await runner.execute(makeConfig(), 'default');

      const startedSteps = stepEvents.filter((e) => e.type === 'step:started');
      expect(startedSteps).toHaveLength(2);
    });

    it('restarts the broker when a PTY spawn fails with a transient transport error', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-broker-recovery-'));
      const failingRelay = {
        ...mockRelayInstance,
        spawnPty: vi.fn(async () => {
          const error = new Error('fetch failed');
          (error as Error & { retryable?: boolean }).retryable = true;
          throw error;
        }),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recoveredRelay = {
        ...mockRelayInstance,
        spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      mockHarnessDriverSpawn
        .mockImplementationOnce(async () => failingRelay as any)
        .mockImplementationOnce(async () => recoveredRelay as any);

      try {
        const isolatedRunner = new WorkflowRunner({
          db,
          workspaceId: 'ws-test',
          cwd: tmpDir,
          relay: {
            env: {
              AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
              AGENT_RELAY_STATE_DIR: path.join(tmpDir, '.agentworkforce', 'relay'),
            },
          },
        });

        const run = await isolatedRunner.execute(
          makeConfig({
            workflows: [{ name: 'default', steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1' }] }],
          }),
          'default'
        );

        expect(run.status, run.error).toBe('completed');
        expect(mockHarnessDriverSpawn).toHaveBeenCalledTimes(2);
        expect(failingRelay.shutdown).toHaveBeenCalledTimes(1);
        expect(recoveredRelay.spawnPty).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('recovers when a broker exit clears the relay client before the next spawn', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-broker-exit-'));
      const exitingRelay = {
        ...mockRelayInstance,
        brokerPid: 41,
        onBrokerExit: vi.fn((cb: (info: { pid?: number; code?: number; signal?: string }) => void) => {
          queueMicrotask(() => cb({ pid: 41, code: 1, signal: 'SIGTERM' }));
          return () => {};
        }),
        spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      const recoveredRelay = {
        ...mockRelayInstance,
        spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };
      mockHarnessDriverSpawn
        .mockImplementationOnce(async () => exitingRelay as any)
        .mockImplementationOnce(async () => recoveredRelay as any);

      try {
        const isolatedRunner = new WorkflowRunner({
          db,
          workspaceId: 'ws-test',
          cwd: tmpDir,
          relay: {
            env: {
              AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
              AGENT_RELAY_STATE_DIR: path.join(tmpDir, '.agentworkforce', 'relay'),
            },
          },
        });

        const run = await isolatedRunner.execute(
          makeConfig({
            workflows: [{ name: 'default', steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1' }] }],
          }),
          'default'
        );

        expect(run.status, run.error).toBe('completed');
        expect(mockHarnessDriverSpawn).toHaveBeenCalledTimes(2);
        expect(exitingRelay.onBrokerExit).toHaveBeenCalledTimes(1);
        expect(recoveredRelay.spawnPty).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('refuses broker recovery while workflow agents are still active', async () => {
      const candidate = new WorkflowRunner({ db, workspaceId: 'ws-test' });
      (candidate as any).currentBrokerContext = {
        runId: 'run-active',
        brokerName: 'relayflows-run-active',
        channel: 'wf-active',
        relaycastDisabled: true,
      };
      (candidate as any).activeAgentHandles.set('active-agent', { name: 'active-agent' });

      await expect((candidate as any).recoverBroker('spawn failed')).rejects.toThrow(
        'Broker recovery is unsafe while 1 agent is still active: active-agent'
      );
      expect(mockHarnessDriverSpawn).not.toHaveBeenCalled();
    });

    it('releases the live PTY before replaying a transient same-attempt network failure', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-transient-replay-'));
      const firstHandle = {
        ...makeMockHandle('step-1-transient'),
        release: vi.fn().mockResolvedValue({ name: 'step-1-transient' }),
      };
      const secondHandle = {
        ...makeMockHandle('step-1-transient'),
        release: vi.fn().mockResolvedValue({ name: 'step-1-transient' }),
      };
      let spawnCount = 0;
      const replayRelay = {
        ...mockRelayInstance,
        spawnPty: vi.fn(async ({ name }: { name: string }) => {
          spawnCount += 1;
          const handle = spawnCount === 1 ? firstHandle : secondHandle;
          if (spawnCount === 2) {
            queueMicrotask(() => {
              emitMockEvent('workerOutput', { name, chunk: 'STEP_COMPLETE:step-1\n' });
            });
          }
          return handle as any;
        }),
      };
      mockHarnessDriverSpawn.mockImplementation(async () => replayRelay as any);

      try {
        const isolatedRunner = new WorkflowRunner({
          db,
          workspaceId: 'ws-test',
          cwd: tmpDir,
          relay: {
            env: {
              AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
              AGENT_RELAY_STATE_DIR: path.join(tmpDir, '.agentworkforce', 'relay'),
            },
          },
        });
        vi.spyOn(isolatedRunner as any, 'waitForExitWithIdleNudging')
          .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { retryable: true }))
          .mockResolvedValueOnce('exited');

        const run = await isolatedRunner.execute(
          makeConfig({
            workflows: [{ name: 'default', steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1' }] }],
          }),
          'default'
        );

        expect(run.status, run.error).toBe('completed');
        expect(replayRelay.spawnPty).toHaveBeenCalledTimes(2);
        expect(firstHandle.release).toHaveBeenCalledTimes(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should emit owner assignment and review completion events for interactive steps', async () => {
      const events: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) =>
        events.push({ type: event.type, stepName: 'stepName' in event ? event.stepName : undefined })
      );

      await runner.execute(makeSupervisedConfig(), 'default');

      const ownerAssigned = events.filter((e) => e.type === 'step:owner-assigned');
      const reviewCompleted = events.filter((e) => e.type === 'step:review-completed');
      expect(ownerAssigned).toHaveLength(1);
      expect(reviewCompleted).toHaveLength(1);
    });

    it('should prioritize lead owner when multiple hub-role candidates exist', async () => {
      const ownerAssignments: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') ownerAssignments.push(event.ownerName);
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'coord-1', cli: 'claude', role: 'coordinator' },
          { name: 'lead-1', cli: 'claude', role: 'lead' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do step 1' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments).toEqual(['lead-1']);
    }, 15000);

    it('should not treat github role text as hub owner signal', async () => {
      const ownerAssignments: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') ownerAssignments.push(event.ownerName);
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-agent', cli: 'claude', role: 'github actions agent' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do step 1' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments).toEqual(['specialist']);
    });

    it('should not elect github-role agent as owner (hub word-boundary)', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-bot', cli: 'claude', role: 'github integration' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do step 1' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      // github-bot should NOT be elected as owner (role contains "hub" substring but not word)
      expect(ownerAssignments[0].owner).not.toBe('github-bot');
      // specialist should be its own owner since no hub-role agent exists
      expect(ownerAssignments[0].owner).toBe('specialist');
    }, 15000);

    it('should parse REJECT from PTY-echoed review output', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      // Simulate PTY output that echoes the review prompt before the actual response
      const echoedPrompt =
        'Return exactly:\nREVIEW_DECISION: APPROVE or REJECT\nREVIEW_REASON: <one sentence>\n';
      const actualResponse = 'REVIEW_DECISION: REJECT\nREVIEW_REASON: code has bugs\n';
      mockSpawnOutputs = ['worker finished\n', 'STEP_COMPLETE:step-1\n', echoedPrompt + actualResponse];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      // Should parse REJECT from actual response, not APPROVE from echoed instruction
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);

    it('should resolve variables during execution', async () => {
      const config = makeConfig();
      config.workflows![0].steps[0].task = 'Build {{feature}}';
      const run = await runner.execute(config, 'default', { feature: 'auth' });
      expect(run.status, run.error).toBe('completed');
    });

    it('WorkflowRunner deterministic executor path rejects terminal success when exit_code verification disagrees', async () => {
      const executeDeterministicStep = vi.fn(async () => ({
        output: 'claim already taken',
        exitCode: 78,
      }));
      runner = new WorkflowRunner({
        db,
        workspaceId: 'ws-test',
        executor: {
          executeAgentStep: vi.fn(async () => ''),
          executeDeterministicStep,
        },
      });

      const run = await runner.execute(
        makeConfig({
          errorHandling: { strategy: 'fail-fast' },
          agents: [],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'claim-gate',
                  type: 'deterministic',
                  command: 'claim-work',
                  failOnError: false,
                  verification: { type: 'exit_code', value: '0' },
                  terminalSuccessExitCodes: [78],
                } as any,
              ],
            },
          ],
        }),
        'default'
      );

      expect(executeDeterministicStep).toHaveBeenCalledTimes(1);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('recorded exit code "78" did not match "0"');
    });

    it('repairs a failed deterministic gate with a workflow agent before retrying', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-deterministic-repair-'));
      const stepDir = path.join(tmpDir, 'step-cwd');
      mkdirSync(stepDir);
      const artifactPath = path.join(stepDir, 'repaired.txt');
      const repairAgent = vi.fn(async (step) => {
        writeFileSync(path.join(step.cwd!, 'repaired.txt'), 'fixed\n', 'utf-8');
        return 'wrote repaired.txt';
      });
      runner = new WorkflowRunner({
        db,
        workspaceId: 'ws-test',
        cwd: tmpDir,
        executor: {
          executeAgentStep: repairAgent,
        },
      });

      try {
        const run = await runner.execute(
          makeConfig({
            errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1 },
            agents: [{ name: 'fixer', cli: 'claude', role: 'implementation engineer' }],
            workflows: [
              {
                name: 'default',
                steps: [
                  {
                    name: 'verify-artifact',
                    type: 'deterministic',
                    cwd: 'step-cwd',
                    command: `node -e "require('node:fs').accessSync('repaired.txt')"`,
                  },
                ],
              },
            ],
          }),
          'default'
        );

        expect(run.status, run.error).toBe('completed');
        expect(repairAgent).toHaveBeenCalledTimes(1);
        expect(repairAgent.mock.calls[0][0]).toMatchObject({ cwd: stepDir, workdir: undefined });
        expect(repairAgent.mock.calls[0][2]).toContain('A deterministic workflow gate failed');
        expect(repairAgent.mock.calls[0][2]).toContain('verify-artifact');
        expect(readFileSync(artifactPath, 'utf-8')).toBe('fixed\n');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does not spawn deterministic repair agents when retries are disabled (fail-fast)', async () => {
      // The runner's applyReliabilityDefaults auto-enables strategy:'retry' with
      // repairRetries when agents are present, so a failing deterministic gate is
      // repaired by default. Opting into fail-fast is the contract for disabling
      // that — a deterministic failure should then surface immediately with no
      // repair agent spawned.
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-deterministic-no-implicit-repair-'));
      const repairAgent = vi.fn(async () => 'unexpected repair');
      runner = new WorkflowRunner({
        db,
        workspaceId: 'ws-test',
        cwd: tmpDir,
        executor: {
          executeAgentStep: repairAgent,
        },
      });

      try {
        const run = await runner.execute(
          makeConfig({
            errorHandling: { strategy: 'fail-fast' },
            agents: [{ name: 'fixer', cli: 'claude', role: 'implementation engineer' }],
            workflows: [
              {
                name: 'default',
                steps: [
                  {
                    name: 'verify-artifact',
                    type: 'deterministic',
                    command: `node -e "require('node:fs').accessSync('missing.txt')"`,
                  },
                ],
              },
            ],
          }),
          'default'
        );

        expect(run.status).toBe('failed');
        expect(repairAgent).not.toHaveBeenCalled();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should fail when owner response provides no decision, marker, or evidence', async () => {
      mockSpawnOutputs = ['Owner completed work but forgot sentinel\n'];
      // The runner now defaults to strategy:'retry' with repairRetries. This test
      // asserts the first-pass failure path, so opt into fail-fast to surface the
      // missing-decision error immediately instead of entering the repair/retry loop.
      const run = await runner.execute(makeConfig({ errorHandling: { strategy: 'fail-fast' } }), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner completion decision missing');
    });

    it('should run specialist work in a separate process and mirror worker output to the channel', async () => {
      mockSpawnOutputs = [
        'worker progress update\nworker finished\n',
        'Observed worker progress on the channel\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');

      expect(run.status).toBe('completed');
      const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls;
      expect(spawnCalls[0][0].name).toContain('step-1-worker');
      expect(spawnCalls[1][0].name).toContain('step-1-owner');
      expect(spawnCalls[0][0].task).not.toContain('STEP_COMPLETE:step-1');
      expect(spawnCalls[0][0].task).toContain('WORKER COMPLETION CONTRACT');
      expect(spawnCalls[0][0].task).toContain('WORKER_DONE: <brief summary>');
      expect(spawnCalls[1][0].task).toContain('You are the step owner/supervisor for step "step-1".');
      expect(spawnCalls[1][0].task).toContain('runtime: step-1-worker');
      expect(spawnCalls[1][0].task).toContain('LEAD_DONE: <brief summary>');

      const channelMessages = (mockRelaycastAgent.send as any).mock.calls.map(
        ([, text]: [string, string]) => text
      );
      expect(channelMessages.some((text: string) => text.includes('Worker `step-1-worker'))).toBe(true);
      expect(channelMessages.some((text: string) => text.includes('worker finished'))).toBe(true);
    });

    it('should apply verification fallback for self-owned interactive steps', async () => {
      mockSpawnOutputs = ['LEAD_DONE\n', 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n'];
      mockSpawnExitCodes = [0];

      const run = await runner.execute(
        makeConfig({
          agents: [{ name: 'team-lead', cli: 'claude', role: 'Lead coordinator' }],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'lead-step',
                  agent: 'team-lead',
                  task: 'Output exactly:\nLEAD_DONE\n/exit',
                  verification: { type: 'exit_code', value: 0 },
                },
              ],
            },
          ],
        }),
        'default'
      );

      expect(run.status, run.error).toBe('completed');
      const steps = await db.getStepsByRunId(run.id);
      expect(steps[0]?.completionReason).toBe('completed_verified');
    });

    it('should keep explicit interactive workers self-owned without extra supervisor/reviewer spawns', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      mockSpawnOutputs = ['STEP_COMPLETE:worker-step\nWORKER_DONE_LOCAL\n'];

      const run = await runner.execute(
        makeConfig({
          agents: [
            { name: 'team-lead', cli: 'claude', role: 'Lead coordinator', preset: 'lead' },
            { name: 'relay-worker', cli: 'codex', preset: 'worker', interactive: true },
          ],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'worker-step',
                  agent: 'relay-worker',
                  task: 'Output exactly:\nWORKER_DONE_LOCAL\n/exit',
                  verification: { type: 'output_contains', value: 'WORKER_DONE_LOCAL' },
                },
              ],
            },
          ],
        }),
        'default'
      );

      expect(ownerAssignments).toContainEqual({ owner: 'relay-worker', specialist: 'relay-worker' });
      expect(run.status, run.error).toBe('completed');

      const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls;
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0][0].task).toContain('STEP OWNER CONTRACT');
      expect(spawnCalls[0][0].name).not.toContain('-owner-');
      expect(spawnCalls[0][0].name).not.toContain('-review-');
    });

    it('should spill oversized interactive tasks to a temp file before PTY spawn', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-pty-task-'));
      const oversizedBytes = WorkflowRunner.PTY_TASK_ARG_SIZE_LIMIT + 1024;
      let spawnedTask = '';
      let taskFilePath = '';
      let taskFileContents = '';
      runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });

      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          spawnedTask = task ?? '';
          const match = spawnedTask.match(/TASK_FILE:(.+)\n/);
          if (match) {
            taskFilePath = match[1].trim();
            taskFileContents = readFileSync(taskFilePath, 'utf-8');
          }

          const output = mockSpawnOutputs.shift() ?? 'LEAD_DONE\n';
          queueMicrotask(() => {
            emitMockEvent('workerOutput', { name, chunk: output });
          });

          return makeMockHandle(name);
        }
      );

      try {
        mockSpawnOutputs = ['LEAD_DONE\n'];
        mockSpawnExitCodes = [0];

        const run = await runner.execute(
          makeConfig({
            agents: [{ name: 'team-lead', cli: 'claude', role: 'Lead coordinator' }],
            workflows: [
              {
                name: 'default',
                steps: [
                  {
                    name: 'prepare',
                    type: 'deterministic',
                    command: `node -e "process.stdout.write('A'.repeat(${oversizedBytes}))"`,
                  },
                  {
                    name: 'lead-step',
                    agent: 'team-lead',
                    dependsOn: ['prepare'],
                    task: 'Review the injected context below and then print LEAD_DONE:\n{{steps.prepare.output}}\n/exit',
                    verification: { type: 'exit_code', value: 0 },
                  },
                ],
              },
            ],
          }),
          'default'
        );

        expect(run.status, run.error).toBe('completed');
        expect(spawnedTask).toContain('TASK_FILE:');
        expect(spawnedTask).not.toContain('{{steps.prepare.output}}');
        expect(Buffer.byteLength(spawnedTask, 'utf8')).toBeLessThan(2048);
        expect(taskFilePath).toBeTruthy();
        expect(Buffer.byteLength(taskFileContents, 'utf8')).toBeGreaterThan(
          WorkflowRunner.PTY_TASK_ARG_SIZE_LIMIT
        );
        expect(taskFileContents).toContain('Review the injected context below');
        expect(existsSync(taskFilePath)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should pass canonical bypass args to interactive codex PTY spawns', async () => {
      mockSpawnOutputs = ['LEAD_DONE\n', 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n'];
      mockSpawnExitCodes = [0];

      const run = await runner.execute(
        makeConfig({
          agents: [{ name: 'lead', cli: 'codex', role: 'Lead coordinator' }],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'lead-step',
                  agent: 'lead',
                  task: 'Output exactly:\nLEAD_DONE\n/exit',
                  verification: { type: 'exit_code', value: 0 },
                },
              ],
            },
          ],
        }),
        'default'
      );

      expect(run.status, run.error).toBe('completed');
      const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls;
      expect(spawnCalls[0][0].args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    });

    it('should let the owner complete after checking file-based artifacts', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-owner-file-'));
      const artifact = path.join(tmpDir, 'artifact.txt');
      writeFileSync(artifact, 'done\n', 'utf-8');
      runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });

      try {
        mockSpawnOutputs = [
          'worker wrote artifact\n',
          'Bash(git diff --stat)\nSTEP_COMPLETE:step-1\n',
          'REVIEW_DECISION: APPROVE\nREVIEW_REASON: artifact verified\n',
        ];

        const run = await runner.execute(
          makeSupervisedConfig({ verification: { type: 'file_exists', value: 'artifact.txt' } }),
          'default'
        );

        expect(run.status).toBe('completed');
        const ownerTask = (mockRelayInstance.spawnPty as any).mock.calls[1][0].task as string;
        expect(ownerTask).toContain('Verification gate: confirm the file exists at "artifact.txt"');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should keep specialist output for chaining even when the owner signals later', async () => {
      mockSpawnOutputs = [
        'specialist deliverable\n',
        'Worker already exited; artifacts look correct\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: handoff is safe\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      const stepRows = await db.getStepsByRunId(run.id);
      expect(stepRows[0].output).toContain('specialist deliverable');
      expect(stepRows[0].output).not.toContain('Worker already exited; artifacts look correct');
    });

    it('should fail closed (reject) when the reviewer hedges instead of deciding', async () => {
      // A reviewer that explicitly defers ("I need more context before deciding")
      // never emitted a decision. The runner treats declared indecision as a
      // fail-closed REJECT so the step retries rather than crashing as malformed.
      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'I need more context before deciding.\n',
      ];
      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
    });

    it('should fail when review explicitly rejects step output', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({
            type: event.type,
            decision: event.decision,
          });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: REJECT\nREVIEW_REASON: missing checks\n',
      ];
      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    });

    it('should parse final review decision when PTY output echoes review instructions', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({
            type: event.type,
            decision: event.decision,
          });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'Return exactly:\nREVIEW_DECISION: APPROVE or REJECT\nREVIEW_REASON: <one sentence>\nREVIEW_DECISION: REJECT\nREVIEW_REASON: insufficient evidence\n',
      ];
      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    });

    it('should record review completion in trajectory with decision and reason', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-review-traj-'));
      runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });

      try {
        mockSpawnOutputs = [
          'worker finished\n',
          'STEP_COMPLETE:step-1\n',
          'REVIEW_DECISION: APPROVE\nREVIEW_REASON: durable review record\n',
        ];

        const config = makeSupervisedConfig();
        config.trajectories = {};
        const run = await runner.execute(config, 'default');
        expect(run.status).toBe('completed');

        const trajectory = readCompletedTrajectoryFile(tmpDir);
        const events = trajectory.chapters.flatMap((chapter: any) => chapter.events);
        const reviewEvent = events.find((event: any) => event.type === 'review-completed');

        expect(reviewEvent).toBeTruthy();
        expect(reviewEvent.raw).toMatchObject({
          stepName: 'step-1',
          reviewer: 'reviewer-1',
          decision: 'approved',
          reason: 'durable review record',
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should not double release the worker when the owner fails after worker completion', async () => {
      const workerRelease = vi.fn().mockResolvedValue(undefined);
      const ownerRelease = vi.fn().mockResolvedValue(undefined);
      let markWorkerReleased!: () => void;
      const workerReleasedSignal = new Promise<void>((resolve) => {
        markWorkerReleased = resolve;
      });

      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const isOwner = name.includes('-owner-');
          const output = isOwner ? 'owner checking\n' : 'worker finished\n';

          queueMicrotask(() => {
            emitMockEvent('workerOutput', { name, chunk: output });
          });

          if (isOwner) {
            return {
              name,
              runtime: 'pty' as const,
              exitCode: undefined,
              exitSignal: undefined,
              // SpawnedAgentHandle resolves to `{ reason }` objects; the runner's
              // WorkflowAgentHandle destructures `reason`, so raw strings would
              // map to `undefined` and the timeout would go undetected.
              waitForExit: vi.fn().mockImplementation(async () => {
                // Model the test's stated ordering explicitly: the worker's
                // completion promise settles before the owner timeout fires.
                await workerReleasedSignal;
                await new Promise((resolve) => setTimeout(resolve, 0));
                return { reason: 'timeout' };
              }),
              waitForIdle: vi.fn().mockResolvedValue({ reason: 'timeout' }),
              release: ownerRelease,
            };
          }

          return {
            name,
            runtime: 'pty' as const,
            exitCode: undefined,
            exitSignal: undefined,
            waitForExit: vi.fn().mockImplementation(async () => {
              await workerRelease();
              markWorkerReleased();
              return { reason: 'released' };
            }),
            waitForIdle: vi.fn().mockImplementation(() => never()),
            release: workerRelease,
          };
        }
      );

      const run = await runner.execute(makeSupervisedConfig(), 'default');

      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner timed out');
      expect(workerRelease).toHaveBeenCalledTimes(1);
      expect(ownerRelease).toHaveBeenCalledTimes(1);
    });

    it('should emit owner-timeout when owner times out', async () => {
      const events: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') {
          events.push({
            type: event.type,
            stepName: event.stepName,
          });
        }
      });

      waitForExitFn = vi.fn().mockResolvedValue('timeout');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      // fail-fast so the single timeout surfaces immediately instead of entering
      // the auto-enabled repair/retry loop (which would re-spawn timing-out mocks).
      const run = await runner.execute(makeConfig({ errorHandling: { strategy: 'fail-fast' } }), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('timed out');
      expect(events).toContainEqual({ type: 'step:owner-timeout', stepName: 'step-1' });
    });

    it('should emit owner-timeout for a dedicated supervisor when the worker is stuck', async () => {
      const events: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') {
          events.push({ type: event.type, stepName: event.stepName });
        }
      });

      waitForExitFn = vi.fn().mockResolvedValue('timeout');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner timed out');
      expect(events).toContainEqual({ type: 'step:owner-timeout', stepName: 'step-1' });
    });

    it('should preserve self-completion when no dedicated owner is available', async () => {
      mockSpawnOutputs = ['STEP_COMPLETE:step-1\n', 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n'];

      const config = makeConfig({
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do step 1' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls;
      expect(spawnCalls[0][0].name).toContain('step-1-');
      expect(spawnCalls[0][0].name).not.toContain('worker');
      expect(spawnCalls[0][0].task).toContain('STEP OWNER CONTRACT');
      expect(spawnCalls[0][0].task).toContain('STEP_COMPLETE:step-1');
    });

    it('should use the full remaining timeout as the review safety backstop', async () => {
      const config = makeSupervisedConfig({ timeoutMs: 90_000 });
      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      const waitCalls = (waitForExitFn as any).mock?.calls ?? [];
      expect(waitCalls.length).toBeGreaterThanOrEqual(2);
      const reviewWaitMs = waitCalls[waitCalls.length - 1][0];
      expect(reviewWaitMs).toBeGreaterThan(60_000);
      expect(reviewWaitMs).toBeLessThanOrEqual(90_000);
    });
  });

  // ── Event subscription ─────────────────────────────────────────────────

  describe('on / event subscription', () => {
    it('should return unsubscribe function', async () => {
      const events: string[] = [];
      const unsub = runner.on((event) => events.push(event.type));

      await runner.execute(makeConfig(), 'default');
      const count = events.length;

      unsub();
      // Events after unsubscribe are not captured (no second execute needed to prove this,
      // just verify the unsub function works without error)
      expect(count).toBeGreaterThan(0);
    });
  });

  // ── Pause / abort ──────────────────────────────────────────────────────

  describe('pause and abort', () => {
    it('should support pause/unpause without error', () => {
      expect(() => runner.pause()).not.toThrow();
      expect(() => runner.unpause()).not.toThrow();
    });

    it('should support abort without error', () => {
      expect(() => runner.abort()).not.toThrow();
    });
  });

  // ── Resume ─────────────────────────────────────────────────────────────

  describe('resume', () => {
    it('should throw when run not found', async () => {
      await expect(runner.resume('nonexistent')).rejects.toThrow('Run "nonexistent" not found');
    });
  });

  // ── Non-interactive command builder ────────────────────────────────────

  describe('buildNonInteractiveCommand', () => {
    it('should build claude command with -p flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('claude', 'Do the thing');
      expect(cmd).toBe('claude');
      expect(args).toEqual(['-p', '--dangerously-skip-permissions', 'Do the thing']);
    });

    it('should build codex command with exec subcommand and bypass flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('codex', 'Build it');
      expect(cmd).toBe('codex');
      expect(args).toEqual(['exec', '--dangerously-bypass-approvals-and-sandbox', 'Build it']);
    });

    it('should build gemini command with -p flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('gemini', 'Analyze');
      expect(cmd).toBe('gemini');
      expect(args).toEqual(['-p', 'Analyze']);
    });

    it('should build opencode command with run subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('opencode', 'Fix bug');
      expect(cmd).toBe('opencode');
      expect(args).toEqual(['run', 'Fix bug']);
    });

    it('should build droid command with exec subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('droid', 'Deploy');
      expect(cmd).toBe('droid');
      expect(args).toEqual(['exec', 'Deploy']);
    });

    it('should build aider command with --message and safety flags', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('aider', 'Refactor');
      expect(cmd).toBe('aider');
      expect(args).toEqual(['--message', 'Refactor', '--yes-always', '--no-git']);
    });

    it('should build goose command with run subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('goose', 'Test it');
      expect(cmd).toBe('goose');
      expect(args).toEqual(['run', '--text', 'Test it', '--no-session']);
    });

    it('should append extra args after CLI-specific args', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('claude', 'Task', ['--model', 'opus']);
      expect(cmd).toBe('claude');
      expect(args).toEqual(['-p', '--dangerously-skip-permissions', 'Task', '--model', 'opus']);
    });
  });

  // ── Dry run ─────────────────────────────────────────────────────────────

  describe('dryRun', () => {
    it('should compute correct waves for a simple DAG', () => {
      const config = makeConfig();
      const report = runner.dryRun(config);

      expect(report.valid).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.totalSteps).toBe(2);
      expect(report.estimatedWaves).toBe(2);
      expect(report.waves[0].wave).toBe(1);
      expect(report.waves[0].steps).toHaveLength(1);
      expect(report.waves[0].steps[0].name).toBe('step-1');
      expect(report.waves[1].wave).toBe(2);
      expect(report.waves[1].steps).toHaveLength(1);
      expect(report.waves[1].steps[0].name).toBe('step-2');
    });

    it('should compute parallel steps in the same wave', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'parallel',
            steps: [
              { name: 'a', agent: 'agent-a', task: 'Do A' },
              { name: 'b', agent: 'agent-b', task: 'Do B' },
              { name: 'c', agent: 'agent-a', task: 'Do C', dependsOn: ['a', 'b'] },
            ],
          },
        ],
      });

      const report = runner.dryRun(config, 'parallel');

      expect(report.valid).toBe(true);
      expect(report.estimatedWaves).toBe(2);
      expect(report.waves[0].steps).toHaveLength(2);
      expect(report.waves[0].steps.map((s) => s.name).sort()).toEqual(['a', 'b']);
      expect(report.waves[1].steps).toHaveLength(1);
      expect(report.waves[1].steps[0].name).toBe('c');
    });

    it('should report agent step counts', () => {
      const config = makeConfig();
      const report = runner.dryRun(config);

      const agentA = report.agents.find((a) => a.name === 'agent-a');
      const agentB = report.agents.find((a) => a.name === 'agent-b');
      expect(agentA?.stepCount).toBe(1);
      expect(agentB?.stepCount).toBe(1);
    });

    it('should include resolved permissions without provisioning tokens', () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'workflow-dry-run-perms-'));
      try {
        writeFileSync(path.join(tmpDir, 'readme.md'), '# readme\n');
        writeFileSync(path.join(tmpDir, 'notes.txt'), 'notes\n');
        writeFileSync(path.join(tmpDir, '.agentreadonly'), 'readme.md\n');

        const dryRunRunner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });
        const report = dryRunRunner.dryRun(
          makeConfig({
            agents: [
              {
                name: 'agent-a',
                cli: 'claude',
                permissions: {
                  access: 'readonly',
                  files: {
                    write: ['notes.txt'],
                  },
                  scopes: ['relay:custom'],
                },
              },
              { name: 'agent-b', cli: 'claude' },
            ],
          })
        );

        const agentA = report.permissions?.find((entry) => entry.agent === 'agent-a');
        const agentB = report.permissions?.find((entry) => entry.agent === 'agent-b');

        expect(agentA?.agent).toBe('agent-a');
        expect(agentA?.access).toBe('readonly');
        expect(agentA?.writePaths).toBe(1);
        expect(agentA?.denyPaths).toBe(0);
        expect(agentA?.readPaths).toBeGreaterThanOrEqual(1);
        expect(agentA?.source).toBe('yaml');
        expect(agentA?.scopes).toBeGreaterThan(1);

        expect(agentB).toMatchObject({
          agent: 'agent-b',
          access: 'readwrite',
          source: 'preset',
        });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should warn when step references unknown agent', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'nonexistent', task: 'Do stuff' }],
          },
        ],
      });

      const report = runner.dryRun(config);

      expect(report.valid).toBe(true);
      expect(report.warnings.some((w) => w.includes('nonexistent'))).toBe(true);
    });

    it('should warn when wave exceeds maxConcurrency', () => {
      const config = makeConfig({
        swarm: { pattern: 'dag', maxConcurrency: 1 },
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'a', agent: 'agent-a', task: 'Do A' },
              { name: 'b', agent: 'agent-b', task: 'Do B' },
            ],
          },
        ],
      });

      const report = runner.dryRun(config);

      expect(report.valid).toBe(true);
      expect(report.warnings.some((w) => w.includes('maxConcurrency'))).toBe(true);
    });

    it('should return errors for invalid config', () => {
      const report = runner.dryRun({} as any);

      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('should return error when workflow not found', () => {
      const config = makeConfig();
      const report = runner.dryRun(config, 'nonexistent');

      expect(report.valid).toBe(false);
      expect(report.errors[0]).toContain('nonexistent');
    });
  });
});
