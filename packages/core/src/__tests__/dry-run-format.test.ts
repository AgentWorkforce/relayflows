import { describe, it, expect } from 'vitest';

import { formatDryRunReport } from '../dry-run-format.js';
import type { DryRunReport } from '../types.js';

function makeReport(overrides: Partial<DryRunReport> = {}): DryRunReport {
  return {
    valid: true,
    errors: [],
    warnings: [],
    name: 'demo',
    pattern: 'dag',
    agents: [{ name: 'builder', cli: 'claude', stepCount: 1 }],
    waves: [
      {
        wave: 1,
        steps: [
          { name: 'implement', agent: 'builder', dependsOn: [] },
          // Agent-less step => deterministic (shell/gate) step.
          { name: 'test-gate', dependsOn: ['implement'] },
        ],
      },
    ],
    totalSteps: 2,
    estimatedWaves: 1,
    ...overrides,
  };
}

describe('formatDryRunReport', () => {
  it('labels agent-less steps as deterministic, not "undefined"', () => {
    const out = formatDryRunReport(makeReport());

    expect(out).toContain('implement (builder)');
    expect(out).toContain('test-gate (deterministic)');
    // Regression guard: the literal "undefined" must never reach the plan.
    expect(out).not.toContain('(undefined)');
  });

  it('still renders the agent name when a step has one', () => {
    const out = formatDryRunReport(
      makeReport({
        waves: [{ wave: 1, steps: [{ name: 'review', agent: 'reviewer', dependsOn: [] }] }],
        totalSteps: 1,
      })
    );

    expect(out).toContain('review (reviewer)');
    expect(out).not.toContain('deterministic');
  });
});
