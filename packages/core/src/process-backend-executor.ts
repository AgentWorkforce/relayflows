/**
 * Adapter that implements {@link RunnerStepExecutor} on top of a
 * {@link ProcessBackend}. Relay owns command construction (CLI flags, env,
 * cwd, timeout); the backend only provides "where to run" — create an
 * isolated environment, exec the command, destroy.
 *
 * The WorkflowRunner synthesizes one of these when a caller passes
 * `processBackend` without an explicit `executor`, so every existing
 * `executor.executeAgentStep(...)` call site transparently flows through
 * the backend (e.g. a cloud sandbox) without any further plumbing.
 *
 * Deterministic steps hold a stronger contract than agent steps, because a
 * deterministic workflow only makes sense when its steps share one world:
 *
 * - **One environment per run.** The first deterministic step provisions the
 *   environment; its siblings reuse it. This mirrors the local path, where
 *   every step runs on the same machine in the same tree, so "write a file in
 *   step 1, read it in step 2" works identically sandboxed and not. The
 *   environment is destroyed by {@link RunnerStepExecutor.dispose}, which the
 *   runner calls when the run ends.
 * - **Sandbox identity is visible.** Every deterministic command receives
 *   `RELAYFLOWS_SANDBOX_ID` (and, on a source-bound backend,
 *   `RELAYFLOWS_SOURCE_COMMIT` / `RELAYFLOWS_TREE_DIGEST` /
 *   `RELAYFLOWS_SOURCE_WORKDIR`), so output can be tied to the exact sandbox
 *   that produced it.
 * - **Source-bound cwd mapping, fail closed.** On a backend that synced the
 *   source (env reports `sourceCommit`/`treeDigest`/`sourceWorkdir`), a step's
 *   local cwd is remapped into the synced workdir; a cwd outside the source
 *   root refuses to run rather than executing against a path that does not
 *   exist remotely. Backends that do not bind source (local-process, injected
 *   hosts) keep today's per-step, pass-through behavior byte for byte.
 */

import path from 'node:path';

import { buildCommand } from './process-spawner.js';
import type { ProcessBackend, ProcessEnvironment, AgentDefinition, WorkflowStep, RunnerStepExecutor } from './types.js';

function shellEscape(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\/.:,=+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShell(argv: string[]): string {
  return argv.map(shellEscape).join(' ');
}

/** Env var carrying the exact sandbox id to every deterministic command. */
export const SANDBOX_ID_VAR = 'RELAYFLOWS_SANDBOX_ID';
/** Env var carrying the bound source commit, on source-bound backends. */
export const SOURCE_COMMIT_VAR = 'RELAYFLOWS_SOURCE_COMMIT';
/** Env var carrying the bound source tree digest, on source-bound backends. */
export const TREE_DIGEST_VAR = 'RELAYFLOWS_TREE_DIGEST';
/** Env var carrying the synced workdir, on source-bound backends. */
export const SOURCE_WORKDIR_VAR = 'RELAYFLOWS_SOURCE_WORKDIR';

function isSourceBound(env: ProcessEnvironment): boolean {
  return Boolean(env.sourceCommit && env.treeDigest && env.sourceWorkdir);
}

export interface ProcessBackendExecutorOptions {
  /** Env vars injected into every step (e.g. auth tokens, relayfile config). */
  env?: Record<string, string>;
  /**
   * Absolute local root whose tree source-bound backends sync into the
   * sandbox. Deterministic step cwds inside it are remapped into the synced
   * workdir; cwds outside it fail closed. The runner passes its own cwd.
   */
  sourceRoot?: string;
}

export function createProcessBackendExecutor(
  backend: ProcessBackend,
  options: ProcessBackendExecutorOptions = {}
): RunnerStepExecutor {
  const baseEnv = options.env ?? {};
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : undefined;

  /** The run-shared deterministic environment, once a source-bound backend provisions one. */
  let sharedEnv: ProcessEnvironment | undefined;
  /** Serializes provisioning so concurrent first steps cannot double-launch. */
  let provisioning: Promise<void> | undefined;

  /**
   * Acquire the environment a deterministic step runs in.
   *
   * Source-bound backends: one shared environment per executor (per run),
   * released only by `dispose`. Unbound backends: one environment per step,
   * destroyed inline — exactly the behavior before run-sharing existed.
   */
  async function acquireDeterministicEnvironment(
    label: string
  ): Promise<{ env: ProcessEnvironment; release: (() => Promise<void>) | undefined }> {
    if (sharedEnv) return { env: sharedEnv, release: undefined };

    // Serialize the first provisioning; a fan-out's concurrent first steps
    // must not each launch their own sandbox.
    while (provisioning) await provisioning;
    if (sharedEnv) return { env: sharedEnv, release: undefined };

    let unlock: () => void = () => undefined;
    provisioning = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    try {
      const env = await backend.createEnvironment(label);
      if (isSourceBound(env)) {
        sharedEnv = env;
        return { env, release: undefined };
      }
      return {
        env,
        release: () =>
          env.destroy().catch(() => {
            // A step-scoped teardown failure must not mask the step's own
            // result; the shared path is the one that must be airtight.
          }),
      };
    } finally {
      unlock();
      provisioning = undefined;
    }
  }

  /**
   * Map a local step cwd into the synced sandbox workdir. Fails closed when
   * the cwd escapes the source root: the path exists only on the runner's
   * machine, and running against it remotely is the desync this seam exists
   * to prevent.
   */
  function mapSourceBoundCwd(env: ProcessEnvironment, cwd: string): string {
    if (!sourceRoot) {
      throw new Error(
        `Deterministic step cwd "${cwd}" cannot be mapped into source-bound sandbox "${env.id}": ` +
          `no source root is configured. Pass ProcessBackendExecutorOptions.sourceRoot (the runner does).`
      );
    }
    const rel = path.relative(sourceRoot, path.resolve(cwd));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `Deterministic step cwd "${cwd}" escapes the synced source root "${sourceRoot}"; ` +
          `refusing to run it in sandbox "${env.id}" against a path that exists only on the runner. ` +
          `Move the step's cwd inside the source root.`
      );
    }
    return rel === '' ? env.sourceWorkdir! : path.posix.join(env.sourceWorkdir!, rel.split(path.sep).join('/'));
  }

  function bindingEnv(env: ProcessEnvironment): Record<string, string> {
    const binding: Record<string, string> = { [SANDBOX_ID_VAR]: env.id };
    if (env.sourceCommit) binding[SOURCE_COMMIT_VAR] = env.sourceCommit;
    if (env.treeDigest) binding[TREE_DIGEST_VAR] = env.treeDigest;
    if (env.sourceWorkdir) binding[SOURCE_WORKDIR_VAR] = env.sourceWorkdir;
    return binding;
  }

  return {
    async executeAgentStep(
      step: WorkflowStep,
      agentDef: AgentDefinition,
      resolvedTask: string,
      timeoutMs?: number
    ): Promise<string> {
      if (agentDef.cli === 'api') {
        throw new Error(
          `processBackend cannot execute cli "api" agents — api agents call the Anthropic API directly. ` +
            `Route agent "${agentDef.name}" through a subprocess CLI (claude, codex, etc.) or omit processBackend.`
        );
      }
      if (!agentDef.cli) {
        throw new Error(
          `processBackend cannot execute persona agent "${agentDef.name}"; personas require the interactive Relayflow runtime.`
        );
      }

      const extraArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : [];
      const argv = buildCommand(agentDef.cli, extraArgs, resolvedTask);
      const commandString = commandToShell(argv);

      const env = await backend.createEnvironment(step.name);
      try {
        const execOpts: {
          cwd?: string;
          env?: Record<string, string>;
          timeoutSeconds?: number;
        } = {};
        if (agentDef.cwd) execOpts.cwd = agentDef.cwd;
        if (Object.keys(baseEnv).length > 0) execOpts.env = baseEnv;
        // timeoutSeconds is ceil-rounded from the caller's timeoutMs; a 500ms
        // timeout becomes 1s because the backend protocol uses seconds.
        if (timeoutMs && timeoutMs > 0) {
          execOpts.timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        }
        const result = await env.exec(commandString, execOpts);
        if (result.exitCode !== 0) {
          const tail = result.output.slice(-2000);
          throw new Error(`Agent step "${step.name}" exited with code ${result.exitCode}: ${tail}`);
        }
        return result.output;
      } finally {
        await env.destroy().catch(() => undefined);
      }
    },

    async executeDeterministicStep(
      step: WorkflowStep,
      resolvedCommand: string,
      cwd: string
    ): Promise<{ output: string; exitCode: number }> {
      const { env, release } = await acquireDeterministicEnvironment(step.name);
      try {
        const execOpts: {
          cwd?: string;
          env?: Record<string, string>;
          timeoutSeconds?: number;
        } = {};
        if (isSourceBound(env)) {
          execOpts.cwd = mapSourceBoundCwd(env, cwd);
        } else {
          execOpts.cwd = cwd;
        }
        execOpts.env = { ...baseEnv, ...bindingEnv(env) };
        if (step.timeoutMs && step.timeoutMs > 0) {
          execOpts.timeoutSeconds = Math.max(1, Math.ceil(step.timeoutMs / 1000));
        }
        return await env.exec(resolvedCommand, execOpts);
      } finally {
        await release?.();
      }
    },

    async dispose(): Promise<void> {
      const env = sharedEnv;
      sharedEnv = undefined;
      if (env) {
        await env.destroy().catch((error: unknown) => {
          // Run-end teardown is already the last act of the run; surface the
          // failure as a rejected dispose so the runner can log it, but never
          // let it retroactively fail a completed run.
          throw new Error(
            `Failed to destroy the run-shared deterministic sandbox "${env.id}": ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
    },
  };
}
