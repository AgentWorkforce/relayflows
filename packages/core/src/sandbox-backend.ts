/**
 * Sandbox provider seam.
 *
 * Relay owns command construction, auth env, cwd, timeout, and step lifecycle.
 * A *sandbox provider* owns only "where the command runs". Historically the one
 * provider was Daytona, and it was reachable only by a caller hand-injecting a
 * `processBackend` into the runner — the vendor choice lived entirely outside
 * this engine, so nothing here could be configured, defaulted, or tested.
 *
 * This module moves that decision behind `@agent-relay/sandbox`'s
 * provider-agnostic runtime port. The engine depends on the port, never on a
 * vendor SDK: `@daytonaio/sdk` is an optional peer loaded lazily, and only when
 * the Daytona provider is actually selected.
 *
 * Reversibility: the default provider is `none`, which yields no backend at
 * all, so the runner keeps spawning local child processes exactly as it does
 * today. Turning the flag off — unsetting `RELAYFLOWS_SANDBOX_PROVIDER` or
 * passing `{ provider: 'none' }` — restores current behavior byte for byte.
 */

import type { ProcessBackend, ProcessEnvironment } from './types.js';

// ── The port ────────────────────────────────────────────────────────────────
//
// Structurally identical to the subset of `@agent-relay/sandbox`'s
// `WorkflowRuntime` that a ProcessBackend needs. It is restated here so the
// engine's public types do not force every consumer to install the sandbox
// package, and so an injected runtime (e.g. the Relay router's own
// RelayRuntime) can satisfy the seam without importing it either.
// `sandbox-backend.test.ts` asserts at type level that the real
// `WorkflowRuntime` is assignable to this, so drift is a build failure.

/** A live sandbox, as handed back by {@link SandboxWorkflowRuntime.launch}. */
export interface SandboxRuntimeHandle {
  id: string;
  homeDir?: string;
  workdir?: string;
}

/** Options a provider accepts when creating a sandbox. */
export interface SandboxLaunchOptions {
  label?: string;
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  workdir?: string;
  createTimeoutSeconds?: number;
}

/** Options for a single command executed inside a sandbox. */
export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Result of a single command executed inside a sandbox. */
export interface SandboxExecResult {
  output: string;
  exitCode: number;
}

/**
 * The narrow provider contract this engine depends on — create a sandbox, run
 * commands in it, put files in it, tear it down.
 */
export interface SandboxWorkflowRuntime {
  readonly id: string;
  launch(options?: SandboxLaunchOptions): Promise<SandboxRuntimeHandle>;
  exec(
    handle: SandboxRuntimeHandle,
    command: string,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
  uploadFile(
    handle: SandboxRuntimeHandle,
    source: string | Buffer,
    destination: string
  ): Promise<void>;
  getHomeDir(handle: SandboxRuntimeHandle): Promise<string>;
  destroy(handle: SandboxRuntimeHandle): Promise<void>;
}

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Built-in provider names. Any other string resolves through
 * {@link registerSandboxProvider}, which is how the Relay router plugs in its
 * own runtime without this repo knowing anything about it.
 */
export type SandboxProviderName = 'none' | 'daytona' | 'local-process' | (string & {});

export interface SandboxBackendConfig {
  /**
   * Which provider supplies execution environments. Default `none` — no
   * backend, so the runner spawns local child processes as it does today.
   */
  provider?: SandboxProviderName;
  /**
   * A ready-made runtime. When set it wins over `provider`, and is the seam an
   * out-of-repo router satisfies with its own client.
   */
  runtime?: SandboxWorkflowRuntime;
  /** Provider credential (Daytona API key). Falls back to `DAYTONA_API_KEY`. */
  apiKey?: string;
  /** Provider image/snapshot to launch from. */
  snapshot?: string;
  /**
   * Home directory inside the image. Required by Daytona because it is
   * image-specific; there is no default that is right for every image.
   */
  homeDir?: string;
  /** Working directory inside the sandbox. */
  workdir?: string;
  /** Env injected at sandbox creation (per-step env is layered on top). */
  env?: Record<string, string>;
  /** Provider labels stamped on each created sandbox. */
  labels?: Record<string, string>;
  /** Deadline for sandbox creation. */
  createTimeoutSeconds?: number;
}

/** A factory that turns config into a live runtime. */
export type SandboxProviderFactory = (
  config: SandboxBackendConfig
) => SandboxWorkflowRuntime | Promise<SandboxWorkflowRuntime>;

const providerRegistry = new Map<string, SandboxProviderFactory>();

/**
 * Register a provider under `name`, so `provider: name` resolves to it.
 *
 * This is the dependency-injection seam for runtimes that cannot live in this
 * repo. Registering a name that already exists replaces it, which is what lets
 * a host override a built-in provider.
 */
export function registerSandboxProvider(name: string, factory: SandboxProviderFactory): void {
  providerRegistry.set(name, factory);
}

/** Whether a provider name has a registered factory. Exported for diagnostics. */
export function hasSandboxProvider(name: string): boolean {
  return providerRegistry.has(name);
}

/** Registered provider names, sorted. Exported for diagnostics and errors. */
export function listSandboxProviders(): string[] {
  return [...providerRegistry.keys()].sort();
}

// ── Env-driven config ───────────────────────────────────────────────────────

/**
 * Read sandbox config off the environment. Every knob is optional and the
 * provider defaults to `none`, so an environment that sets none of these
 * produces today's behavior.
 */
export function resolveSandboxConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SandboxBackendConfig {
  const provider = env.RELAYFLOWS_SANDBOX_PROVIDER?.trim();
  const config: SandboxBackendConfig = { provider: provider ? provider : 'none' };

  const apiKey = env.RELAYFLOWS_SANDBOX_API_KEY?.trim() || env.DAYTONA_API_KEY?.trim();
  if (apiKey) config.apiKey = apiKey;

  const snapshot = env.RELAYFLOWS_SANDBOX_SNAPSHOT?.trim();
  if (snapshot) config.snapshot = snapshot;

  const homeDir = env.RELAYFLOWS_SANDBOX_HOME_DIR?.trim();
  if (homeDir) config.homeDir = homeDir;

  const workdir = env.RELAYFLOWS_SANDBOX_WORKDIR?.trim();
  if (workdir) config.workdir = workdir;

  const createTimeout = Number(env.RELAYFLOWS_SANDBOX_CREATE_TIMEOUT_SECONDS);
  if (Number.isFinite(createTimeout) && createTimeout > 0) {
    config.createTimeoutSeconds = createTimeout;
  }

  return config;
}

/**
 * Whether a config asks for a sandbox at all. Cheap and synchronous, so the
 * runner can decide without paying for a provider import.
 */
export function isSandboxEnabled(config: SandboxBackendConfig | undefined): boolean {
  if (!config) return false;
  if (config.runtime) return true;
  const provider = config.provider ?? 'none';
  return provider !== 'none' && provider !== '';
}

// ── Runtime resolution ──────────────────────────────────────────────────────

/** Resolve config to a live runtime, or `undefined` when sandboxing is off. */
export async function resolveSandboxRuntime(
  config: SandboxBackendConfig
): Promise<SandboxWorkflowRuntime | undefined> {
  if (config.runtime) return config.runtime;

  const provider = config.provider ?? 'none';
  if (provider === 'none' || provider === '') return undefined;

  const factory = providerRegistry.get(provider);
  if (!factory) {
    throw new Error(
      `Unknown sandbox provider "${provider}". Registered providers: ${
        listSandboxProviders().join(', ') || '(none)'
      }. Register one with registerSandboxProvider(), or pass config.runtime directly.`
    );
  }
  return await factory(config);
}

// ── ProcessBackend adapter ──────────────────────────────────────────────────

export interface SandboxProcessBackendOptions {
  /** Env injected at sandbox creation; per-exec env is layered on top. */
  env?: Record<string, string>;
  /** Labels stamped on each created sandbox. */
  labels?: Record<string, string>;
  /** Working directory inside the sandbox. */
  workdir?: string;
  /** Deadline for sandbox creation. */
  createTimeoutSeconds?: number;
}

/**
 * Adapt a {@link SandboxWorkflowRuntime} to the runner's {@link ProcessBackend}.
 *
 * One sandbox per step: `createEnvironment` launches, the returned environment
 * execs, and `destroy` tears it down. The two contracts differ in one detail
 * that matters — `ProcessEnvironment.exec` takes `timeoutSeconds` while the
 * sandbox port takes `timeoutMs` — so the conversion happens here rather than
 * at every call site.
 */
export function createSandboxProcessBackend(
  runtime: SandboxWorkflowRuntime,
  options: SandboxProcessBackendOptions = {}
): ProcessBackend {
  return {
    async createEnvironment(label: string): Promise<ProcessEnvironment> {
      const launchOptions: SandboxLaunchOptions = { label };
      if (options.env && Object.keys(options.env).length > 0) launchOptions.env = options.env;
      if (options.labels && Object.keys(options.labels).length > 0) {
        launchOptions.labels = options.labels;
      }
      if (options.workdir) launchOptions.workdir = options.workdir;
      if (options.createTimeoutSeconds) {
        launchOptions.createTimeoutSeconds = options.createTimeoutSeconds;
      }

      const handle = await runtime.launch(launchOptions);
      // Prefer the handle's own homeDir; only pay for a round trip when the
      // provider did not already resolve one.
      const homeDir = handle.homeDir ?? (await runtime.getHomeDir(handle));

      return {
        id: handle.id,
        homeDir,
        async exec(command, execOpts) {
          const sandboxOpts: SandboxExecOptions = {};
          if (execOpts?.cwd) sandboxOpts.cwd = execOpts.cwd;
          const mergedEnv = { ...(options.env ?? {}), ...(execOpts?.env ?? {}) };
          if (Object.keys(mergedEnv).length > 0) sandboxOpts.env = mergedEnv;
          if (execOpts?.timeoutSeconds && execOpts.timeoutSeconds > 0) {
            sandboxOpts.timeoutMs = execOpts.timeoutSeconds * 1000;
          }
          const result = await runtime.exec(handle, command, sandboxOpts);
          return { output: result.output, exitCode: result.exitCode };
        },
        async uploadFile(content, remotePath) {
          await runtime.uploadFile(handle, content, remotePath);
        },
        async destroy() {
          await runtime.destroy(handle);
        },
      };
    },
  };
}

/**
 * Build a ProcessBackend from config, or `undefined` when sandboxing is off.
 * Async because providers are imported lazily; see
 * {@link createLazySandboxProcessBackend} for the synchronous entry point the
 * runner constructor uses.
 */
export async function createSandboxProcessBackendFromConfig(
  config: SandboxBackendConfig
): Promise<ProcessBackend | undefined> {
  const runtime = await resolveSandboxRuntime(config);
  if (!runtime) return undefined;
  return createSandboxProcessBackend(runtime, backendOptionsFrom(config));
}

function backendOptionsFrom(config: SandboxBackendConfig): SandboxProcessBackendOptions {
  const options: SandboxProcessBackendOptions = {};
  if (config.env) options.env = config.env;
  if (config.labels) options.labels = config.labels;
  if (config.workdir) options.workdir = config.workdir;
  if (config.createTimeoutSeconds) options.createTimeoutSeconds = config.createTimeoutSeconds;
  return options;
}

/**
 * Synchronous entry point: returns `undefined` immediately when sandboxing is
 * off, otherwise a ProcessBackend that resolves its provider on first use.
 *
 * The runner's constructor is synchronous and a provider import is not, so the
 * import is deferred to the first `createEnvironment` call. The resolution
 * promise is memoized, so N concurrent steps import the provider once; a failed
 * resolution is not cached, so a transient credential error can be retried.
 */
export function createLazySandboxProcessBackend(
  config: SandboxBackendConfig
): ProcessBackend | undefined {
  if (!isSandboxEnabled(config)) return undefined;

  let pending: Promise<ProcessBackend> | undefined;
  const resolveBackend = (): Promise<ProcessBackend> => {
    if (!pending) {
      pending = (async () => {
        const backend = await createSandboxProcessBackendFromConfig(config);
        if (!backend) {
          throw new Error(
            `Sandbox provider "${config.provider}" resolved to no backend after reporting enabled.`
          );
        }
        return backend;
      })().catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };

  return {
    async createEnvironment(label: string) {
      const backend = await resolveBackend();
      return backend.createEnvironment(label);
    },
  };
}

// ── Built-in provider: local-process ────────────────────────────────────────
//
// Imported lazily so selecting a remote provider never pulls in the local one,
// and so registration stays in this module rather than depending on whether a
// consumer happened to import `sandbox-local-runtime.js`.

registerSandboxProvider('local-process', async (config) => {
  const { createLocalProcessSandboxRuntime } = await import('./sandbox-local-runtime.js');
  const runtimeOptions: { env?: Record<string, string> } = {};
  if (config.env) runtimeOptions.env = config.env;
  return createLocalProcessSandboxRuntime(runtimeOptions);
});

// ── Built-in provider: Daytona, via @agent-relay/sandbox ────────────────────

registerSandboxProvider('daytona', async (config) => {
  const apiKey = config.apiKey ?? process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Sandbox provider "daytona" requires an API key. Set DAYTONA_API_KEY or pass sandbox.apiKey.'
    );
  }
  if (!config.homeDir) {
    throw new Error(
      'Sandbox provider "daytona" requires a home directory (it is image-specific). ' +
        'Set RELAYFLOWS_SANDBOX_HOME_DIR or pass sandbox.homeDir.'
    );
  }

  const { DaytonaRuntime } = await import('@agent-relay/sandbox');
  // `@daytonaio/sdk` is an optional peer of @agent-relay/sandbox and is not a
  // dependency of this engine. The specifier is held in a variable so the
  // module is resolved at runtime only — installing it is the price of
  // selecting this provider, not of installing relayflows.
  const daytonaSdkSpecifier = '@daytonaio/sdk';
  let DaytonaClient: new (options: { apiKey: string }) => unknown;
  try {
    ({ Daytona: DaytonaClient } = (await import(daytonaSdkSpecifier)) as {
      Daytona: new (options: { apiKey: string }) => unknown;
    });
  } catch (error) {
    throw new Error(
      'Sandbox provider "daytona" requires the optional peer "@daytonaio/sdk". ' +
        `Install it to use this provider. Original error: ${
          error instanceof Error ? error.message : String(error)
        }`
    );
  }

  const runtimeOptions: {
    daytona: never;
    defaultHomeDir: string;
    snapshot?: string;
  } = {
    daytona: new DaytonaClient({ apiKey }) as never,
    defaultHomeDir: config.homeDir,
  };
  if (config.snapshot) runtimeOptions.snapshot = config.snapshot;

  return new DaytonaRuntime(runtimeOptions) as unknown as SandboxWorkflowRuntime;
});
