import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildPersonaSpawnPlan,
  executePersonaSpawnPlan,
  type ExecutionHandle,
  type PersonaSpawnPlan,
} from '@agentworkforce/persona-kit';
import { resolvePersonaReference, type ResolvedPersonaReference } from '@agentworkforce/persona-registry';

export interface ResolvedWorkflowPersona {
  readonly resolved: ResolvedPersonaReference;
  readonly plan: PersonaSpawnPlan;
  readonly args: string[];
  readonly cli: string;
  readonly model: string;
  readonly env: Record<string, string>;
}

export interface ActiveWorkflowPersona extends ResolvedWorkflowPersona {
  readonly cwd: string;
  dispose(): Promise<void>;
}

/** Resolve through the same cwd/personal/configured/built-in registry as the Workforce CLI. */
export function resolveWorkflowPersona(reference: string, cwd: string): ResolvedWorkflowPersona {
  const resolved = resolvePersonaReference(reference, { cwd });
  const built = buildPersonaSpawnPlan(resolved.selection);
  // Relayflow persona launches are always isolated. An empty mount policy is
  // still materialized so installed skills and generated sidecars never write
  // into the real workflow checkout.
  const plan: PersonaSpawnPlan = built.mount
    ? built
    : { ...built, mount: { ignoredPatterns: [], readonlyPatterns: [] } };
  const args = plan.initialPrompt ? [...plan.args, plan.initialPrompt] : [...plan.args];
  return {
    resolved,
    plan,
    args,
    cli: plan.cli,
    model: resolved.selection.model,
    env: { ...plan.env },
  };
}

/** Install skills/materialize config in an isolated mount for one workflow launch. */
export async function activateWorkflowPersona(
  persona: ResolvedWorkflowPersona,
  cwd: string
): Promise<ActiveWorkflowPersona> {
  const scratchDir = await mkdtemp(path.join(tmpdir(), 'relayflow-persona-'));
  let execution: ExecutionHandle | undefined;
  try {
    execution = await executePersonaSpawnPlan(persona.plan, {
      cwd,
      mount: { mountDir: scratchDir, includeGit: true, autoSync: true },
    });
    let disposed = false;
    return {
      ...persona,
      cwd: execution.cwd,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await execution?.dispose();
        await rm(scratchDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await execution?.dispose();
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}
