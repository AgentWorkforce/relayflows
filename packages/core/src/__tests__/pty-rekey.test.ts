/**
 * The broker can assign an agent a different name than the one we asked for.
 * Re-keying the PTY maps to that name is one critical section with an
 * unavoidable `await` in it — the old log stream must be closed before its file
 * can be renamed — and a `worker_stream` for the old name can arrive inside
 * that window. These tests hold that window open deliberately and assert that
 * nothing addressed to the old name is lost.
 */
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkflowRunner, type WorkflowDb } from '../runner.js';
import type { WorkflowRunRow, WorkflowStep, WorkflowStepRow } from '../types.js';

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();
  return {
    insertRun: vi.fn(async (run) => runs.set(run.id, { ...run })),
    updateRun: vi.fn(async (id, patch) => {
      const run = runs.get(id);
      if (run) runs.set(id, { ...run, ...patch });
    }),
    getRun: vi.fn(async (id) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step) => steps.set(step.id, { ...step })),
    updateStep: vi.fn(async (id, patch) => {
      const step = steps.get(id);
      if (step) steps.set(id, { ...step, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId) =>
      [...steps.values()].filter((s) => s.runId === runId).map((s) => ({ ...s }))
    ),
  };
}

const step: WorkflowStep = { name: 'worker', type: 'agent', agent: 'a', task: 't' };

describe('PTY re-key when the broker renames an agent', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const logsDir = mkdtempSync(path.join(os.tmpdir(), 'relayflows-pty-rekey-'));
    tempDirs.push(logsDir);
    const runner = new WorkflowRunner({ db: makeDb(), cwd: logsDir, workspaceId: 'ws-test' }) as any;

    const oldLogPath = path.join(logsDir, 'old-name.log');
    writeFileSync(oldLogPath, 'before\n');
    runner.ptyOutputBuffers.set('old-name', ['before\n']);
    runner.ptyLogStreams.set('old-name', createWriteStream(oldLogPath, { flags: 'a' }));
    runner.ptyListeners.set('old-name', () => {
      throw new Error('the pre-rekey listener must be replaced, not invoked');
    });

    return { runner, logsDir };
  }

  async function flush(runner: any, name: string) {
    await new Promise<void>((resolve) => runner.ptyLogStreams.get(name)?.end(resolve));
  }

  it('captures a chunk that arrives for the old name during the await window', async () => {
    const { runner, logsDir } = setup();
    const seen: string[] = [];

    // Do NOT await: this leaves the critical section suspended on the log
    // stream close, which is exactly the window the race lives in.
    const rekey = runner.rekeyPtyStreams({
      oldName: 'old-name',
      newName: 'new-name',
      logsDir,
      step,
      humanAssistanceConfig: undefined,
      onChunk: (info: { agentName: string; chunk: string }) => seen.push(`${info.agentName}:${info.chunk}`),
    });

    const inFlight = runner.ptyListeners.get('old-name');
    expect(inFlight, 'the old name must still route somewhere mid-swap').toBeTypeOf('function');
    inFlight('during\n');

    await rekey;
    await flush(runner, 'new-name');

    // The chunk reached the buffer, under the new name.
    expect(runner.ptyOutputBuffers.get('new-name')).toContain('during\n');
    expect(runner.ptyOutputBuffers.has('old-name')).toBe(false);
    // It was parked while no stream existed, then written to the renamed file.
    expect(readFileSync(path.join(logsDir, 'new-name.log'), 'utf8')).toBe('before\nduring\n');
    // And it was reported to the caller as the new agent.
    expect(seen).toEqual(['new-name:during\n']);
    // The old key is retired only once the swap is complete.
    expect(runner.ptyListeners.has('old-name')).toBe(false);
    expect(runner.ptyListeners.has('new-name')).toBe(true);
  });

  it('keeps the earlier buffer contents and routes chunks after the swap', async () => {
    const { runner, logsDir } = setup();

    await runner.rekeyPtyStreams({
      oldName: 'old-name',
      newName: 'new-name',
      logsDir,
      step,
      humanAssistanceConfig: undefined,
    });

    runner.ptyListeners.get('new-name')('after\n');
    await flush(runner, 'new-name');

    expect(runner.ptyOutputBuffers.get('new-name')).toEqual(['before\n', 'after\n']);
    expect(readFileSync(path.join(logsDir, 'new-name.log'), 'utf8')).toBe('before\nafter\n');
  });
});
