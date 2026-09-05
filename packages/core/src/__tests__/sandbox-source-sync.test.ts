/**
 * The Daytona process-backend contract, exactly.
 *
 * These tests pin the three guarantees a sandboxed deterministic workflow
 * cannot work without, and the fail-closed refusals that keep a desynced
 * sandbox from ever running a step:
 *
 *  1. one run-shared sandbox for deterministic steps (not one per step);
 *  2. the exact committed source synced and verified in it, with the source
 *     commit and tree digest bound into every step;
 *  3. the exact sandbox id exposed to every command.
 *
 * The source binding is real: tests build a real git repo in a temp dir and
 * run real `git` against it, because the binding is only honest if it is
 * computed the way production computes it. The remote side is a fake runtime
 * that runs real `sh` for step commands (so file continuity between steps is
 * a fact, not an assertion) and implements the exact verification command
 * surface the wrapper uses (sha256sum, tar extract, find).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { InMemoryWorkflowDb } from '../memory-db.js';
import {
  SOURCE_COMMIT_LABEL,
  TREE_DIGEST_LABEL,
  createSourceBoundSandboxRuntime,
  resolveSourceBinding,
} from '../sandbox-source-sync.js';
import {
  SANDBOX_ID_VAR,
  SOURCE_COMMIT_VAR,
  SOURCE_WORKDIR_VAR,
  TREE_DIGEST_VAR,
  createProcessBackendExecutor,
} from '../process-backend-executor.js';
import { registerSandboxProvider } from '../sandbox-backend.js';
import type { SandboxWorkflowRuntime } from '../sandbox-backend.js';
import type { ProcessBackend, ProcessEnvironment, WorkflowStep, WorkflowStepRow } from '../types.js';
import { WorkflowRunner } from '../runner.js';
import { workflow } from '../builder.js';

const execFileAsync = promisify(execFile);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A real git repo whose committed tree is the "exact source". */
async function makeSourceRepo(): Promise<{
  root: string;
  commit: string;
  digest: string;
  files: string[];
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'relayflows-srcsync-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'reproducer-marker.txt'), 'marker\n');
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'nested', 'deep.txt'), 'deep\n');
  await execFileAsync('git', ['-C', root, 'init', '-q']);
  await execFileAsync('git', ['-C', root, 'add', '-A']);
  await execFileAsync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const commit = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  const digest = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'])).stdout.trim();
  return { root, commit, digest, files: ['nested/deep.txt', 'reproducer-marker.txt'] };
}

async function runSh(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ output: string; exitCode: number }> {
  const cwd = opts.cwd ?? (await mkdtemp(path.join(tmpdir(), 'relayflows-sh-')));
  await mkdir(cwd, { recursive: true });
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  Object.assign(env, opts.env ?? {});
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd, env });
    return { output: stdout + stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return { output: (err.stdout ?? '') + (err.stderr ?? ''), exitCode: err.code ?? 1 };
  }
}

/**
 * A fake remote runtime implementing the verification command surface the
 * source-bound wrapper uses, running real `sh` for everything else, with
 * injectable failure modes.
 */
interface FakeRemoteOptions {
  /** Files `find` reports after extraction. Defaults to the committed set. */
  reportedFiles?: string[];
  /** Override the sha256 the runtime reports for the uploaded archive. */
  reportedSha?: string;
  /** Exit code for the extraction command. */
  extractExitCode?: number;
  /** Home dir the fake reports. Default `/home/daytona` (no real fs needed). */
  homeDir?: string;
}

function createFakeRemoteRuntime(options: FakeRemoteOptions = {}) {
  const uploads = new Map<string, Buffer>();
  const commands: { command: string; cwd?: string; env?: Record<string, string> }[] = [];
  const launchedLabels: Record<string, string>[] = [];
  let destroyed = 0;
  let seq = 0;
  let root: string | undefined;

  const runtime: SandboxWorkflowRuntime = {
    id: 'fake-remote',
    async launch(launchOptions = {}) {
      launchedLabels.push({ ...(launchOptions.labels ?? {}) });
      root = await mkdtemp(path.join(tmpdir(), 'relayflows-fakeremote-'));
      return { id: `fake-sbx-${++seq}`, homeDir: options.homeDir ?? '/home/daytona' };
    },
    async exec(handle, command, execOptions = {}) {
      commands.push({ command, cwd: execOptions.cwd, env: execOptions.env });
      if (command.startsWith('sha256sum ')) {
        const tarPath = command.split(/\s+/)[1];
        const uploaded = uploads.get(tarPath);
        const sha =
          options.reportedSha ?? (uploaded ? createHash('sha256').update(uploaded).digest('hex') : 'missing');
        return { output: `${sha}\n`, exitCode: 0 };
      }
      if (command.includes('tar -xf')) {
        return { output: '', exitCode: options.extractExitCode ?? 0 };
      }
      if (command.includes('find .')) {
        return { output: `${(options.reportedFiles ?? []).join('\n')}\n`, exitCode: 0 };
      }
      // A step command: run it for real, inside this sandbox's own directory,
      // with exactly the env the wrapper handed over.
      const cwd = execOptions.cwd ?? root;
      const result = await runSh(command, { cwd, env: execOptions.env });
      return result;
    },
    async uploadFile(_handle, source, destination) {
      uploads.set(destination, Buffer.isBuffer(source) ? source : Buffer.from(source));
    },
    async getHomeDir() {
      return '/home/daytona';
    },
    async destroy() {
      destroyed += 1;
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };

  return { runtime, uploads, commands, launchedLabels, getDestroyed: () => destroyed, launchCount: () => seq };
}

/** A fake ProcessBackend handing out source-bound or unbound environments. */
function createFakeProcessBackend(bound: boolean) {
  const createdLabels: string[] = [];
  const execs: { env: Record<string, string>; cwd?: string }[] = [];
  const envRoots: string[] = [];
  let destroyed = 0;
  let seq = 0;

  const backend: ProcessBackend = {
    async createEnvironment(label: string): Promise<ProcessEnvironment> {
      createdLabels.push(label);
      const id = `fake-env-${++seq}`;
      const envRoot = await mkdtemp(path.join(tmpdir(), 'relayflows-fakeenv-'));
      envRoots.push(envRoot);
      return {
        id,
        homeDir: envRoot,
        ...(bound
          ? { sourceCommit: 'a'.repeat(40), treeDigest: 'b'.repeat(40), sourceWorkdir: envRoot }
          : {}),
        async exec(command, opts) {
          // Record the contract (the cwd/env the executor handed over); run
          // the command for real at this environment's own root so file
          // continuity between steps in the SAME environment is a fact.
          execs.push({ env: opts?.env ?? {}, cwd: opts?.cwd });
          return runSh(command, { cwd: envRoot, env: opts?.env });
        },
        async uploadFile() {
          return;
        },
        async destroy() {
          destroyed += 1;
          await rm(envRoot, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    },
  };

  return { backend, createdLabels, execs, getDestroyed: () => destroyed };
}

function fakeStep(name: string): WorkflowStep {
  return { name, type: 'deterministic', command: 'true' } as unknown as WorkflowStep;
}

// ── Source binding ──────────────────────────────────────────────────────────

describe('resolveSourceBinding', () => {
  let repo: Awaited<ReturnType<typeof makeSourceRepo>>;

  beforeEach(async () => {
    repo = await makeSourceRepo();
  });
  afterEach(async () => {
    await rm(repo.root, { recursive: true, force: true });
  });

  it('binds a git root to the exact HEAD commit and tree digest', async () => {
    const binding = await resolveSourceBinding(repo.root);
    expect(binding.sourceCommit).toBe(repo.commit);
    expect(binding.treeDigest).toBe(repo.digest);
  });

  it('fails closed on a root that is not a git repo', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'relayflows-notgit-'));
    try {
      await expect(resolveSourceBinding(bare)).rejects.toThrow(/Sandbox source binding failed.*git/);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

// ── Source-bound runtime wrapper ────────────────────────────────────────────

describe('createSourceBoundSandboxRuntime', () => {
  let repo: Awaited<ReturnType<typeof makeSourceRepo>>;

  beforeEach(async () => {
    repo = await makeSourceRepo();
  });
  afterEach(async () => {
    await rm(repo.root, { recursive: true, force: true });
  });

  it('syncs the exact source, labels the sandbox, and binds the handle', async () => {
    const fake = createFakeRemoteRuntime({ reportedFiles: repo.files });
    const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: repo.root });

    const handle = await runtime.launch({ label: 'step-one' });

    expect(handle.id).toBe('fake-sbx-1');
    expect(handle.sourceCommit).toBe(repo.commit);
    expect(handle.treeDigest).toBe(repo.digest);
    expect(handle.workdir).toBe('/home/daytona/relayflows-source');
    expect(handle.homeDir).toBe('/home/daytona');
    // The provisioned sandbox is attributable: commit and digest are labels.
    expect(fake.launchedLabels[0][SOURCE_COMMIT_LABEL]).toBe(repo.commit);
    expect(fake.launchedLabels[0][TREE_DIGEST_LABEL]).toBe(repo.digest);
    // The exact archive bytes were uploaded...
    const uploaded = fake.uploads.get('/home/daytona/.relayflows-source.tar');
    expect(uploaded).toBeDefined();
    const localArchive = await execFileAsync(
      'git',
      ['-C', repo.root, 'archive', '--format=tar', 'HEAD'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 } as never
    );
    expect(uploaded!.equals(localArchive.stdout as unknown as Buffer)).toBe(true);
    // ...verified by digest, extracted, then file-set compared.
    expect(fake.commands.map((c) => c.command)).toEqual([
      expect.stringContaining('sha256sum /home/daytona/.relayflows-source.tar'),
      expect.stringContaining('tar -xf /home/daytona/.relayflows-source.tar -C /home/daytona/relayflows-source'),
      expect.stringContaining('find .'),
    ]);
  });

  it('fails closed when the uploaded archive digest does not match', async () => {
    const fake = createFakeRemoteRuntime({ reportedFiles: repo.files, reportedSha: '0'.repeat(64) });
    const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: repo.root });

    await expect(runtime.launch({ label: 'step' })).rejects.toThrow(/digest mismatch.*refusing an unsynced sandbox/);
  });

  it('fails closed when extraction fails remotely', async () => {
    const fake = createFakeRemoteRuntime({ reportedFiles: repo.files, extractExitCode: 2 });
    const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: repo.root });

    await expect(runtime.launch({ label: 'step' })).rejects.toThrow(/extracting the source archive.*exited 2/);
  });

  it('fails closed when the extracted file set does not match the committed tree', async () => {
    const fake = createFakeRemoteRuntime({ reportedFiles: ['only-one-file.txt'] });
    const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: repo.root });

    await expect(runtime.launch({ label: 'step' })).rejects.toThrow(
      /file set.*does not match the committed tree.*refusing an unsynced sandbox/
    );
  });

  it('fails closed when the source root is not a git repo — and provisions nothing', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'relayflows-notgit2-'));
    try {
      const fake = createFakeRemoteRuntime();
      const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: bare });
      await expect(runtime.launch({ label: 'step' })).rejects.toThrow(/Sandbox source binding failed/);
      expect(fake.launchCount()).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('passes exec, uploadFile, getHomeDir, and destroy straight through', async () => {
    const fake = createFakeRemoteRuntime({ reportedFiles: repo.files });
    const runtime = createSourceBoundSandboxRuntime(fake.runtime, { sourceRoot: repo.root });
    const handle = await runtime.launch({});

    await runtime.exec(handle, 'echo hi');
    await runtime.uploadFile(handle, 'x', '/home/daytona/x.txt');
    await expect(runtime.getHomeDir(handle)).resolves.toBe('/home/daytona');
    await runtime.destroy(handle);

    expect(fake.commands.at(-1)?.command).toBe('echo hi');
    expect(fake.uploads.get('/home/daytona/x.txt')?.toString()).toBe('x');
    expect(fake.getDestroyed()).toBe(1);
  });
});

// ── Executor: one run-shared sandbox for deterministic steps ────────────────

describe('createProcessBackendExecutor — deterministic steps', () => {
  it('source-bound: steps share ONE sandbox, see the same id, get the binding, keep file continuity', async () => {
    const { backend, createdLabels, execs, getDestroyed } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    const first = await executor.executeDeterministicStep!(
      fakeStep('one'),
      `printf '%s\\n' "\${${SANDBOX_ID_VAR}}" > stamp`,
      '/repo'
    );
    const second = await executor.executeDeterministicStep!(fakeStep('two'), 'cat stamp', '/repo');

    // File continuity across steps — the separate-sandbox defect, directly.
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain(execs[0].env[SANDBOX_ID_VAR]);
    // One environment for the whole run — not one per step.
    expect(createdLabels).toEqual(['one']);
    // Both commands saw the exact same sandbox id and the full binding.
    for (const exec of execs) {
      expect(exec.env[SANDBOX_ID_VAR]).toBe('fake-env-1');
      expect(exec.env[SOURCE_COMMIT_VAR]).toBe('a'.repeat(40));
      expect(exec.env[TREE_DIGEST_VAR]).toBe('b'.repeat(40));
      expect(exec.env[SOURCE_WORKDIR_VAR]).toBeDefined();
    }
    // The shared sandbox is NOT destroyed between steps; dispose tears it down once.
    expect(getDestroyed()).toBe(0);
    await executor.dispose!();
    expect(getDestroyed()).toBe(1);
  });

  it('source-bound: a subdirectory cwd maps inside the synced workdir', async () => {
    const { backend, execs } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    await executor.executeDeterministicStep!(fakeStep('sub'), 'true', path.join('/repo', 'packages', 'core'));

    expect(execs[0].cwd).toBe(`${execs[0].env[SOURCE_WORKDIR_VAR]}/packages/core`);
  });

  it('source-bound: a cwd escaping the source root fails closed', async () => {
    const { backend } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    await expect(executor.executeDeterministicStep!(fakeStep('escape'), 'true', '/elsewhere')).rejects.toThrow(
      /escapes the synced source root.*refusing to run/
    );
  });

  it('source-bound: no source root configured fails closed instead of guessing', async () => {
    const { backend } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend);

    await expect(executor.executeDeterministicStep!(fakeStep('noroot'), 'true', '/repo')).rejects.toThrow(
      /no source root is configured/
    );
  });

  it('unbound backends keep per-step environments, pass-through cwd, no binding vars', async () => {
    const { backend, createdLabels, execs, getDestroyed } = createFakeProcessBackend(false);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    await executor.executeDeterministicStep!(fakeStep('one'), 'true', '/repo');
    await executor.executeDeterministicStep!(fakeStep('two'), 'true', '/repo');

    // Today's contract, byte for byte: an environment per step, destroyed
    // inline, cwd untouched, no source binding invented.
    expect(createdLabels).toEqual(['one', 'two']);
    expect(execs.map((e) => e.cwd)).toEqual(['/repo', '/repo']);
    expect(execs.map((e) => e.env[SANDBOX_ID_VAR])).toEqual(['fake-env-1', 'fake-env-2']); // own id, still exposed
    for (const exec of execs) {
      expect(exec.env[SOURCE_COMMIT_VAR]).toBeUndefined();
      expect(exec.env[TREE_DIGEST_VAR]).toBeUndefined();
    }
    expect(getDestroyed()).toBe(2);
    await executor.dispose!(); // nothing shared: a no-op
    expect(getDestroyed()).toBe(2);
  });

  it('concurrent first steps do not double-provision the shared sandbox', async () => {
    const { backend, createdLabels } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    await Promise.all([
      executor.executeDeterministicStep!(fakeStep('a'), 'true', '/repo'),
      executor.executeDeterministicStep!(fakeStep('b'), 'true', '/repo'),
      executor.executeDeterministicStep!(fakeStep('c'), 'true', '/repo'),
    ]);

    expect(createdLabels).toEqual(['a']);
  });

  it('after dispose, the next run provisions a fresh shared sandbox', async () => {
    const { backend, createdLabels } = createFakeProcessBackend(true);
    const executor = createProcessBackendExecutor(backend, { sourceRoot: '/repo' });

    await executor.executeDeterministicStep!(fakeStep('one'), 'true', '/repo');
    await executor.dispose!();
    await executor.executeDeterministicStep!(fakeStep('two'), 'true', '/repo');

    expect(createdLabels).toEqual(['one', 'two']);
  });
});

// ── Runner integration: the guarantees hold through a real run ─────────────

describe('WorkflowRunner + source-bound provider — the full contract', () => {
  const PROVIDER = 'srcsync-fake-provider';
  let repo: Awaited<ReturnType<typeof makeSourceRepo>>;

  interface FakeRunState {
    destroyed: number;
    sandboxIds: string[];
    sourceRootSeen?: string;
  }

  beforeEach(async () => {
    repo = await makeSourceRepo();
  });
  afterEach(async () => {
    await rm(repo.root, { recursive: true, force: true });
  });

  async function runTwoStepWorkflow(): Promise<{
    status: string;
    steps: WorkflowStepRow[];
    state: FakeRunState;
  }> {
    const state: FakeRunState = { destroyed: 0, sandboxIds: [] };
    registerSandboxProvider(PROVIDER, async (config) => {
      state.sourceRootSeen = config.sourceRoot;
      const homeDir = await mkdtemp(path.join(tmpdir(), 'relayflows-runhome-'));
      const fake = createFakeRemoteRuntime({ reportedFiles: repo.files, homeDir });
      const inner = fake.runtime;
      const bound: SandboxWorkflowRuntime = {
        id: inner.id,
        launch: async (launchOptions = {}) => {
          const handle = await inner.launch(launchOptions);
          state.sandboxIds.push(handle.id);
          return {
            ...handle,
            workdir: handle.homeDir,
            sourceCommit: repo.commit,
            treeDigest: repo.digest,
          };
        },
        exec: (handle, command, execOptions) => inner.exec(handle, command, execOptions),
        uploadFile: (handle, source, destination) => inner.uploadFile(handle, source, destination),
        getHomeDir: (handle) => inner.getHomeDir(handle),
        destroy: async (handle) => {
          state.destroyed += 1;
          return inner.destroy(handle);
        },
      };
      return bound;
    });

    const config = workflow('srcsync-probe')
      .pattern('pipeline')
      .step('probe-one', {
        type: 'deterministic',
        command: `echo "sid=\${${SANDBOX_ID_VAR}:-ABSENT} commit=\${${SOURCE_COMMIT_VAR}:-ABSENT}"`,
      })
      .step('probe-two', {
        type: 'deterministic',
        command: `echo "sid2=\${${SANDBOX_ID_VAR}:-ABSENT} digest=\${${TREE_DIGEST_VAR}:-ABSENT}"`,
        dependsOn: ['probe-one'],
      })
      .toConfig();

    const db = new InMemoryWorkflowDb();
    const runner = new WorkflowRunner({
      cwd: repo.root,
      db,
      sandbox: { provider: PROVIDER, homeDir: '/home/daytona', sourceRoot: repo.root },
    });
    const run = await runner.execute(config, 'srcsync-probe-workflow');
    const steps = await db.getStepsByRunId(run.id);
    return { status: run.status, steps, state };
  }

  it('one sandbox for the run, binding in every step, destroyed at run end', async () => {
    const { status, steps, state } = await runTwoStepWorkflow();

    expect(status).toBe('completed');
    // The runner wired its cwd through as the source root.
    expect(state.sourceRootSeen).toBe(repo.root);
    // ONE sandbox provisioned for the whole run — the separate-sandbox defect.
    expect(state.sandboxIds).toHaveLength(1);
    const sandboxId = state.sandboxIds[0];

    const one = steps.find((s) => s.stepName === 'probe-one')!;
    const two = steps.find((s) => s.stepName === 'probe-two')!;
    // The exact sandbox id is available to each command and identical across steps.
    expect(one.output).toContain(`sid=${sandboxId}`);
    expect(two.output).toContain(`sid2=${sandboxId}`);
    // The source commit and tree digest are bound into every step.
    expect(one.output).toContain(`commit=${repo.commit}`);
    expect(two.output).toContain(`digest=${repo.digest}`);
    // Run end tears the shared sandbox down.
    expect(state.destroyed).toBe(1);
  });
});
