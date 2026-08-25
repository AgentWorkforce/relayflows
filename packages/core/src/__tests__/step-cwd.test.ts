import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('@agent-relay/harness-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/harness-driver')>();
  return {
    ...actual,
    HarnessDriverClient: {
      spawn: vi.fn(async () => ({
        spawnPty: vi.fn(),
        onEvent: vi.fn(() => () => {}),
        connectEvents: vi.fn(),
        listAgents: vi.fn().mockResolvedValue([]),
        release: vi.fn().mockResolvedValue({ name: '' }),
        sendMessage: vi.fn().mockResolvedValue({ event_id: 'evt', targets: [] }),
        shutdown: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

const { WorkflowRunner } = await import('../runner.js');

describe('WorkflowRunner step cwd resolution', () => {
  const config = (cwdResolution?: 'workflow-file' | 'process') => ({
    version: '1',
    name: 'cwd-resolution',
    ...(cwdResolution ? { cwdResolution } : {}),
    swarm: { pattern: 'dag' as const },
    agents: [{ name: 'worker', cli: 'claude' as const, cwd: '../agent-workspace' }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'generate',
            agent: 'worker',
            task: 'Generate',
            cwd: '../step-workspace',
          },
        ],
      },
    ],
  });

  it('prefers step.cwd over agent.cwd and runner cwd', () => {
    const runnerRoot = '/runner-root';
    const runner = new WorkflowRunner({ cwd: runnerRoot });

    const resolved = (runner as any).resolveEffectiveCwd(
      { name: 'generate', agent: 'worker', task: 'Generate', cwd: 'steps/generate' },
      { name: 'worker', cli: 'claude', cwd: 'agents/worker' },
    );

    expect(resolved).toBe(path.resolve(runnerRoot, 'steps/generate'));
  });

  it('respects step.cwd for deterministic steps', () => {
    const runnerRoot = '/runner-root';
    const runner = new WorkflowRunner({ cwd: runnerRoot });

    const resolved = (runner as any).resolveEffectiveCwd({
      name: 'scaffold',
      type: 'deterministic',
      command: 'mkdir -p out',
      cwd: 'deterministic/setup',
    });

    expect(resolved).toBe(path.resolve(runnerRoot, 'deterministic/setup'));
  });

  it('falls back through step.cwd to step.workdir to agent.cwd to runner.cwd', () => {
    const runnerRoot = '/runner-root';
    const namedPath = '/named/workdir';
    const runner = new WorkflowRunner({ cwd: runnerRoot });
    (runner as any).resolvedPaths.set('generated', namedPath);

    const agentDef = { name: 'worker', cli: 'claude', cwd: 'agents/worker' } as const;

    expect(
      (runner as any).resolveEffectiveCwd(
        { name: 's1', agent: 'worker', task: 'Do work', cwd: 'steps/explicit', workdir: 'generated' },
        agentDef,
      ),
    ).toBe(path.resolve(runnerRoot, 'steps/explicit'));

    expect(
      (runner as any).resolveEffectiveCwd(
        { name: 's2', agent: 'worker', task: 'Do work', workdir: 'generated' },
        agentDef,
      ),
    ).toBe(namedPath);

    expect(
      (runner as any).resolveEffectiveCwd({ name: 's3', agent: 'worker', task: 'Do work' }, agentDef),
    ).toBe(path.resolve(runnerRoot, 'agents/worker'));

    expect(
      (runner as any).resolveEffectiveCwd({ name: 's4', type: 'deterministic', command: 'pwd' }),
    ).toBe(runnerRoot);
  });

  it('resolves agent and step cwd from the parsed workflow file when opted in', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'relay-cwd-resolution-'));
    const runnerRoot = path.join(root, 'process', 'project');
    const workflowDir = path.join(root, 'workflow', 'config');
    const yamlPath = path.join(workflowDir, 'relay.yaml');
    mkdirSync(runnerRoot, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      yamlPath,
      [
        'version: "1"',
        'name: cwd-resolution',
        'cwdResolution: workflow-file',
        'swarm:',
        '  pattern: dag',
        'agents:',
        '  - name: worker',
        '    cli: claude',
        '    cwd: ../agent-workspace',
        'workflows:',
        '  - name: default',
        '    steps:',
        '      - name: generate',
        '        agent: worker',
        '        task: Generate',
        '        cwd: ../step-workspace',
      ].join('\n') + '\n'
    );

    try {
      const runner = new WorkflowRunner({ cwd: runnerRoot });
      const parsed = await runner.parseYamlFile(yamlPath);
      (runner as any).configureCwdResolution(parsed);

      expect((runner as any).resolveAgentCwd(parsed.agents[0])).toBe(
        path.resolve(workflowDir, '../agent-workspace')
      );
      expect((runner as any).resolveEffectiveCwd(parsed.workflows![0].steps[0])).toBe(
        path.resolve(workflowDir, '../step-workspace')
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves process-relative agent and step cwd when explicitly configured', () => {
    const runnerRoot = '/process/project';
    const runner = new WorkflowRunner({ cwd: runnerRoot });
    (runner as any).workflowFileDir = '/workflow/config';
    (runner as any).configureCwdResolution(config('process'));

    expect((runner as any).resolveAgentCwd(config('process').agents[0])).toBe(
      path.resolve(runnerRoot, '../agent-workspace')
    );
    expect((runner as any).resolveEffectiveCwd(config('process').workflows[0].steps[0])).toBe(
      path.resolve(runnerRoot, '../step-workspace')
    );
  });

  it('warns with both paths when the default is ambiguous', () => {
    const runnerRoot = '/process/project';
    const workflowDir = '/workflow/config';
    const runner = new WorkflowRunner({ cwd: runnerRoot });
    (runner as any).workflowFileDir = workflowDir;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (runner as any).configureCwdResolution(config());

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(path.resolve(runnerRoot, '../agent-workspace'))
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(path.resolve(workflowDir, '../agent-workspace'))
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('future major'));
    warn.mockRestore();
  });
});
