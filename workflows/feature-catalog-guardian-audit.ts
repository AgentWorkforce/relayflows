/**
 * Reusable feature-catalog, executable-runbook, and proactive-guardian audit.
 *
 * Run from a target repository:
 *   relayflows run ../relayflows/workflows/feature-catalog-guardian-audit.ts
 *
 * Run from anywhere, including several repositories in one invocation:
 *   FEATURE_AUDIT_TARGET=/path/to/repo relayflows run workflows/feature-catalog-guardian-audit.ts
 *   FEATURE_AUDIT_TARGETS=/repo/one,/repo/two relayflows run workflows/feature-catalog-guardian-audit.ts
 *
 * Optional controls:
 *   FEATURE_AUDIT_REFERENCE_REPO=/path/to/relay
 *   FEATURE_AUDIT_REFERENCE_REF=origin/chore/audit-feature-manifest
 *   FEATURE_AUDIT_VERIFY_COMMAND='npm run build && npm test'
 *   FEATURE_AUDIT_GUARDIAN=0            # catalog/runbook audit only
 *
 * The workflow never commits, pushes, merges, resets, cleans, or deletes user
 * work. It records evidence below each target's .workflow-artifacts directory.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { workflow, type WorkflowBuilder } from '@relayflows/core'

const WORKFLOW_REPOSITORY = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

export interface FeatureAuditWorkflowOptions {
  targets?: string[]
  referenceRepo?: string
  referenceRef?: string
  guardian?: boolean
  maxConcurrency?: number
}

interface ProjectTarget {
  id: string
  pathName: string
  target: string
  artifacts: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function projectId(target: string, index: number): string {
  const base = path.basename(target).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  return `${base || 'repository'}-${index + 1}`
}

export function resolveFeatureAuditTargets(env = process.env): string[] {
  const raw = env.FEATURE_AUDIT_TARGETS ?? env.FEATURE_AUDIT_TARGET ?? process.cwd()
  const targets = raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry))
  return [...new Set(targets)]
}

function projectGateCommand(project: ProjectTarget, phase: string, strict: boolean): string {
  return `set -uo pipefail
TARGET=${shellQuote(project.target)}
ART=${shellQuote(project.artifacts)}
PHASE=${shellQuote(phase)}
mkdir -p "$ART"
LOG="$ART/$PHASE-gates.log"
SUMMARY="$ART/$PHASE-gates.tsv"
: > "$LOG"
: > "$SUMMARY"
FAIL=0
RUN=0

record() {
  status="$1"
  name="$2"
  printf '%s\\t%s\\n' "$status" "$name" | tee -a "$SUMMARY"
}

run_gate() {
  name="$1"
  shift
  RUN=$((RUN + 1))
  {
    echo "===== $name ====="
    "$@"
  } >> "$LOG" 2>&1
  status=$?
  if [ "$status" = "0" ]; then
    record PASS "$name"
  else
    record FAIL "$name"
    FAIL=$((FAIL + 1))
  fi
}

cd "$TARGET" || exit 1
run_gate "git diff --check" git diff --check
# A formatting-only check is necessary but is not sufficient verification.
RUN=0

CUSTOM=$(printenv FEATURE_AUDIT_VERIFY_COMMAND 2>/dev/null || true)
if [ -n "$CUSTOM" ]; then
  run_gate "custom verification command" sh -lc "$CUSTOM"
else
  if [ -f package.json ]; then
    PM=npm
    if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then PM=pnpm; fi
    if [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then PM=yarn; fi
    for script in build typecheck featuremap:check test verify:e2e; do
      if node -e 'const p=require("./package.json");process.exit(p.scripts?.[process.argv[1]]?0:1)' "$script"; then
        run_gate "$PM run $script" "$PM" run "$script"
      else
        record SKIP "$script (script not declared)"
      fi
    done
  fi
  if [ -f Cargo.toml ] && command -v cargo >/dev/null 2>&1; then
    run_gate "cargo test --workspace" cargo test --workspace
  fi
  if [ -f go.mod ] && command -v go >/dev/null 2>&1; then
    run_gate "go test ./..." go test ./...
  fi
  if { [ -f pyproject.toml ] || [ -f pytest.ini ] || [ -f setup.cfg ] || [ -f tox.ini ]; } && \
      command -v python >/dev/null 2>&1 && python -c 'import pytest' >/dev/null 2>&1; then
    run_gate "python -m pytest" python -m pytest
  fi
fi

echo "Gate phase: $PHASE"
echo "Commands run: $RUN"
echo "Failures: $FAIL"
cat "$SUMMARY"
if [ "$FAIL" = "0" ] && [ "$RUN" -gt 0 ]; then
  echo "${phase.toUpperCase().replaceAll('-', '_')}_GATES_PASS"
  exit 0
fi
echo "${phase.toUpperCase().replaceAll('-', '_')}_GATES_FAIL"
${strict ? 'exit 1' : 'exit 0'}
`
}

export function buildFeatureCatalogGuardianAuditWorkflow(
  options: FeatureAuditWorkflowOptions = {},
): WorkflowBuilder {
  const targets = (options.targets ?? resolveFeatureAuditTargets()).map((target) => path.resolve(target))
  if (targets.length === 0) throw new Error('At least one feature-audit target is required')

  const referenceRepo = path.resolve(
    options.referenceRepo ??
      process.env.FEATURE_AUDIT_REFERENCE_REPO ??
      path.resolve(WORKFLOW_REPOSITORY, '..', 'relay'),
  )
  const referenceRef = options.referenceRef ??
    process.env.FEATURE_AUDIT_REFERENCE_REF ??
    'origin/chore/audit-feature-manifest'
  const guardian = options.guardian ?? process.env.FEATURE_AUDIT_GUARDIAN !== '0'
  const projects: ProjectTarget[] = targets.map((target, index) => ({
    id: projectId(target, index),
    pathName: `target-${projectId(target, index)}`,
    target,
    artifacts: path.join(target, '.workflow-artifacts', 'feature-catalog-guardian-audit'),
  }))

  const wf = workflow('feature-catalog-guardian-audit')
    .description(
      'Audits actual product surfaces against a v1.1 feature catalog, makes every feature executable end to end, ' +
      'ports Relay-grade proactive guardian semantics, and proves the result with project-native gates.',
    )
    .pattern('dag')
    .channel('wf-feature-catalog-guardian-audit')
    .maxConcurrency(options.maxConcurrency ?? Math.min(4, Math.max(1, projects.length)))
    .timeout(14_400_000)
    .paths([
      ...projects.map((project) => ({
        name: project.pathName,
        path: project.target,
        description: `Feature audit target ${project.id}`,
        required: true,
      })),
      {
        name: 'relay-reference',
        path: referenceRepo,
        description: 'Relay feature-manifest, runbook, workflow, and proactive-guardian reference',
        required: true,
      },
    ])
    .repairable({ maxRetries: 1, retryDelayMs: 5_000, onExhaustion: 'fail' })

  wf.step('acceptance-contract', {
    type: 'deterministic',
    captureOutput: true,
    command: `cat <<'EOF'
FEATURE CATALOG + GUARDIAN AUDIT ACCEPTANCE CONTRACT

A1  Inventory is derived from the target's real implementation: every public CLI leaf,
    API/export, config field, provider path, durable lifecycle, safety fence, hosted path,
    observability surface, release gate, and proactive automation is considered.
A2  The authoritative manifest has unique stable IDs, exact category/feature/tier counts,
    truthful descriptions and existing source locations. It is never populated by blindly
    copying Relay product features into another product.
A3  Manifest v1.1 maps every and only every category to a named procedure. Validation rejects
    missing/unknown routes, missing headings/documents, duplicate IDs, stale totals, path escapes,
    missing locations, and public-surface omissions.
A4  Each procedure is agent-executable end to end: prerequisites, isolated setup, exact commands,
    observable positive and negative assertions, cleanup, automation limits, and PASS/FAIL/SKIP/MANUAL
    reporting. Skipped live tiers are never called passing.
A5  An agent-facing verify-features skill and critical paths explain how to select, run, diagnose,
    and clean up the complete product flow.
A6  A checked-in workflow exercises deterministic tiers and explicit opt-in live tiers. A manifest
    contract test enumerates the target's public CLI/config/export/implementation surfaces.
A7  When guardian mode is enabled, the per-repo persona matches Relay's audited operating model:
    scoped repository clone read, hourly schedule, dedicated harness/model, optional input-gated
    write-only Slack mount, exact revisioned bounded cycle state, compare-and-set transitions,
    safe manifest reconcile, criticality/tier ordering, idempotent Slack delivery, confirmed provider
    receipt, post-then-checkpoint retry safety, deadlines, and fail-closed ambiguity.
A8  Guardian tests cover clone path, persona scopes, bootstrap/checkpoint failures, retry idempotency,
    progress/cycle reset, additions/retirements/unsafe shrink, malformed or oversized state, HTTP
    404 vs auth failures, CAS conflicts/timeouts/readback, Slack error/delay/receiptless responses,
    and fallback feature surfaces.
A9  Project-native build, typecheck, catalog validation, tests, packed/release E2E, and diff checks pass.
A10 Existing user changes are preserved. No reset, clean, broad delete, commit, push, PR, or merge occurs.
A11 Final evidence states what ran, what could not run, remaining risks, and exact live/manual follow-up.
EOF`,
  })

  for (const project of projects) {
    const prefix = project.id
    const auditAgent = `${prefix}-auditor`
    const implementer = `${prefix}-catalog-engineer`
    const guardianAgent = `${prefix}-guardian-engineer`
    const verifier = `${prefix}-verifier`
    const reviewer = `${prefix}-reviewer`

    wf.agent(auditAgent, {
      cli: 'codex',
      preset: 'analyst',
      role: 'Read-only product archaeologist who proves the complete public and internal feature inventory from source',
      retries: 1,
    })
    wf.agent(implementer, {
      cli: 'codex',
      preset: 'worker',
      role: 'Feature-catalog and executable-verification engineer who repairs mappings, docs, validators, and tests',
      retries: 2,
    })
    wf.agent(guardianAgent, {
      cli: 'codex',
      preset: 'worker',
      role: 'Proactive-agent engineer who ports Relay guardian durability, delivery, persona, and test semantics',
      retries: 2,
    })
    wf.agent(verifier, {
      cli: 'codex',
      preset: 'worker',
      role: 'Evidence-driven verifier who diagnoses and repairs audit-caused failures without hiding pre-existing failures',
      retries: 2,
    })
    wf.agent(reviewer, {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Fresh-eyes reviewer for feature omissions, incorrect mappings, unsafe procedures, and guardian parity gaps',
      retries: 1,
    })

    wf.step(`${prefix}-preflight`, {
      type: 'deterministic',
      dependsOn: ['acceptance-contract'],
      captureOutput: true,
      failOnError: true,
      command: `set -euo pipefail
TARGET=${shellQuote(project.target)}
REFERENCE=${shellQuote(referenceRepo)}
ART=${shellQuote(project.artifacts)}
mkdir -p "$ART"
git -C "$TARGET" rev-parse --show-toplevel
git -C "$REFERENCE" rev-parse --show-toplevel
git -C "$TARGET" status --short | tee "$ART/preflight-status.txt"
git -C "$TARGET" log -1 --format='target_head=%H%nsubject=%s'
git -C "$REFERENCE" log -1 --format='reference_head=%H%nsubject=%s'
if git -C "$REFERENCE" rev-parse --verify ${shellQuote(referenceRef)} >/dev/null 2>&1; then
  echo "reference_ref=${referenceRef}"
else
  echo "reference_ref_fallback=working-tree"
fi
echo "guardian_mode=${guardian ? 'enabled' : 'disabled'}"
echo PREFLIGHT_PASS`,
    })

    wf.step(`${prefix}-inventory-audit`, {
      agent: auditAgent,
      cwd: project.target,
      dependsOn: [`${prefix}-preflight`],
      task: `Audit the repository in your cwd against this contract:
{{steps.acceptance-contract.output}}

The Relay reference repository is ${referenceRepo}; prefer the audited ref ${referenceRef} when it exists.
Read its manifest, procedures, verify-features skill/workflow, guardian persona/agent/tests, and manifest
contract test as a behavioral pattern—not as a product feature list. Read every applicable AGENTS.md or
repository instruction before acting.

Perform a read-only, evidence-backed inventory. Inspect git status and preserve all existing work. Enumerate:
- every public CLI leaf including help/version and aliases;
- every package/module export, SDK/API entrypoint, schema/config/env field, provider/integration path;
- core feature families, lifecycle/recovery paths, safety/destructive fences, hosted/cloud/observability paths;
- checked-in release/E2E workflows and proactive personas;
- manifest entries with stale/missing locations/descriptions/tiers and source changes since its last update.
Cross-check implementation, tests, package exports, help text, config schemas, recent git history, and current
manifest rather than trusting any one source.

Write ${project.artifacts}/inventory.md with the discovered source-of-truth surface table and
${project.artifacts}/audit.md with omissions, incorrect mappings, procedure gaps, guardian gaps, and a concrete
repair plan. Do not edit product/catalog files in this step. End exactly with INVENTORY_AUDIT_COMPLETE.`,
      verification: { type: 'output_contains', value: 'INVENTORY_AUDIT_COMPLETE' },
      timeoutMs: 1_800_000,
    })

    wf.step(`${prefix}-catalog-runbook-repair`, {
      agent: implementer,
      cwd: project.target,
      dependsOn: [`${prefix}-inventory-audit`],
      task: `Implement the target-specific catalog and executable runbook repair described in:
- ${project.artifacts}/inventory.md
- ${project.artifacts}/audit.md
- acceptance contract: {{steps.acceptance-contract.output}}

First re-check the evidence yourself. Preserve unrelated existing/user changes and never reset/clean/commit/push.
Use the target's formatting, test, and package conventions. If a feature system exists, upgrade it without
needlessly renaming stable IDs. If absent, scaffold the Relay-compatible layout under
.agentworkforce/features/ plus an agent-facing verify-features skill.

Required outcome:
1. Manifest v1.1 is authoritative, has exact computed summary counts, unique IDs, correct categories,
   truthful behavior, existing implementation locations, appropriate criticality and environment tiers.
2. verification.document and verification.categories map every and only every category to an exact named
   procedure. The validator/CLI rejects missing document/headings/routes, unknown routes, duplicates, stale
   totals, path escapes/missing paths, bad tiers, and incomplete public surfaces.
3. Procedures give an unfamiliar agent prerequisites, isolated fixture/setup, exact runnable commands,
   externally observable positive/negative assertions, bounded cleanup, automation limits, and explicit
   PASS/FAIL/SKIP/MANUAL semantics. Do not maintain a stale second list of all IDs in prose.
4. Add/update critical paths, the agent verify-features skill, project verification workflow, and README.
5. Add a target-specific manifest contract test that enumerates all public CLI leaves, config/schema fields,
   package exports, and release-sensitive implementation areas found in the inventory.

Run focused validation. Write ${project.artifacts}/catalog-repair.md with files changed, catalog totals,
commands run, unresolved live prerequisites, and risks. End exactly with CATALOG_RUNBOOK_REPAIR_COMPLETE.`,
      verification: { type: 'output_contains', value: 'CATALOG_RUNBOOK_REPAIR_COMPLETE' },
      timeoutMs: 2_400_000,
    })

    wf.step(`${prefix}-guardian-parity`, {
      agent: guardianAgent,
      cwd: project.target,
      dependsOn: [`${prefix}-catalog-runbook-repair`],
      task: guardian
        ? `Add or repair the target repository's proactive feature guardian so it matches the audited Relay
guardian at ${referenceRepo} (${referenceRef}) while using this target's actual manifest schema, repository
identity, feature surfaces, tier meanings, channel defaults, and package/test conventions.

Do not merely copy names. Infer owner/repository from the target git remote and derive the documented scoped
clone path. Preserve unrelated changes; do not commit or push. Implement and test:
- hourly schedule; dedicated low-reasoning harness/model; no shared subscription quota;
- persona GitHub scope to this one repo with feature files read-only, optional input-gated Slack with only the
  configured channel write path, and bounded workspace memory declaration;
- strict manifest parsing through the target validator where practical;
- exact versioned cycle record at one stable path, size/shape/timestamp/known-ID validation, read-back and
  compare-and-set revisions, deadlines, no fuzzy memory recall;
- bootstrap checkpoint before Slack; criticality/tier ordering; full-cycle generation reset;
- additions preserve checked IDs, one checked retirement resets safely, unchecked retirement reconciles,
  suspicious shrink/multiple retirements/read failures fail closed;
- stable per-cycle/feature idempotency key, provider-confirmed Slack timestamp, delayed receipt support,
  post-then-checkpoint retry safety, receiptless/error failure, and precise fallback content including all
  source/API/CLI/procedure surfaces;
- comprehensive tests for every case in acceptance A8 and persona/clone path assertions;
- dependency and test-runner wiring required for those tests.

If the target is the central workforce router repository, also perform every persona catalog/router/schema/docs/
generated-artifact registration required by its own instructions. Otherwise keep this a per-repository persona.
Write ${project.artifacts}/guardian-repair.md with parity evidence and focused test results. End exactly with
GUARDIAN_PARITY_COMPLETE.`
        : `Guardian mode is disabled for this run. Inspect the catalog/runbook result, write
${project.artifacts}/guardian-repair.md stating GUARDIAN_SKIPPED_BY_CONFIGURATION and why, make no guardian edits,
and end exactly with GUARDIAN_PARITY_COMPLETE.`,
      verification: { type: 'output_contains', value: 'GUARDIAN_PARITY_COMPLETE' },
      timeoutMs: 2_400_000,
    })

    wf.step(`${prefix}-initial-gates`, {
      type: 'deterministic',
      dependsOn: [`${prefix}-guardian-parity`],
      captureOutput: true,
      failOnError: false,
      timeoutMs: 3_600_000,
      command: projectGateCommand(project, 'initial', false),
    })

    wf.step(`${prefix}-test-fix`, {
      agent: verifier,
      cwd: project.target,
      dependsOn: [`${prefix}-initial-gates`],
      task: `Initial project-native gate output:
{{steps.${prefix}-initial-gates.output}}

Read the complete log at ${project.artifacts}/initial-gates.log and all audit repair reports. Diagnose every
failure. Fix failures caused by the catalog/runbook/guardian work, including invalid commands or unsafe cleanup
in docs—not just TypeScript tests. For a clearly pre-existing unrelated failure, do not expand scope silently:
record exact reproduction/evidence in ${project.artifacts}/pre-existing-failures.md and keep it visible.

Run focused tests, manifest validation, and typechecking after each repair. Then run the full applicable target
gates, including packed/release E2E when declared. Never claim a skipped live/provider/fleet/destructive tier
passed. Write ${project.artifacts}/verification.md with commands, counts, results, skipped/manual tiers, and
cleanup proof. Preserve user work and do not commit/push. End exactly with TEST_FIX_COMPLETE.`,
      verification: { type: 'output_contains', value: 'TEST_FIX_COMPLETE' },
      timeoutMs: 3_600_000,
    })

    wf.step(`${prefix}-fresh-review`, {
      agent: reviewer,
      cwd: project.target,
      dependsOn: [`${prefix}-test-fix`],
      task: `Perform a fresh, read-only review of the complete target diff and untracked additions against:
{{steps.acceptance-contract.output}}

Read ${project.artifacts}/inventory.md, audit.md, catalog-repair.md, guardian-repair.md, verification.md, the
target source/config/exports/help, and the audited Relay reference ${referenceRepo} at ${referenceRef}. Verify
that every claimed feature exists, every public surface is catalogued, counts/routes/locations are exact,
procedures are actually end-to-end and safe, skipped tiers are honest, and guardian state/delivery semantics
match Relay without retaining Relay-specific paths/names/tiers.

Look especially for false mappings, broad/destructive cleanup, fixed shared /tmp paths, stale hand-written ID
indexes, missing manifest-contract surfaces, wrong persona scope schema, fuzzy memory state, post without receipt,
checkpoint-before-post, unsafe manifest reset, dependency/test wiring gaps, and accidental edits to pre-existing
user files. Do not edit files. Write ${project.artifacts}/review.md with BLOCKING and NONBLOCKING findings plus
evidence; write an explicit BLOCKING: none when clean. End exactly with FRESH_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'FRESH_REVIEW_COMPLETE' },
      timeoutMs: 1_800_000,
    })

    wf.step(`${prefix}-review-fix`, {
      agent: implementer,
      cwd: project.target,
      dependsOn: [`${prefix}-fresh-review`],
      task: `Read ${project.artifacts}/review.md and repair every valid BLOCKING finding. Re-check NONBLOCKING
items and fix those that improve correctness without broadening scope. Do not dismiss findings without source
evidence, do not overwrite unrelated user changes, and do not commit/push. Recompute manifest counts from the
actual YAML, validate every location/route/heading, run focused catalog and guardian tests, and check the exact
persona JSON shape against the reference. Write ${project.artifacts}/review-fix.md mapping each finding to its
resolution or evidence-backed rejection. End exactly with REVIEW_FIX_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_FIX_COMPLETE' },
      timeoutMs: 2_400_000,
    })

    wf.step(`${prefix}-final-gates`, {
      type: 'deterministic',
      dependsOn: [`${prefix}-review-fix`],
      captureOutput: true,
      failOnError: false,
      timeoutMs: 3_600_000,
      command: projectGateCommand(project, 'final', false),
    })

    wf.step(`${prefix}-finalize`, {
      agent: verifier,
      cwd: project.target,
      dependsOn: [`${prefix}-final-gates`],
      task: `Final gate output:
{{steps.${prefix}-final-gates.output}}

Inspect ${project.artifacts}/final-gates.log and the current target diff. If any final gate failed, make one
last narrowly scoped repair and rerun it; do not hide, skip, or relabel failures. Verify the original preflight
status so unrelated user files were preserved. Confirm there is no commit/push/merge and no live resource left
behind by this workflow.

Write ${project.artifacts}/FINAL_REPORT.md beginning with Status: FEATURE_AUDIT_COMPLETE and including:
repository/head, inventory and final catalog totals, files
changed by this workflow, guardian parity status, exact passing commands/test counts, live tiers reported as
SKIP/MANUAL with prerequisites, cleanup proof, any pre-existing blocker, and next operator commands. Only when
all deterministic/project-native gates pass, end exactly with FEATURE_AUDIT_COMPLETE. Otherwise end with
FEATURE_AUDIT_BLOCKED and the exact failing command.`,
      verification: { type: 'output_contains', value: 'FEATURE_AUDIT_COMPLETE' },
      timeoutMs: 3_600_000,
      retries: 1,
    })

    wf.step(`${prefix}-strict-gates`, {
      type: 'deterministic',
      dependsOn: [`${prefix}-finalize`],
      captureOutput: true,
      failOnError: true,
      timeoutMs: 3_600_000,
      command: projectGateCommand(project, 'strict-final', true),
    })
  }

  wf.step('aggregate', {
    type: 'deterministic',
    dependsOn: projects.map((project) => `${project.id}-strict-gates`),
    captureOutput: true,
    failOnError: true,
    command: `set -euo pipefail
${projects.map((project) => `test -f ${shellQuote(path.join(project.artifacts, 'FINAL_REPORT.md'))}
grep -q '^Status: FEATURE_AUDIT_COMPLETE$' ${shellQuote(path.join(project.artifacts, 'FINAL_REPORT.md'))}
echo ${shellQuote(`${project.id}\t${project.target}\t${path.join(project.artifacts, 'FINAL_REPORT.md')}`)}`).join('\n')}
echo FEATURE_CATALOG_GUARDIAN_AUDIT_COMPLETE`,
  })

  return wf
}

async function main(): Promise<void> {
  for (const target of resolveFeatureAuditTargets()) {
    if (!existsSync(target)) throw new Error(`Feature audit target does not exist: ${target}`)
  }
  const result = await buildFeatureCatalogGuardianAuditWorkflow().run({ cwd: WORKFLOW_REPOSITORY })
  console.log(`Feature catalog guardian audit: ${result.status}`)
  if (result.status !== 'completed') process.exitCode = 1
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
