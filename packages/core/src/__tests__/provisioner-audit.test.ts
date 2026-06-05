import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { createLocalJwksKeyPair, getDefaultPermissionAuditPath } from '@agent-relay/cloud';
import { provisionWorkflowAgents } from '../provisioner.js';

async function createWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-provisioner-audit-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'index.ts'), 'export const value = 1;\n');

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('provisionWorkflowAgents writes a permission audit without token values', async () => {
  const workspace = await createWorkspace();

  try {
    const result = await provisionWorkflowAgents({
      tokenSigningKey: createLocalJwksKeyPair(),
      workspace: 'audit-workspace',
      projectDir: workspace.dir,
      relayfileBaseUrl: 'http://127.0.0.1:8080',
      agents: {
        worker: {
          access: 'readonly',
        },
      },
      skipSeeding: true,
      skipMount: true,
    });

    const auditPath = getDefaultPermissionAuditPath(workspace.dir);
    const auditRaw = await readFile(auditPath, 'utf8');
    const auditJson = JSON.parse(auditRaw) as {
      entries: Array<{
        agentName: string;
        action: string;
        details: Record<string, unknown>;
      }>;
    };

    expect(auditJson.entries.length).toBeGreaterThanOrEqual(3);
    expect(auditJson.entries.map((entry) => `${entry.agentName}:${entry.action}`)).toEqual([
      'worker:resolve',
      'worker:mint',
      'relay-admin:mint',
    ]);
    expect(auditJson.entries[1]?.details.jwtPath).toBe(
      path.join(workspace.dir, '.relay', 'tokens', 'worker.jwt')
    );
    expect(auditRaw.includes(result.agents.worker.token)).toBe(false);
    expect(auditRaw.includes(result.adminToken)).toBe(false);
  } finally {
    await workspace.cleanup();
  }
});
