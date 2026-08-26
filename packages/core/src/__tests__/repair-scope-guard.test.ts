import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeApiStepMock } = vi.hoisted(() => ({ executeApiStepMock: vi.fn() }));
vi.mock('../api-executor.js', () => ({ executeApiStep: executeApiStepMock }));

import { RepairScopeViolationError } from '../repair-protection.js';
import { WorkflowRunner } from '../runner.js';
import type { AgentDefinition, RelayYamlConfig, WorkflowStep } from '../types.js';

const fixer = (cli: 'claude' | 'api' = 'claude'): AgentDefinition => ({
  name: 'fixer',
  cli,
  role: 'implementation engineer',
  interactive: false,
});

function repairContext(
  cwd: string,
  options: {
    cli?: 'claude' | 'api';
    protectedPaths?: string[];
    command?: string;
    verification?: WorkflowStep['verification'];
  } = {}
) {
  return {
    step: {
      name: 'gate',
      type: 'deterministic',
      command: options.command ?? 'node -e "process.exit(1)"',
      repairProtection: options.protectedPaths
        ? { protectedPaths: options.protectedPaths }
        : undefined,
      verification: options.verification,
    },
    agentDef: fixer(options.cli),
    attempt: 1,
    maxRetries: 1,
    command: options.command ?? 'node -e "process.exit(1)"',
    cwd,
    error: 'gate failed',
    output: 'broken',
  };
}

describe('deterministic repair scope guard', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'relay-repair-scope-'));
    executeApiStepMock.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('allows repair to change mutable state while preserving protected bytes', async () => {
    writeFileSync(path.join(cwd, 'gate.js'), 'original gate\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(path.join(cwd, 'state.txt'), 'fixed\n');
          return 'fixed mutable state';
        }),
      },
    });

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { protectedPaths: ['gate.js'] })
    );

    expect(readFileSync(path.join(cwd, 'gate.js'), 'utf8')).toBe('original gate\n');
    expect(readFileSync(path.join(cwd, 'state.txt'), 'utf8')).toBe('fixed\n');
  });

  it('detects and restores a protected modification through the injected executor path', async () => {
    const protectedPath = path.join(cwd, 'gate.js');
    writeFileSync(protectedPath, 'original\n', { mode: 0o755 });
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(protectedPath, 'tampered\n');
          return 'changed gate';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['gate.js'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
  });

  it('detects and restores a protected deletion through the API executor path', async () => {
    const protectedPath = path.join(cwd, 'gate.py');
    writeFileSync(protectedPath, 'print("gate")\n');
    executeApiStepMock.mockImplementation(async () => {
      unlinkSync(protectedPath);
      return 'deleted gate';
    });
    const runner = new WorkflowRunner({ cwd, sandbox: { provider: 'none' } });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { cli: 'api', protectedPaths: ['gate.py'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(protectedPath, 'utf8')).toBe('print("gate")\n');
  });

  it('detects and removes a protected creation through the CLI executor path', async () => {
    const protectedPath = path.join(cwd, 'must-stay-absent.sh');
    const runner = new WorkflowRunner({ cwd, sandbox: { provider: 'none' } });
    vi.spyOn(runner as any, 'execNonInteractive').mockImplementation(async () => {
      writeFileSync(protectedPath, '#!/bin/sh\n');
      return { output: 'created file' };
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['must-stay-absent.sh'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(() => readFileSync(protectedPath)).toThrow();
  });

  it('resolves symlinks before hashing and restores a protected symlink swap', async () => {
    const protectedPath = path.join(cwd, 'gate.js');
    const aliasTarget = path.join(cwd, 'attacker.js');
    writeFileSync(protectedPath, 'original\n');
    writeFileSync(aliasTarget, 'attacker\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          unlinkSync(protectedPath);
          symlinkSync(aliasTarget, protectedPath);
          return 'swapped gate';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['gate.js'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
    expect(readFileSync(aliasTarget, 'utf8')).toBe('attacker\n');
  });

  it('checks and restores protection when the repair executor times out', async () => {
    const protectedPath = path.join(cwd, 'gate.js');
    writeFileSync(protectedPath, 'original\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(protectedPath, 'tampered before timeout\n');
          throw new Error('repair timed out');
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['gate.js'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
  });

  it('auto-protects directly invoked gate and custom verification scripts', async () => {
    const gatePath = path.join(cwd, 'gate.js');
    const verificationPath = path.join(cwd, 'verify.sh');
    writeFileSync(gatePath, 'process.exit(1)\n');
    writeFileSync(verificationPath, '#!/bin/sh\nexit 1\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(verificationPath, '#!/bin/sh\nexit 0\n');
          return 'changed verification';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, {
          command: 'node ./gate.js',
          verification: { type: 'custom', value: 'bash ./verify.sh' },
        })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(verificationPath, 'utf8')).toBe('#!/bin/sh\nexit 1\n');
  });

  it('treats a planted symlink cycle as a violation and restores the file', async () => {
    const protectedPath = path.join(cwd, 'gate.js');
    writeFileSync(protectedPath, 'original\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          unlinkSync(protectedPath);
          symlinkSync(protectedPath, protectedPath);
          return 'planted cycle';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['gate.js'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
  });

  it('restores through a real parent chain when a parent directory is swapped for a symlink', async () => {
    const subDir = path.join(cwd, 'sub');
    mkdirSync(subDir);
    const protectedPath = path.join(subDir, 'gate.js');
    writeFileSync(protectedPath, 'original\n');
    const outsideDir = path.join(cwd, 'outside');
    mkdirSync(outsideDir);
    const outsideFile = path.join(outsideDir, 'gate.js');
    writeFileSync(outsideFile, 'external\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          rmSync(subDir, { recursive: true, force: true });
          symlinkSync(outsideDir, subDir);
          return 'swapped parent for symlink';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['sub/gate.js'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(lstatSync(subDir).isDirectory()).toBe(true);
    expect(lstatSync(subDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
    expect(readFileSync(outsideFile, 'utf8')).toBe('external\n');
  });

  it('protects a script invoked through bash -c by resolving the nested command', async () => {
    const gateScript = path.join(cwd, 'gate.sh');
    writeFileSync(gateScript, 'exit 1\n', { mode: 0o755 });
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(gateScript, 'exit 0\n');
          return 'edited nested gate';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { command: "bash -c './gate.sh'" })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(gateScript, 'utf8')).toBe('exit 1\n');
  });

  it('detects a parent directory replaced by a file masking an absent protected path', async () => {
    const subDir = path.join(cwd, 'sub');
    mkdirSync(subDir);
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          rmSync(subDir, { recursive: true, force: true });
          writeFileSync(subDir, 'not a directory\n');
          return 'replaced parent with file';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['sub/output.txt'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(lstatSync(subDir).isDirectory()).toBe(true);
  });

  it('protects a script reached through cd and one loaded through source', async () => {
    const subDir = path.join(cwd, 'sub');
    mkdirSync(subDir);
    const cdGate = path.join(subDir, 'gate.js');
    writeFileSync(cdGate, 'process.exit(1)\n');
    const sourcedEnv = path.join(cwd, 'env.sh');
    writeFileSync(sourcedEnv, 'export GATE_MODE=strict\n');
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(cdGate, 'process.exit(0)\n');
          writeFileSync(sourcedEnv, 'export GATE_MODE=lenient\n');
          return 'edited gate behind cd and sourced env';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { command: 'source ./env.sh; cd sub && node gate.js' })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(cdGate, 'utf8')).toBe('process.exit(1)\n');
    expect(readFileSync(sourcedEnv, 'utf8')).toBe('export GATE_MODE=strict\n');
  });

  it('detects a parent directory swapped for a dangling symlink masking an absent path', async () => {
    const subDir = path.join(cwd, 'sub');
    mkdirSync(subDir);
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          rmSync(subDir, { recursive: true, force: true });
          symlinkSync(path.join(cwd, 'nowhere'), subDir);
          return 'replaced parent with dangling symlink';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(
        repairContext(cwd, { protectedPaths: ['sub/output.txt'] })
      )
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(lstatSync(subDir).isDirectory()).toBe(true);
  });

  it('protects a gate script literally named source', async () => {
    const gateScript = path.join(cwd, 'source');
    writeFileSync(gateScript, 'exit 1\n', { mode: 0o755 });
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(gateScript, 'exit 0\n');
          return 'edited script named source';
        }),
      },
    });

    await expect(
      (runner as any).runDeterministicRepairAgent(repairContext(cwd, { command: './source' }))
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(gateScript, 'utf8')).toBe('exit 1\n');
  });

  it('fails closed when cd sits behind a non-sequential operator', async () => {
    const subDir = path.join(cwd, 'sub');
    mkdirSync(subDir);
    writeFileSync(path.join(subDir, 'gate.js'), 'process.exit(1)\n');
    writeFileSync(path.join(cwd, 'gate.js'), 'process.exit(1)\n');
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'true || cd sub; node gate.js' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('does not mistake a JS import binding for a local module reference', async () => {
    writeFileSync(path.join(cwd, 'helper.js'), 'module.exports = 1;\n');
    const executeAgentStep = vi.fn(async () => {
      writeFileSync(path.join(cwd, 'state.txt'), 'fixed\n');
      return 'repaired mutable state';
    });
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'node -e "import helper from \'lodash\'; process.exit(1)"' })
    );

    expect(executeAgentStep).toHaveBeenCalled();
  });

  it('skips repair when a quoted side-effect import references a local extensionless module', async () => {
    writeFileSync(path.join(cwd, 'helper.js'), 'module.exports = 1;\n');
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'node --input-type=module -e "import \'./helper\'"' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('skips repair when inline python imports a local module without an extension', async () => {
    writeFileSync(path.join(cwd, 'helper.py'), 'VALUE = 1\n');
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'python3 -c "import helper"' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('skips repair when python -m targets a local package entrypoint', async () => {
    mkdirSync(path.join(cwd, 'pkg'));
    writeFileSync(path.join(cwd, 'pkg', '__main__.py'), 'raise SystemExit(1)\n');
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'python3 -m pkg' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('skips repair when inline eval references a local script it cannot inspect', async () => {
    writeFileSync(path.join(cwd, 'helper.js'), 'module.exports = 1;\n');
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'node -e "require(\'./helper.js\')"' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('skips repair loudly when indirect gate code is unresolvable and no explicit protection exists', async () => {
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({ cwd, executor: { executeAgentStep } });
    const log = vi.spyOn(runner as any, 'log');

    await (runner as any).runDeterministicRepairAgent(
      repairContext(cwd, { command: 'npm test' })
    );

    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('REPAIR PROTECTION WARNING'));
  });

  it('always protects a workflow YAML loaded from disk', async () => {
    const workflowPath = path.join(cwd, 'relay.yaml');
    writeFileSync(
      workflowPath,
      'version: "1"\nname: guarded\nswarm:\n  pattern: pipeline\nagents: []\nworkflows:\n  - name: default\n    steps:\n      - name: gate\n        type: deterministic\n        command: "false"\n'
    );
    const runner = new WorkflowRunner({
      cwd,
      executor: {
        executeAgentStep: vi.fn(async () => {
          writeFileSync(workflowPath, 'tampered: true\n');
          return 'changed workflow';
        }),
      },
    });
    await runner.parseYamlFile('relay.yaml');

    await expect(
      (runner as any).runDeterministicRepairAgent(repairContext(cwd))
    ).rejects.toBeInstanceOf(RepairScopeViolationError);
    expect(readFileSync(workflowPath, 'utf8')).toContain('name: guarded');
  });

  it('uses the same guard for an environmental gate failure and never reruns after violation', async () => {
    const protectedPath = path.join(cwd, 'gate-state.txt');
    writeFileSync(protectedPath, 'original\n');
    const executeDeterministicStep = vi.fn(async () => {
      throw new Error('environmental gate timeout');
    });
    const executeAgentStep = vi.fn(async () => {
      writeFileSync(protectedPath, 'tampered\n');
      return 'repair after environmental failure';
    });
    const runner = new WorkflowRunner({
      cwd,
      executor: { executeDeterministicStep, executeAgentStep },
    });
    const config: RelayYamlConfig = {
      version: '1',
      name: 'environmental-guard',
      swarm: { pattern: 'pipeline' },
      agents: [fixer()],
      errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1 },
      workflows: [
        {
          name: 'default',
          steps: [
            {
              name: 'gate',
              type: 'deterministic',
              command: 'node -e "process.exit(1)"',
              repairProtection: { protectedPaths: ['gate-state.txt'] },
            },
          ],
        },
      ],
      trajectories: false,
    };

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('Repair scope violation');
    expect(executeDeterministicStep).toHaveBeenCalledTimes(1);
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect(readFileSync(protectedPath, 'utf8')).toBe('original\n');
  });
});
