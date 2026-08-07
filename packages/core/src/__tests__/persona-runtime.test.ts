import { describe, expect, it } from 'vitest';

import { resolveWorkflowPersona } from '../persona-runtime.js';

describe('Relayflow persona runtime', () => {
  it('resolves a built-in through the Workforce registry and preserves its runtime', () => {
    const persona = resolveWorkflowPersona('persona-maker', process.cwd());

    expect(persona.resolved.spec.id).toBe('persona-maker');
    expect(persona.cli).toBeTruthy();
    expect(persona.model).toBe(persona.resolved.selection.model);
    expect(persona.plan.mount).toBeDefined();
  });
});
