/**
 * `local-process` sandbox provider.
 *
 * A real provider, not a test double: it creates a private directory per
 * environment, runs real `sh -c` commands in it as real OS processes, returns
 * real exit codes and real combined output, and deletes the directory on
 * destroy. It exists for two reasons — it is the provider a contributor can run
 * with no vendor account, and it is what lets the sandbox path be proven
 * end-to-end in CI instead of only against a mock.
 *
 * Be honest about what it isolates: the filesystem root, HOME, and the working
 * directory. It is not a VM and not a container — a command can still reach the
 * wider machine. For strong isolation use a provider that gives you a real
 * boundary (`daytona`); this one's isolation level is "process".
 */

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxLaunchOptions,
  SandboxRuntimeHandle,
  SandboxWorkflowRuntime,
} from './sandbox-backend.js';

/**
 * Env var stamped into every command run by this runtime, carrying the
 * environment id. A command that observes it is provably running inside a
 * sandbox rather than in the runner's own process tree — which is exactly the
 * discriminator the routing tests assert on.
 */
export const SANDBOX_ENV_ID_VAR = 'RELAYFLOWS_SANDBOX_ENV_ID';

/** Companion marker naming the provider that supplied the environment. */
export const SANDBOX_PROVIDER_VAR = 'RELAYFLOWS_SANDBOX_PROVIDER_ID';

/** Exit code reported when a command is killed for exceeding its timeout. */
export const SANDBOX_TIMEOUT_EXIT_CODE = 124;

export interface LocalProcessSandboxRuntimeOptions {
  /** Parent directory for environment roots. Default: the OS temp dir. */
  rootDir?: string;
  /** Env applied to every command, beneath launch env and per-exec env. */
  env?: Record<string, string>;
  /**
   * Whether commands inherit the parent process env. Default `true`, matching
   * the local child-process path this provider stands in for — agent CLIs need
   * PATH, HOME-adjacent config, and credentials to work at all.
   */
  inheritEnv?: boolean;
}

interface EnvironmentState {
  root: string;
  launchEnv: Record<string, string>;
  workdir: string;
}

/**
 * Create a runtime that executes commands as real local processes inside a
 * per-environment directory.
 */
export function createLocalProcessSandboxRuntime(
  options: LocalProcessSandboxRuntimeOptions = {}
): SandboxWorkflowRuntime {
  const states = new Map<string, EnvironmentState>();
  const parentDir = options.rootDir ?? tmpdir();
  const inheritEnv = options.inheritEnv !== false;

  function requireState(handle: SandboxRuntimeHandle): EnvironmentState {
    const state = states.get(handle.id);
    if (!state) {
      throw new Error(
        `local-process sandbox "${handle.id}" is not live (never launched, or already destroyed).`
      );
    }
    return state;
  }

  return {
    id: 'local-process',

    async launch(launchOptions: SandboxLaunchOptions = {}): Promise<SandboxRuntimeHandle> {
      await mkdir(parentDir, { recursive: true });
      // The label lands in the directory name purely to make a leaked temp dir
      // traceable back to the step that made it; it is sanitized because a step
      // name is free text.
      const slug = (launchOptions.label ?? launchOptions.name ?? 'sandbox')
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .slice(0, 40);
      const root = await mkdtemp(path.join(parentDir, `relayflows-${slug}-`));
      const workdir = launchOptions.workdir ?? root;
      if (workdir !== root) await mkdir(workdir, { recursive: true });

      const id = path.basename(root);
      states.set(id, { root, workdir, launchEnv: { ...(launchOptions.env ?? {}) } });
      return { id, homeDir: root, workdir };
    },

    async exec(
      handle: SandboxRuntimeHandle,
      command: string,
      execOptions: SandboxExecOptions = {}
    ): Promise<SandboxExecResult> {
      const state = requireState(handle);
      const env: Record<string, string> = {};
      if (inheritEnv) {
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value;
        }
      }
      Object.assign(env, options.env ?? {}, state.launchEnv, execOptions.env ?? {});
      // HOME points at the sandbox root so tools that write dotfiles do it
      // inside the environment. The markers are set last so a caller cannot
      // spoof them through launch or exec env.
      env.HOME = state.root;
      env[SANDBOX_ENV_ID_VAR] = handle.id;
      env[SANDBOX_PROVIDER_VAR] = 'local-process';

      const cwd = execOptions.cwd ?? state.workdir;
      await mkdir(cwd, { recursive: true });

      return await new Promise<SandboxExecResult>((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd, env, stdio: 'pipe' });
        let output = '';
        let settled = false;
        let timedOut = false;

        const timer =
          execOptions.timeoutMs && execOptions.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
              }, execOptions.timeoutMs)
            : undefined;

        const finish = (result: SandboxExecResult): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });

        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        });

        child.on('close', (code, signal) => {
          if (timedOut) {
            finish({
              output: `${output}\n[sandbox] command exceeded ${execOptions.timeoutMs}ms and was killed`,
              exitCode: SANDBOX_TIMEOUT_EXIT_CODE,
            });
            return;
          }
          // A signal death has no exit code; report it the way a shell does so
          // callers comparing against 0 still see a failure.
          const exitCode = code ?? (signal ? 128 : 1);
          finish({ output, exitCode });
        });
      });
    },

    async uploadFile(
      handle: SandboxRuntimeHandle,
      source: string | Buffer,
      destination: string
    ): Promise<void> {
      const state = requireState(handle);
      const target = path.resolve(state.root, destination);
      const rootWithSep = state.root.endsWith(path.sep) ? state.root : state.root + path.sep;
      if (target !== state.root && !target.startsWith(rootWithSep)) {
        throw new Error(
          `Refusing to upload outside sandbox "${handle.id}": ${destination} resolves to ${target}.`
        );
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    },

    async getHomeDir(handle: SandboxRuntimeHandle): Promise<string> {
      return requireState(handle).root;
    },

    async destroy(handle: SandboxRuntimeHandle): Promise<void> {
      const state = states.get(handle.id);
      if (!state) return;
      states.delete(handle.id);
      await rm(state.root, { recursive: true, force: true });
    },
  };
}
