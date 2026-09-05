/**
 * Source-bound sandbox provisioning.
 *
 * A remote sandbox is useless to a deterministic step unless three facts hold:
 * the step runs in the SAME sandbox as its siblings (one per run, like the
 * local path shares one machine), the EXACT source tree is present in it, and
 * the process can see WHICH sandbox it is in. Historically none held: each
 * step launched its own empty sandbox, was pointed at a cwd path that only
 * exists on the runner's machine, and was never told the sandbox ID.
 *
 * This module wraps a {@link SandboxWorkflowRuntime} (the Daytona provider
 * among them) and makes those three facts a launch-time invariant — or refuses
 * to launch. "Fail closed" is the contract: if the source cannot be identified
 * (not a git repo), transported (upload), or verified (digest + file set), no
 * sandbox is handed back, so no step can run in a desynced environment.
 *
 * The source identity is a git commit and its tree digest; the bytes synced
 * are `git archive HEAD` of that commit, so the digest names exactly the tree
 * that was uploaded. Both are stamped as sandbox labels and carried on the
 * handle, which is how every step gets them bound into its environment.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxLaunchOptions,
  SandboxRuntimeHandle,
  SandboxWorkflowRuntime,
} from './sandbox-backend.js';

const execFileAsync = promisify(execFile);

/** Label carrying the source commit on every provisioned sandbox. */
export const SOURCE_COMMIT_LABEL = 'relayflows/source-commit';
/** Label carrying the source tree digest on every provisioned sandbox. */
export const TREE_DIGEST_LABEL = 'relayflows/tree-digest';

/** Directory name (under the sandbox home) the source archive is extracted to. */
export const SOURCE_WORKDIR_NAME = 'relayflows-source';

/** Bounded time for each verification command run inside the sandbox. */
const SYNC_EXEC_TIMEOUT_MS = 300_000;

/** The exact source identity a sandbox is bound to. */
export interface SourceBinding {
  /** Full commit hash of `HEAD` in the source root. */
  sourceCommit: string;
  /** Tree digest of that commit (`git rev-parse HEAD^{tree}`). */
  treeDigest: string;
}

export interface SourceBoundRuntimeOptions {
  /**
   * Local git working tree whose committed HEAD is the exact source. Required
   * and must be a git repo with at least one commit — there is no honest way
   * to bind a sandbox to "whatever files happen to be here".
   */
  sourceRoot: string;
}

function gitError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Sandbox source binding failed (${context}). The sandbox provider requires a git source root with at least one commit; ` +
      `refusing to provision an unsynced sandbox. Detail: ${detail}`
  );
}

async function git(sourceRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', sourceRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw gitError(`git ${args.join(' ')}`, error);
  }
}

/**
 * Resolve the exact source identity of a source root: the HEAD commit and its
 * tree digest. Throws (fail closed) when the root is not a boundable git repo.
 */
export async function resolveSourceBinding(sourceRoot: string): Promise<SourceBinding> {
  const sourceCommit = await git(sourceRoot, ['rev-parse', 'HEAD']);
  const treeDigest = await git(sourceRoot, ['rev-parse', 'HEAD^{tree}']);
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit) || !/^[0-9a-f]{40,64}$/.test(treeDigest)) {
    throw gitError('unexpected rev-parse output', `${sourceCommit} ${treeDigest}`);
  }
  return { sourceCommit, treeDigest };
}

/** The exact bytes of a source root's HEAD tree, as a tar archive. */
export async function archiveSource(sourceRoot: string): Promise<Buffer> {
  try {
    // `encoding: 'buffer'` keeps the archive bytes intact; the default string
    // decoding would corrupt them before they ever reach the sandbox.
    const { stdout } = await execFileAsync('git', ['-C', sourceRoot, 'archive', '--format=tar', 'HEAD'], {
      encoding: 'buffer',
      maxBuffer: 512 * 1024 * 1024,
    });
    // promisify's signature types stdout as string; with `encoding: 'buffer'`
    // the runtime value is the raw Buffer we need.
    return stdout as unknown as Buffer;
  } catch (error) {
    throw gitError('git archive HEAD', error);
  }
}

/** Sorted list of file paths the archive writes (blobs in the HEAD tree). */
async function archivedFilePaths(sourceRoot: string): Promise<string[]> {
  const output = await git(sourceRoot, ['ls-tree', '-r', '--name-only', 'HEAD']);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/**
 * Wrap a runtime so every launch is bound to the exact source of
 * `options.sourceRoot` before the handle is returned.
 *
 * The wrapper owns only provisioning; `exec`/`uploadFile`/`getHomeDir`/
 * `destroy` pass straight through to the underlying runtime.
 */
export function createSourceBoundSandboxRuntime(
  runtime: SandboxWorkflowRuntime,
  options: SourceBoundRuntimeOptions
): SandboxWorkflowRuntime {
  const { sourceRoot } = options;

  async function syncSource(
    handle: SandboxRuntimeHandle,
    homeDir: string,
    binding: SourceBinding,
    archive: Buffer
  ): Promise<string> {
    const tarPath = `${homeDir}/.relayflows-source.tar`;
    const workdir = `${homeDir}/${SOURCE_WORKDIR_NAME}`;

    await runtime.uploadFile(handle, archive, tarPath);

    // Transport integrity: the uploaded bytes must be the archived bytes.
    const expectedSha = createHash('sha256').update(archive).digest('hex');
    const shaResult = await runtime.exec(
      handle,
      `sha256sum ${tarPath} | cut -d ' ' -f1`,
      { timeoutMs: SYNC_EXEC_TIMEOUT_MS }
    );
    if (shaResult.exitCode !== 0 || shaResult.output.trim() !== expectedSha) {
      throw new Error(
        `Sandbox source sync failed: uploaded archive digest mismatch for sandbox "${handle.id}" ` +
          `(expected ${expectedSha}, got ${shaResult.output.trim() || `exit ${shaResult.exitCode}`}); refusing an unsynced sandbox.`
      );
    }

    // Extraction into the workdir every step will run against.
    const extract = await runtime.exec(
      handle,
      `mkdir -p ${workdir} && tar -xf ${tarPath} -C ${workdir}`,
      { timeoutMs: SYNC_EXEC_TIMEOUT_MS }
    );
    if (extract.exitCode !== 0) {
      throw new Error(
        `Sandbox source sync failed: extracting the source archive into "${workdir}" in sandbox "${handle.id}" ` +
          `exited ${extract.exitCode}: ${extract.output.slice(0, 500)}`
      );
    }

    // Exactness: the extracted file set must equal the committed file set.
    const expected = await archivedFilePaths(sourceRoot);
    const listing = await runtime.exec(
      handle,
      `cd ${workdir} && find . \\( -type f -o -type l \\) | sed 's|^\\./||' | sort`,
      { timeoutMs: SYNC_EXEC_TIMEOUT_MS }
    );
    if (listing.exitCode !== 0) {
      throw new Error(
        `Sandbox source sync failed: verifying the extracted file set in sandbox "${handle.id}" ` +
          `exited ${listing.exitCode}: ${listing.output.slice(0, 500)}`
      );
    }
    const actual = listing.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (actual.length !== expected.length || actual.some((p, i) => p !== expected[i])) {
      throw new Error(
        `Sandbox source sync failed: extracted file set in sandbox "${handle.id}" does not match the committed tree ` +
          `${binding.treeDigest} (${actual.length} files extracted, ${expected.length} committed); refusing an unsynced sandbox.`
      );
    }

    return workdir;
  }

  return {
    id: runtime.id,

    async launch(launchOptions: SandboxLaunchOptions = {}): Promise<SandboxRuntimeHandle> {
      const binding = await resolveSourceBinding(sourceRoot);
      const archive = await archiveSource(sourceRoot);

      const labels: Record<string, string> = {
        ...(launchOptions.labels ?? {}),
        [SOURCE_COMMIT_LABEL]: binding.sourceCommit,
        [TREE_DIGEST_LABEL]: binding.treeDigest,
      };
      const handle = await runtime.launch({ ...launchOptions, labels });
      const homeDir = handle.homeDir ?? (await runtime.getHomeDir(handle));

      const workdir = await syncSource(handle, homeDir, binding, archive);

      return {
        ...handle,
        homeDir,
        workdir,
        sourceCommit: binding.sourceCommit,
        treeDigest: binding.treeDigest,
      };
    },

    async exec(
      handle: SandboxRuntimeHandle,
      command: string,
      execOptions?: SandboxExecOptions
    ): Promise<SandboxExecResult> {
      return runtime.exec(handle, command, execOptions);
    },

    async uploadFile(
      handle: SandboxRuntimeHandle,
      source: string | Buffer,
      destination: string
    ): Promise<void> {
      return runtime.uploadFile(handle, source, destination);
    },

    async getHomeDir(handle: SandboxRuntimeHandle): Promise<string> {
      return runtime.getHomeDir(handle);
    },

    async destroy(handle: SandboxRuntimeHandle): Promise<void> {
      return runtime.destroy(handle);
    },
  };
}
