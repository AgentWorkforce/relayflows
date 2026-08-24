/**
 * A pending Slack human question must never outlive its budget.
 *
 * Regression for a hang observed on 2026-08-24: an agent asked a HUMAN_QUESTION,
 * its PTY was killed while the question was outstanding, and nothing was left to
 * settle the question's promise. `waitForPendingHumanQuestion` awaited it with no
 * bound, so the step deadline above it could never fire — the runner sat for 34
 * minutes producing no output, no failure, and no BLOCKED artifact. A deadline
 * checked between calls does not bound the call.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowRunner } from '../runner.js';

type RunnerInternals = {
  pendingHumanQuestions: Map<string, Promise<unknown>>;
  pendingHumanQuestionDrafts: Map<string, unknown>;
  waitForPendingHumanQuestion(agentName: string, timeoutMs?: number): Promise<boolean>;
};

function internals(runner: WorkflowRunner): RunnerInternals {
  return runner as unknown as RunnerInternals;
}

describe('waitForPendingHumanQuestion', () => {
  it('gives up when a question never settles, instead of awaiting forever', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);

    // The shape a dead agent leaves behind: a question promise with no
    // remaining producer. Anything that awaits it unbounded waits forever.
    r.pendingHumanQuestions.set('dead-agent', new Promise(() => {}));

    const started = Date.now();
    const settled = await r.waitForPendingHumanQuestion('dead-agent', 50);
    const elapsed = Date.now() - started;

    expect(settled).toBe(false);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('still reports a question that settles within its budget', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);

    r.pendingHumanQuestions.set('live-agent', Promise.resolve('answered'));

    await expect(r.waitForPendingHumanQuestion('live-agent', 5_000)).resolves.toBe(true);
  });

  it('reports false when the agent has no question pending at all', async () => {
    const runner = new WorkflowRunner({ cwd: process.cwd() });
    const r = internals(runner);

    await expect(r.waitForPendingHumanQuestion('quiet-agent', 5_000)).resolves.toBe(false);
  });
});
