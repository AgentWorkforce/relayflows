import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workflow } from '../builder.js';
import { JsonFileWorkflowDb } from '../file-db.js';
import { InMemoryWorkflowDb } from '../memory-db.js';
import { runWorkflow } from '../run.js';
import { WorkflowRunner } from '../runner.js';
import type { WorkflowRunRow } from '../types.js';

describe('workflow run persistence', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tmpDir of tmpDirs.splice(0)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('constructs runWorkflow with the cwd JSONL database', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'run-persistence-'));
    tmpDirs.push(tmpDir);
    const yamlPath = path.join(tmpDir, 'relay.yaml');
    writeFileSync(
      yamlPath,
      [
        'version: "1"',
        'name: run-persistence-test',
        'swarm:',
        '  pattern: sequential',
        'agents: []',
        'workflows:',
        '  - name: default',
        '    steps: []',
      ].join('\n')
    );
    const dryRunSpy = vi.spyOn(WorkflowRunner.prototype, 'dryRun');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runWorkflow(yamlPath, { cwd: tmpDir, dryRun: true });

    const runner = dryRunSpy.mock.instances[0] as unknown as { db: unknown };
    expect(runner.db).toBeInstanceOf(JsonFileWorkflowDb);
    expect((runner.db as JsonFileWorkflowDb).getStoragePath()).toBe(
      path.join(tmpDir, '.agent-relay', 'workflow-runs.jsonl')
    );
    expect(runner.db).not.toBeInstanceOf(InMemoryWorkflowDb);
  });

  it('honors WorkflowRunOptions.resume before executing a new run', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'builder-resume-'));
    tmpDirs.push(tmpDir);
    const resumedRun = { id: 'resume-id', status: 'completed' } as WorkflowRunRow;
    const resumeSpy = vi.spyOn(WorkflowRunner.prototype, 'resume').mockResolvedValue(resumedRun);
    const executeSpy = vi.spyOn(WorkflowRunner.prototype, 'execute').mockResolvedValue(resumedRun);

    const result = await workflow('builder-resume-test')
      .agent('agent-a', { cli: 'claude' })
      .step('step-a', { agent: 'agent-a', task: 'Do step A' })
      .run({ cwd: tmpDir, renderer: false, resume: 'resume-id' });

    expect(result).toBe(resumedRun);
    expect(resumeSpy).toHaveBeenCalledWith('resume-id', undefined);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
