/**
 * The per-agent PTY buffer used to grow without limit for the whole life of an
 * agent step, so a chatty agent's entire transcript stayed resident in the
 * orchestrator's heap. A 34-step DAG with 9 agents OOM-killed its orchestrator
 * in an 8 GB sandbox partway through (AgentWorkforce/cloud#1967, dev run
 * 71cc4995 — `bun exited with signal SIGKILL` while the parent node process
 * survived, which is the cgroup OOM-killer signature).
 *
 * Retaining a tail is safe: consumers clip to the last few thousand characters,
 * and the complete transcript is still written to the PTY log file on disk.
 */
import { describe, expect, it } from 'vitest';

import { WorkflowRunner } from '../runner.js';

type BoundedAppend = (
  agentName: string,
  buffer: string[] | undefined,
  chunk: string,
) => void;

/** Reach the private helper without widening the public surface. */
function boundedAppend(runner: WorkflowRunner): BoundedAppend {
  const fn = (runner as unknown as { appendBoundedPtyChunk: BoundedAppend })
    .appendBoundedPtyChunk;
  return fn.bind(runner) as BoundedAppend;
}

function maxChars(): number {
  return (WorkflowRunner as unknown as { MAX_PTY_BUFFER_CHARS: number })
    .MAX_PTY_BUFFER_CHARS;
}

function newRunner(): WorkflowRunner {
  return Object.create(WorkflowRunner.prototype) as WorkflowRunner;
}

function withSizes(runner: WorkflowRunner): WorkflowRunner {
  (runner as unknown as { ptyOutputBufferSizes: Map<string, number> })
    .ptyOutputBufferSizes = new Map();
  return runner;
}

describe('PTY output buffer is bounded', () => {
  it('keeps a chatty agent from growing the buffer without limit', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    const buffer: string[] = [];

    // 40 MB of output through a 1 MB cap.
    const chunk = 'x'.repeat(100_000);
    for (let i = 0; i < 400; i += 1) append('scout', buffer, chunk);

    const retained = buffer.join('').length;
    expect(retained).toBeLessThanOrEqual(maxChars());
    // Sanity: the old behaviour would have retained everything.
    expect(retained).toBeLessThan(40_000_000);
  });

  it('retains the most recent output, not the oldest', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    const buffer: string[] = [];

    append('scout', buffer, 'FIRST');
    for (let i = 0; i < 30; i += 1) append('scout', buffer, 'y'.repeat(100_000));
    append('scout', buffer, 'LAST');

    const retained = buffer.join('');
    // The tail is what every consumer reads, so it must survive.
    expect(retained.endsWith('LAST')).toBe(true);
    expect(retained).not.toContain('FIRST');
  });

  it('leaves small transcripts completely untouched', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    const buffer: string[] = [];

    append('scout', buffer, 'hello ');
    append('scout', buffer, 'world');

    expect(buffer.join('')).toBe('hello world');
  });

  it('keeps a single oversized write rather than dropping it entirely', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    const buffer: string[] = [];

    const huge = 'z'.repeat(maxChars() * 2);
    append('scout', buffer, huge);

    // One chunk bigger than the cap is still visible — silently discarding it
    // would lose the very output someone is debugging.
    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toBe(huge);
  });

  it('tracks size per agent independently', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    const scout = ['seed-scout'];
    const lead = ['seed-lead'];

    append('scout', scout, 'a'.repeat(10));
    append('lead', lead, 'b'.repeat(20));

    const sizes = (runner as unknown as { ptyOutputBufferSizes: Map<string, number> })
      .ptyOutputBufferSizes;
    expect(sizes.get('scout')).toBe(10);
    expect(sizes.get('lead')).toBe(20);
  });

  it('is a no-op when the buffer is missing', () => {
    const runner = withSizes(newRunner());
    const append = boundedAppend(runner);
    expect(() => append('gone', undefined, 'anything')).not.toThrow();
  });
});
