/**
 * A THROWING human-assistance path must leave the run alive.
 *
 * This is the sibling of human-question-wait-bound.test.ts, which covers the
 * TIMEOUT branch. One call site has two failure modes and only one of them was
 * ever tested, which is exactly how runs 3 and 4 died:
 *
 *   run 4, [87:38]  the Slack answer subscription TIMED OUT
 *                   -> "Slack human question failed: Timed out waiting ..."
 *                   -> the run lived
 *   run 4, [115:03] the same call THREW
 *                   ("RelayFile proactive-runtime APIs require a
 *                    workspace-scoped JWT with a workspace_id claim")
 *                   -> the process died, no handled outcome, 115 minutes lost
 *
 * The distinction that matters is that nothing has to await the question's
 * promise for the run to survive. A `.catch()` on a promise somebody awaits is
 * not a guard — the crash happened with one attached. So these tests never
 * await the stored promise before checking for an escape, and they watch
 * `process` for the unhandled rejection that actually kills a Node run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '../runner.js';
import type { HumanAssistanceConfig, WorkflowStep } from '../schema.js';

type RunnerInternals = {
  pendingHumanQuestions: Map<string, Promise<unknown>>;
  startHumanQuestion(
    agentName: string,
    step: WorkflowStep,
    config: HumanAssistanceConfig,
    question: string
  ): void;
  askSlackAndInjectAnswer(...args: unknown[]): Promise<void>;
  isSlackHumanAssistanceEnabled(config: HumanAssistanceConfig | undefined): boolean;
  log(message: string): void;
  postToChannel(message: string): unknown;
};

function internals(runner: WorkflowRunner): RunnerInternals {
  return runner as unknown as RunnerInternals;
}

const STEP = { name: 'repair-program-acceptance' } as WorkflowStep;
const SLACK_CONFIG: HumanAssistanceConfig = { slack: { channel: 'proj-cloud' } };

/** Collect anything that would have taken the process down. */
function watchForFatalEscape(): { escapes: unknown[]; stop: () => void } {
  const escapes: unknown[] = [];
  const onRejection = (reason: unknown) => escapes.push(reason);
  const onException = (err: unknown) => escapes.push(err);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return {
    escapes,
    stop: () => {
      process.off('unhandledRejection', onRejection);
      process.off('uncaughtException', onException);
    },
  };
}

/** Let the microtask queue drain and Node's unhandled-rejection check run. */
async function settleEventLoop(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function silence(runner: WorkflowRunner): void {
  const r = internals(runner);
  vi.spyOn(r, 'log').mockImplementation(() => undefined);
  vi.spyOn(r, 'postToChannel').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a human-assistance path that throws', () => {
  it('does not escape as an unhandled rejection when the ask rejects', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);
    silence(runner);
    vi.spyOn(r, 'isSlackHumanAssistanceEnabled').mockReturnValue(true);
    vi.spyOn(r, 'askSlackAndInjectAnswer').mockRejectedValue(
      new Error('RelayFile proactive-runtime APIs require a workspace-scoped JWT with a workspace_id claim.')
    );

    const watcher = watchForFatalEscape();
    try {
      r.startHumanQuestion('repair-program-acceptance-a96090b1', STEP, SLACK_CONFIG, 'Is D3 still binding?');
      // Deliberately do NOT await the stored promise first: a run whose step
      // moved on must survive the failure just the same.
      await settleEventLoop();
      expect(watcher.escapes).toEqual([]);
    } finally {
      watcher.stop();
    }

    // And the question is still a settled, non-rejecting result.
    await expect(r.pendingHumanQuestions.get('repair-program-acceptance-a96090b1') ?? Promise.resolve()).resolves
      .toBeUndefined();
  });

  it('does not escape when the ask throws synchronously', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);
    silence(runner);
    vi.spyOn(r, 'isSlackHumanAssistanceEnabled').mockReturnValue(true);
    // A synchronous throw is the shape `client.subscribe` produced: it happens
    // during the call, not on a later tick, so any guard that only handles a
    // returned rejected promise misses it.
    vi.spyOn(r, 'askSlackAndInjectAnswer').mockImplementation(() => {
      throw new Error('RelayFile proactive-runtime APIs require a workspace-scoped JWT with a workspace_id claim.');
    });

    const watcher = watchForFatalEscape();
    try {
      expect(() =>
        r.startHumanQuestion('repair-program-acceptance-a96090b1', STEP, SLACK_CONFIG, 'Is D3 still binding?')
      ).not.toThrow();
      await settleEventLoop();
      expect(watcher.escapes).toEqual([]);
    } finally {
      watcher.stop();
    }
  });

  it('leaves the runner able to take the next question', async () => {
    // The failure must clear its own bookkeeping. A question that fails and
    // leaves `pendingHumanQuestions` occupied silently swallows every later
    // question from that agent, which reads as "the run ignored me".
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);
    silence(runner);
    vi.spyOn(r, 'isSlackHumanAssistanceEnabled').mockReturnValue(true);
    vi.spyOn(r, 'askSlackAndInjectAnswer').mockRejectedValue(new Error('workspace-scoped JWT'));

    r.startHumanQuestion('agent-a', STEP, SLACK_CONFIG, 'first question');
    await settleEventLoop();

    expect(r.pendingHumanQuestions.has('agent-a')).toBe(false);
  });
});
