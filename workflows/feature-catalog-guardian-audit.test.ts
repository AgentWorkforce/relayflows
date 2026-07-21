import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  buildFeatureCatalogGuardianAuditWorkflow,
  resolveFeatureAuditTargets,
} from './feature-catalog-guardian-audit.js'

describe('feature catalog guardian audit workflow', () => {
  it('resolves, trims, and deduplicates one or several target repositories', () => {
    const cwd = process.cwd()
    expect(resolveFeatureAuditTargets({ FEATURE_AUDIT_TARGET: './alpha' })).toEqual([
      path.resolve(cwd, 'alpha'),
    ])
    expect(resolveFeatureAuditTargets({
      FEATURE_AUDIT_TARGETS: './alpha, ./beta, ,./alpha',
    })).toEqual([
      path.resolve(cwd, 'alpha'),
      path.resolve(cwd, 'beta'),
    ])
  })

  it('builds isolated per-project pipelines with one shared Relay reference', () => {
    const targets = [path.resolve('/tmp/project-one'), path.resolve('/tmp/project-two')]
    const referenceRepo = path.resolve('/tmp/relay-reference')
    const config = buildFeatureCatalogGuardianAuditWorkflow({
      targets,
      referenceRepo,
      referenceRef: 'audit-ref',
      guardian: true,
      maxConcurrency: 2,
    }).toConfig()

    expect(config.name).toBe('feature-catalog-guardian-audit')
    expect(config.swarm).toMatchObject({
      pattern: 'dag',
      maxConcurrency: 2,
      channel: 'wf-feature-catalog-guardian-audit',
    })
    expect(config.paths).toEqual([
      expect.objectContaining({ name: 'target-project-one-1', path: targets[0] }),
      expect.objectContaining({ name: 'target-project-two-2', path: targets[1] }),
      expect.objectContaining({ name: 'relay-reference', path: referenceRepo }),
    ])
    expect(config.agents).toHaveLength(10)

    const steps = config.workflows?.[0]?.steps ?? []
    const names = new Set(steps.map((step) => step.name))
    for (const prefix of ['project-one-1', 'project-two-2']) {
      for (const suffix of [
        'preflight',
        'inventory-audit',
        'catalog-runbook-repair',
        'guardian-parity',
        'initial-gates',
        'test-fix',
        'fresh-review',
        'review-fix',
        'final-gates',
        'finalize',
        'strict-gates',
      ]) {
        expect(names).toContain(`${prefix}-${suffix}`)
      }
    }
    expect(names).toContain('acceptance-contract')
    expect(names).toContain('aggregate')
    expect(
      steps.find((step) => step.name === 'aggregate')?.dependsOn,
    ).toEqual(['project-one-1-strict-gates', 'project-two-2-strict-gates'])
  })

  it('turns guardian work into an explicit audited skip when disabled', () => {
    const config = buildFeatureCatalogGuardianAuditWorkflow({
      targets: [path.resolve('/tmp/project')],
      referenceRepo: path.resolve('/tmp/relay-reference'),
      guardian: false,
    }).toConfig()
    const guardianStep = config.workflows?.[0]?.steps.find(
      (step) => step.name === 'project-1-guardian-parity',
    )

    expect(guardianStep?.task).toContain('GUARDIAN_SKIPPED_BY_CONFIGURATION')
    expect(guardianStep?.verification).toEqual({
      type: 'output_contains',
      value: 'GUARDIAN_PARITY_COMPLETE',
    })
  })

  it('encodes non-destructive guardrails and strict evidence gates in every target task', () => {
    const config = buildFeatureCatalogGuardianAuditWorkflow({
      targets: [path.resolve('/tmp/project')],
      referenceRepo: path.resolve('/tmp/relay-reference'),
    }).toConfig()
    const steps = config.workflows?.[0]?.steps ?? []
    const tasks = steps.flatMap((step) => (step.task ? [step.task] : []))
    const strictGate = steps.find((step) => step.name === 'project-1-strict-gates')

    expect(tasks.join('\n')).toContain('do not commit/push')
    expect(tasks.join('\n')).toContain('Preserve unrelated')
    expect(tasks.join('\n')).toContain('provider-confirmed Slack timestamp')
    expect(tasks.join('\n')).toContain('PASS/FAIL/SKIP/MANUAL')
    expect(strictGate).toMatchObject({ type: 'deterministic', failOnError: true })
  })

  it('emits syntactically valid deterministic scripts and executes a custom strict gate', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'relayflow-feature-audit-'))
    const target = path.join(root, 'target')
    const reference = path.join(root, 'reference')
    try {
      expect(spawnSync('git', ['init', target]).status).toBe(0)
      expect(spawnSync('git', ['init', reference]).status).toBe(0)
      const config = buildFeatureCatalogGuardianAuditWorkflow({
        targets: [target],
        referenceRepo: reference,
      }).toConfig()
      const steps = config.workflows?.[0]?.steps ?? []
      for (const step of steps.filter((candidate) => candidate.type === 'deterministic')) {
        const syntax = spawnSync('bash', ['-n'], { input: step.command, encoding: 'utf8' })
        expect(syntax.status, `${step.name}: ${syntax.stderr}`).toBe(0)
      }

      const strictGate = steps.find((step) => step.name === 'target-1-strict-gates')
      const run = spawnSync('bash', ['-c', strictGate?.command ?? 'exit 99'], {
        cwd: target,
        encoding: 'utf8',
        env: { ...process.env, FEATURE_AUDIT_VERIFY_COMMAND: 'true' },
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toContain('STRICT_FINAL_GATES_PASS')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
