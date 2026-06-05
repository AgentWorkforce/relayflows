/**
 * Thin adapter over the harness-driver's `SpawnedAgentHandle`.
 *
 * The driver (`@agent-relay/harness-driver` ≥ 8.2) owns the real lifecycle
 * logic — event subscription, replay-correct exit/idle resolution, exit
 * code/signal capture. This wrapper only maps its structured results
 * (`{ reason, code, signal }` / `{ reason, idleSecs }`) back to the simple
 * string contract the workflow runner has always used (`'exited'` / `'timeout'`
 * / `'idle'`), so `runner.ts` keeps consuming handles unchanged.
 */
import type { SpawnedAgentHandle } from '@agent-relay/harness-driver';

export class WorkflowAgentHandle {
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

  /** Resolves `'exited'` when the agent exits, or `'timeout'` after `timeoutMs`. */
  async waitForExit(timeoutMs?: number): Promise<'exited' | 'timeout'> {
    const { reason } = await this.inner.waitForExit(timeoutMs);
    return reason;
  }

  /** Resolves `'idle'` on the next idle signal, `'exited'` if it exits first, or `'timeout'`. */
  async waitForIdle(timeoutMs?: number): Promise<'idle' | 'exited' | 'timeout'> {
    const { reason } = await this.inner.waitForIdle(timeoutMs);
    return reason;
  }

  release(reason?: string): Promise<{ name: string }> {
    return this.inner.release(reason);
  }
}
