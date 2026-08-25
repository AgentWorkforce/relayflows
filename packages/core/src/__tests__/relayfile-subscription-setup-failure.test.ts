/**
 * A Relayfile subscription that fails to SET UP must fail its waiter, not the
 * process.
 *
 * This is the defect that ended two ~2-hour runs on 2026-08-24/25, and the
 * reason a `try/catch` around the caller could never have fixed it.
 *
 * `RelayFileClient.subscribe` is synchronous and returns a Subscription, but it
 * starts its own setup internally and keeps the promise in a closure:
 *
 *   subscribe(globs, onChange, options) {
 *     const setup = this.resolveWorkspaceId(options?.aclToken).then(...)
 *     return { async unsubscribe() { ... } }
 *   }
 *
 * When `resolveWorkspaceId` throws — a Relayfile token refreshed without a
 * `workspace_id` claim — `setup` rejects with nothing attached to it while
 * `subscribe` returns normally. The caller's try/catch sees no throw, the await
 * chain never sees a rejection, and Node kills the process on the unhandled
 * rejection instead.
 *
 * Which is exactly why the two failure modes of the same call site diverged:
 *   TIMEOUT -> rejected through the await chain -> caught -> run lived
 *   SETUP FAILURE -> detached rejection -> process died
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../runner.js';

const JWT_ERROR = 'RelayFile proactive-runtime APIs require a workspace-scoped JWT with a workspace_id claim.';

type RunnerInternals = {
  waitForRelayfileEvent(subscription: unknown, timeoutMs?: number, predicate?: unknown): Promise<unknown>;
  resolveRelayfileRuntimeConfigForUse(...args: unknown[]): Promise<unknown>;
  getRelayfileClient(): unknown;
  ensureRelayfileEventStream(...args: unknown[]): Promise<void>;
  relayfileEventWaiters: unknown[];
  log(message: string): void;
};

const SUBSCRIPTION = {
  name: 'slack-human-answer',
  paths: ['/slack/channels/C0B9Z4CLG1J/**'],
  events: ['file.created', 'file.updated'],
};

/**
 * Stand-in for the SDK's real shape: synchronous return, detached rejecting
 * setup promise. Reproducing the shape is the whole point — a stub that simply
 * threw would be caught by the existing try/catch and would prove nothing.
 */
function clientWithFailingSetup(): { subscribe: () => { unsubscribe: () => Promise<void> } } {
  return {
    subscribe() {
      const setup = Promise.reject(new Error(JWT_ERROR));
      return {
        async unsubscribe() {
          await setup;
        },
      };
    },
  };
}

function stubRelayfile(runner: WorkflowRunner, client: unknown): RunnerInternals {
  const r = runner as unknown as RunnerInternals;
  vi.spyOn(r, 'log').mockImplementation(() => undefined);
  vi.spyOn(r, 'resolveRelayfileRuntimeConfigForUse').mockResolvedValue({
    baseUrl: 'https://file.example.com',
    workspaceId: 'rw_test',
    token: 'test-token',
  });
  vi.spyOn(r, 'getRelayfileClient').mockReturnValue(client);
  vi.spyOn(r, 'ensureRelayfileEventStream').mockResolvedValue(undefined);
  return r;
}

async function settleEventLoop(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitForRelayfileEvent when the subscription cannot be set up', () => {
  it('converts the detached rejection into the waiter\'s own failure', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = stubRelayfile(runner, clientWithFailingSetup());

    // Node crashes on an unhandled rejection only when NOTHING is listening, so
    // "no listener saw it" is not the signal here — an observer registered by
    // this test would itself suppress the crash and prove nothing. The signal
    // is that the failure came back through the await chain, where the callers
    // above already handle it, instead of staying detached in the SDK closure.
    await expect(r.waitForRelayfileEvent(SUBSCRIPTION, 30_000)).rejects.toThrow(/workspace_id claim/);
    await settleEventLoop();
  });

  it('has a listener installed for the whole time it is waiting', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    let duringWait = 0;
    const client = {
      subscribe() {
        duringWait = process.listenerCount('unhandledRejection');
        return { async unsubscribe() {} };
      },
    };
    const r = stubRelayfile(runner, client);
    const before = process.listenerCount('unhandledRejection');

    await expect(r.waitForRelayfileEvent(SUBSCRIPTION, 40)).rejects.toThrow(/Timed out/);

    // Registered before subscribe() can fail, and gone again afterwards.
    expect(duringWait).toBe(before + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });

  it('does not sit on its full timeout waiting for a subscription that never started', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = stubRelayfile(runner, clientWithFailingSetup());

    const started = Date.now();
    await expect(r.waitForRelayfileEvent(SUBSCRIPTION, 3_600_000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('deregisters its waiter and its listener once it has failed', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = stubRelayfile(runner, clientWithFailingSetup());

    const listenersBefore = process.listenerCount('unhandledRejection');
    await expect(r.waitForRelayfileEvent(SUBSCRIPTION, 30_000)).rejects.toThrow();

    expect(r.relayfileEventWaiters).toHaveLength(0);
    expect(process.listenerCount('unhandledRejection')).toBe(listenersBefore);
  });

  it('leaves unrelated unhandled rejections alone', async () => {
    // The interception is narrow on purpose. An unrelated bug must still crash
    // the process the way it always did, or this guard becomes a place for
    // real failures to disappear.
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const client = {
      subscribe() {
        void Promise.reject(new Error('something else entirely'));
        return { async unsubscribe() {} };
      },
    };
    const r = stubRelayfile(runner, client);

    const rethrown: unknown[] = [];
    const onException = (err: unknown) => rethrown.push(err);
    process.on('uncaughtException', onException);

    try {
      // 40ms budget: the wait times out normally; the point is what happened to
      // the unrelated rejection meanwhile.
      await expect(r.waitForRelayfileEvent(SUBSCRIPTION, 40)).rejects.toThrow(/Timed out/);
      await settleEventLoop();

      expect(rethrown).toHaveLength(1);
      expect((rethrown[0] as Error).message).toBe('something else entirely');
    } finally {
      process.off('uncaughtException', onException);
    }
  });
});
