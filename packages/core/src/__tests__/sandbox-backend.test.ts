/**
 * Contract tests for the sandbox provider seam.
 *
 * Two things need holding still here. First, the default: a config that names
 * no provider must produce no backend, because that is what keeps the local
 * child-process path — today's behavior — untouched. Second, the port itself:
 * this engine restates `@agent-relay/sandbox`'s runtime shape so consumers are
 * not forced to install the package, and a restatement that drifts from the
 * real type is worse than no abstraction at all. The type-level assertion below
 * makes that drift a build failure rather than a runtime surprise.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { WorkflowRuntime } from '@agent-relay/sandbox';

import {
  createLazySandboxProcessBackend,
  createSandboxProcessBackend,
  createSandboxProcessBackendFromConfig,
  hasSandboxProvider,
  isSandboxEnabled,
  listSandboxProviders,
  registerSandboxProvider,
  resolveSandboxConfigFromEnv,
  type SandboxWorkflowRuntime,
} from '../sandbox-backend.js';
import {
  SANDBOX_ENV_ID_VAR,
  SANDBOX_TIMEOUT_EXIT_CODE,
  createLocalProcessSandboxRuntime,
} from '../sandbox-local-runtime.js';

// ── Port fidelity ───────────────────────────────────────────────────────────

describe('the restated port matches @agent-relay/sandbox', () => {
  it('accepts the real WorkflowRuntime where SandboxWorkflowRuntime is required', () => {
    // Compile-time only: if @agent-relay/sandbox changes `launch`, `exec`,
    // `uploadFile`, `getHomeDir`, or `destroy` in a way our restatement does
    // not cover, `npm run typecheck` fails here instead of a caller failing in
    // production against a provider that no longer fits.
    const assignable = <T extends SandboxWorkflowRuntime>(value: T): T => value;
    type Check = WorkflowRuntime extends SandboxWorkflowRuntime ? true : never;
    const proof: Check = true;
    expect(proof).toBe(true);
    expect(typeof assignable).toBe('function');
  });
});

// ── Config resolution ───────────────────────────────────────────────────────

describe('resolveSandboxConfigFromEnv', () => {
  it('defaults to no provider on an empty environment', () => {
    const config = resolveSandboxConfigFromEnv({});
    expect(config.provider).toBe('none');
    expect(isSandboxEnabled(config)).toBe(false);
  });

  it('treats a blank or whitespace-only flag as unset', () => {
    // A flag exported as an empty string is how a CI job "unsets" it; reading
    // that as a provider name would fail every step with "unknown provider".
    expect(isSandboxEnabled(resolveSandboxConfigFromEnv({ RELAYFLOWS_SANDBOX_PROVIDER: '' }))).toBe(
      false
    );
    expect(
      isSandboxEnabled(resolveSandboxConfigFromEnv({ RELAYFLOWS_SANDBOX_PROVIDER: '   ' }))
    ).toBe(false);
  });

  it('reads the provider and its knobs', () => {
    const config = resolveSandboxConfigFromEnv({
      RELAYFLOWS_SANDBOX_PROVIDER: 'daytona',
      RELAYFLOWS_SANDBOX_SNAPSHOT: 'snap-1',
      RELAYFLOWS_SANDBOX_HOME_DIR: '/home/daytona',
      RELAYFLOWS_SANDBOX_CREATE_TIMEOUT_SECONDS: '90',
      DAYTONA_API_KEY: 'dt-key',
    });

    expect(config).toMatchObject({
      provider: 'daytona',
      snapshot: 'snap-1',
      homeDir: '/home/daytona',
      createTimeoutSeconds: 90,
      apiKey: 'dt-key',
    });
  });

  it('prefers the namespaced key over the vendor one', () => {
    const config = resolveSandboxConfigFromEnv({
      RELAYFLOWS_SANDBOX_API_KEY: 'namespaced',
      DAYTONA_API_KEY: 'vendor',
    });
    expect(config.apiKey).toBe('namespaced');
  });

  it('ignores a non-numeric or non-positive create timeout', () => {
    for (const value of ['abc', '0', '-5', '']) {
      const config = resolveSandboxConfigFromEnv({
        RELAYFLOWS_SANDBOX_CREATE_TIMEOUT_SECONDS: value,
      });
      expect(config.createTimeoutSeconds).toBeUndefined();
    }
  });

  it('counts an injected runtime as enabled regardless of provider name', () => {
    const runtime = { id: 'router' } as unknown as SandboxWorkflowRuntime;
    expect(isSandboxEnabled({ runtime })).toBe(true);
    expect(isSandboxEnabled({ provider: 'none', runtime })).toBe(true);
  });
});

// ── Provider registry ───────────────────────────────────────────────────────

describe('provider registry', () => {
  it('ships daytona and local-process', () => {
    expect(listSandboxProviders()).toEqual(expect.arrayContaining(['daytona', 'local-process']));
    expect(hasSandboxProvider('nope')).toBe(false);
  });

  it('resolves a registered provider, which is the router injection seam', async () => {
    const runtime = { id: 'router-runtime' } as unknown as SandboxWorkflowRuntime;
    const factory = vi.fn(() => runtime);
    registerSandboxProvider('test-router', factory);

    const backend = await createSandboxProcessBackendFromConfig({ provider: 'test-router' });

    expect(backend).toBeDefined();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('names the registered providers when asked for one that does not exist', async () => {
    await expect(
      createSandboxProcessBackendFromConfig({ provider: 'invented' })
    ).rejects.toThrow(/Unknown sandbox provider "invented".*local-process/s);
  });

  it('prefers an injected runtime over the named provider', async () => {
    const exec = vi.fn(async () => ({ output: 'injected', exitCode: 0 }));
    const runtime: SandboxWorkflowRuntime = {
      id: 'injected',
      launch: async () => ({ id: 'e1', homeDir: '/injected' }),
      exec,
      uploadFile: async () => undefined,
      getHomeDir: async () => '/injected',
      destroy: async () => undefined,
    };

    const backend = await createSandboxProcessBackendFromConfig({
      provider: 'local-process',
      runtime,
    });
    const env = await backend!.createEnvironment('step');
    await env.exec('true');

    expect(exec).toHaveBeenCalledTimes(1);
  });
});

// ── ProcessBackend adapter ──────────────────────────────────────────────────

function recordingRuntime() {
  const execCalls: Array<{ command: string; options: unknown }> = [];
  const destroyed: string[] = [];
  const runtime: SandboxWorkflowRuntime = {
    id: 'recording',
    launch: vi.fn(async (options) => ({ id: `env-${options?.label ?? 'x'}`, homeDir: '/home/box' })),
    exec: vi.fn(async (_handle, command, options) => {
      execCalls.push({ command, options });
      return { output: 'ok', exitCode: 0 };
    }),
    uploadFile: vi.fn(async () => undefined),
    getHomeDir: vi.fn(async () => '/resolved/home'),
    destroy: vi.fn(async (handle) => {
      destroyed.push(handle.id);
    }),
  };
  return { runtime, execCalls, destroyed };
}

describe('createSandboxProcessBackend', () => {
  it('launches per environment and passes the step label through', async () => {
    const { runtime } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime, { labels: { run: 'r1' } });

    const env = await backend.createEnvironment('build');

    expect(runtime.launch).toHaveBeenCalledWith({ label: 'build', labels: { run: 'r1' } });
    expect(env.id).toBe('env-build');
    expect(env.homeDir).toBe('/home/box');
  });

  it('converts the ProcessEnvironment timeout from seconds to milliseconds', async () => {
    // The two contracts disagree on units. Getting this backwards is a 1000x
    // timeout error that looks like a hang, so it is asserted directly.
    const { runtime, execCalls } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime);
    const env = await backend.createEnvironment('build');

    await env.exec('npm test', { timeoutSeconds: 30 });

    expect(execCalls[0]!.options).toMatchObject({ timeoutMs: 30_000 });
  });

  it('omits the timeout entirely when none or a non-positive one is given', async () => {
    const { runtime, execCalls } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime);
    const env = await backend.createEnvironment('build');

    await env.exec('npm test');
    await env.exec('npm test', { timeoutSeconds: 0 });

    expect(execCalls[0]!.options).not.toHaveProperty('timeoutMs');
    expect(execCalls[1]!.options).not.toHaveProperty('timeoutMs');
  });

  it('layers per-exec env over sandbox env rather than replacing it', async () => {
    const { runtime, execCalls } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime, {
      env: { BASE: 'base', SHARED: 'from-sandbox' },
    });
    const env = await backend.createEnvironment('build');

    await env.exec('npm test', { env: { SHARED: 'from-step', STEP: 'step' } });

    expect(execCalls[0]!.options).toMatchObject({
      env: { BASE: 'base', SHARED: 'from-step', STEP: 'step' },
    });
  });

  it('only asks for the home directory when the handle did not carry one', async () => {
    const { runtime } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime);

    await backend.createEnvironment('build');
    expect(runtime.getHomeDir).not.toHaveBeenCalled();

    (runtime.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'env-bare' });
    const bare = await backend.createEnvironment('build');

    expect(runtime.getHomeDir).toHaveBeenCalledTimes(1);
    expect(bare.homeDir).toBe('/resolved/home');
  });

  it('destroys the environment it launched', async () => {
    const { runtime, destroyed } = recordingRuntime();
    const backend = createSandboxProcessBackend(runtime);

    const env = await backend.createEnvironment('build');
    await env.destroy();

    expect(destroyed).toEqual(['env-build']);
  });
});

// ── Lazy resolution ─────────────────────────────────────────────────────────

describe('createLazySandboxProcessBackend', () => {
  it('returns undefined for a disabled config, so the runner keeps its default', () => {
    expect(createLazySandboxProcessBackend({})).toBeUndefined();
    expect(createLazySandboxProcessBackend({ provider: 'none' })).toBeUndefined();
  });

  it('resolves the provider once across concurrent steps', async () => {
    const runtime = {
      id: 'once',
      launch: async () => ({ id: 'e', homeDir: '/h' }),
      exec: async () => ({ output: '', exitCode: 0 }),
      uploadFile: async () => undefined,
      getHomeDir: async () => '/h',
      destroy: async () => undefined,
    } satisfies SandboxWorkflowRuntime;
    const factory = vi.fn(async () => runtime);
    registerSandboxProvider('lazy-once', factory);

    const backend = createLazySandboxProcessBackend({ provider: 'lazy-once' })!;
    await Promise.all([
      backend.createEnvironment('a'),
      backend.createEnvironment('b'),
      backend.createEnvironment('c'),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution, so a transient error can be retried', async () => {
    // A credential that is not yet loaded should not poison the backend for the
    // rest of the process.
    let attempt = 0;
    registerSandboxProvider('lazy-flaky', async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('credentials not ready');
      return {
        id: 'flaky',
        launch: async () => ({ id: 'e', homeDir: '/h' }),
        exec: async () => ({ output: '', exitCode: 0 }),
        uploadFile: async () => undefined,
        getHomeDir: async () => '/h',
        destroy: async () => undefined,
      } satisfies SandboxWorkflowRuntime;
    });

    const backend = createLazySandboxProcessBackend({ provider: 'lazy-flaky' })!;
    await expect(backend.createEnvironment('a')).rejects.toThrow('credentials not ready');
    await expect(backend.createEnvironment('a')).resolves.toMatchObject({ id: 'e' });
    expect(attempt).toBe(2);
  });

  it('reports a missing daytona key instead of constructing a broken client', async () => {
    await expect(
      createSandboxProcessBackendFromConfig({ provider: 'daytona', apiKey: '' })
    ).rejects.toThrow(/requires an API key/);
  });

  it('reports a missing daytona home directory, which is image-specific', async () => {
    await expect(
      createSandboxProcessBackendFromConfig({ provider: 'daytona', apiKey: 'k' })
    ).rejects.toThrow(/requires a home directory/);
  });
});

// ── local-process runtime ───────────────────────────────────────────────────

describe('local-process runtime', () => {
  it('runs a real command and returns its real output and exit code', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    try {
      const ok = await runtime.exec(handle, 'echo hello');
      const bad = await runtime.exec(handle, 'echo oops >&2; exit 3');

      expect(ok).toEqual({ output: 'hello\n', exitCode: 0 });
      expect(bad.exitCode).toBe(3);
      expect(bad.output).toContain('oops');
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('stamps the environment id into every command it runs', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    try {
      const result = await runtime.exec(handle, `echo $${SANDBOX_ENV_ID_VAR}`);
      expect(result.output.trim()).toBe(handle.id);
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('refuses to let a caller spoof the marker through exec env', async () => {
    // The marker is the discriminator the routing tests rely on. If launch or
    // exec env could overwrite it, a broken backend could forge a green.
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe', env: { [SANDBOX_ENV_ID_VAR]: 'fake' } });
    try {
      const result = await runtime.exec(handle, `echo $${SANDBOX_ENV_ID_VAR}`, {
        env: { [SANDBOX_ENV_ID_VAR]: 'also-fake' },
      });
      expect(result.output.trim()).toBe(handle.id);
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('kills a command that outruns its timeout and reports it as a failure', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    try {
      const result = await runtime.exec(handle, 'sleep 5', { timeoutMs: 150 });
      expect(result.exitCode).toBe(SANDBOX_TIMEOUT_EXIT_CODE);
      expect(result.output).toContain('exceeded 150ms');
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('gives each environment its own root and deletes it on destroy', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const a = await runtime.launch({ label: 'a' });
    const b = await runtime.launch({ label: 'b' });

    expect(a.id).not.toBe(b.id);
    await expect(stat(await runtime.getHomeDir(a))).resolves.toBeDefined();

    const rootA = await runtime.getHomeDir(a);
    await runtime.destroy(a);
    await expect(stat(rootA)).rejects.toThrow();
    // Destroying one environment must not touch its sibling.
    await expect(stat(await runtime.getHomeDir(b))).resolves.toBeDefined();
    await runtime.destroy(b);
  });

  it('uploads files under the environment root, creating parents', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    try {
      await runtime.uploadFile(handle, 'contents', 'nested/dir/file.txt');
      const root = await runtime.getHomeDir(handle);
      await expect(readFile(path.join(root, 'nested/dir/file.txt'), 'utf8')).resolves.toBe(
        'contents'
      );
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('refuses an upload that escapes the environment root', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    try {
      await expect(runtime.uploadFile(handle, 'x', '../escaped.txt')).rejects.toThrow(
        /Refusing to upload outside sandbox/
      );
      await expect(runtime.uploadFile(handle, 'x', '/etc/escaped.txt')).rejects.toThrow(
        /Refusing to upload outside sandbox/
      );
    } finally {
      await runtime.destroy(handle);
    }
  });

  it('rejects work against an environment that was already destroyed', async () => {
    const runtime = createLocalProcessSandboxRuntime();
    const handle = await runtime.launch({ label: 'probe' });
    await runtime.destroy(handle);

    await expect(runtime.exec(handle, 'echo hi')).rejects.toThrow(/is not live/);
    // Destroying twice is a no-op, because teardown runs in a finally block.
    await expect(runtime.destroy(handle)).resolves.toBeUndefined();
  });

  it('honours an explicit root directory', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'relayflows-root-'));
    try {
      const runtime = createLocalProcessSandboxRuntime({ rootDir: parent });
      const handle = await runtime.launch({ label: 'probe' });
      expect(await runtime.getHomeDir(handle)).toContain(parent);
      await runtime.destroy(handle);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
