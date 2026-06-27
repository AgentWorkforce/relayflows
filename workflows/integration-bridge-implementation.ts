/**
 * integration-bridge-implementation.ts
 *
 * 80-to-100 multi-repo workflow that implements the **Integration Bridge** spec
 * (relaycast/docs/integration-bridge.md): a provider-agnostic bridge that lets a
 * relay channel/agent subscribe to ANY relayfile integration — records inject as
 * channel messages, agent replies write back to the source object — driven by
 * existing SDK surfaces, no new @agent-relay package.
 *
 * Three repos, three scopes (worktrees on latest main, set up before this runs):
 *
 *   relaycast  (feat/integration-bridge-metadata)
 *     R1  triggerWebhook() persists sanitized `payload` into message.metadata
 *     R2  the slack/relayfile routing key round-trips out on message.created delivery
 *     R3  engine tests + typecheck/build green
 *     R4  docs/integration-bridge.md present in the branch
 *
 *   relay      (feat/integration-bridge-cli)  — the `agent-relay` CLI
 *     C1  `integration subscription create` exposes --filter / --url / --secret (→ SDK createSubscription)
 *     C2  `integration subscribe <provider>` orchestrator: ensure-connected (else connect),
 *         create inbound webhook + subscription, optional --spawn, bind. Wizard PROMPTS for spawn
 *         (never implicit); one-liner requires explicit --spawn.
 *     C3  `integration unsubscribe` + `integration subscribe --list` (teardown removes all 3 artifacts)
 *     C4  CLI tests + typecheck/build green
 *
 *   relayfile  (feat/integration-bridge-runtime)
 *     F1  optional `RelayBinding` hook on the adapter contract + generic semantics-aware default presenter
 *     F2  `relayfile integration bind` / `unbind` records (provider, path-glob) ⇄ (relay channel)
 *     F3  forwarder loop in packages/agents: onWrite → relay.webhooks.trigger;
 *         subscription/writeback → adapter.writeBack; with the two loop-guards
 *     F4  tests + build green
 *
 * Pattern: dag. Each repo runs implement → test-fix-rerun → verify; then a unified
 * Claude-then-Codex fresh-eyes review/fix loop over all three worktrees; then per-repo
 * deterministic acceptance + commit-if-green. Repairable gates never hard-fail — red
 * evidence becomes repair work or a BLOCKED_NO_COMMIT artifact.
 *
 * Per relay/CLAUDE.md: commits land on the existing feature branches ONLY. The
 * workflow never pushes or merges to main — the user decides when to merge.
 *
 * Usage (from the relayflows repo):
 *   agent-relay run workflows/integration-bridge-implementation.ts
 */

import { workflow } from '@relayflows/core';
import { ClaudeModels } from '@agent-relay/config';

// ── Worktrees (created on latest main before this workflow runs) ─────────────
const WT = '/Users/khaliqgant/Projects/AgentWorkforce/wt-integration-bridge';
const RELAYCAST = `${WT}/relaycast`;
const RELAY = `${WT}/relay`;
const RELAYFILE = `${WT}/relayfile`;
const ART = `${WT}/.workflow-artifacts/integration-bridge`;
const SPEC = `${RELAYCAST}/docs/integration-bridge.md`;

async function runWorkflow() {
  const result = await workflow('integration-bridge-implementation')
    .description(
      'Implement the provider-agnostic Integration Bridge across relaycast (engine ' +
        'metadata round-trip), relay (agent-relay CLI subscribe/unsubscribe), and relayfile ' +
        '(RelayBinding hook + bind + forwarder), validated end-to-end with Claude-then-Codex ' +
        'review and committed green to feature branches only.',
    )
    .pattern('dag')
    .channel('wf-integration-bridge')
    .maxConcurrency(3)
    .timeout(10_800_000) // 3h
    .paths([
      { name: 'relaycast', path: RELAYCAST, description: 'relaycast engine + SDK worktree (gap #1: metadata persistence)', required: true },
      { name: 'relay', path: RELAY, description: 'agent-relay CLI worktree (gap #2: subscription flags + subscribe verb)', required: true },
      { name: 'relayfile', path: RELAYFILE, description: 'relayfile worktree (gap #3: RelayBinding + bind + forwarder)', required: true },
    ])
    .repairable()

    // ── Agents ───────────────────────────────────────────────────────────────
    .agent('lead', { cli: 'claude', model: ClaudeModels.SONNET, role: 'Architect: reads the spec, emits the per-repo implementation contract, coordinates scopes', retries: 2 })
    .agent('impl-relaycast', { cli: 'codex', role: 'relaycast engine implementer (metadata round-trip)', retries: 2 })
    .agent('impl-relay', { cli: 'codex', role: 'agent-relay CLI implementer (subscribe/unsubscribe orchestrator + flags)', retries: 2 })
    .agent('impl-relayfile', { cli: 'codex', role: 'relayfile implementer (RelayBinding hook + bind + forwarder)', retries: 2 })
    .agent('tester', { cli: 'codex', role: 'Test author + test-fix-rerun owner across all three repos', retries: 2 })
    .agent('claude-reviewer', { cli: 'claude', model: ClaudeModels.SONNET, role: 'First-pass fresh-eyes reviewer', retries: 1, preset: 'reviewer' })
    .agent('claude-fixer', { cli: 'claude', model: ClaudeModels.SONNET, role: 'First-pass review-finding fixer', retries: 2 })
    .agent('codex-reviewer', { cli: 'codex', role: 'Second-pass fresh-eyes reviewer', retries: 1, preset: 'reviewer' })
    .agent('codex-fixer', { cli: 'codex', role: 'Second-pass review-finding fixer', retries: 2 })

    // ── Phase 0: preflight — worktrees on latest main, clean, spec present ─────
    .step('preflight', {
      type: 'deterministic',
      captureOutput: true,
      failOnError: false,
      command: `set -u
fail=0
for d in "${RELAYCAST}" "${RELAY}" "${RELAYFILE}"; do
  if ! git -C "$d" rev-parse --show-toplevel >/dev/null 2>&1; then echo "MISSING WORKTREE: $d"; fail=1; continue; fi
  br=$(git -C "$d" rev-parse --abbrev-ref HEAD)
  dirty=$(git -C "$d" status --porcelain | wc -l | tr -d ' ')
  echo "$d  branch=$br  dirty_files=$dirty  head=$(git -C "$d" log --oneline -1)"
done
test -f "${SPEC}" && echo "SPEC_PRESENT" || { echo "SPEC_MISSING: ${SPEC}"; fail=1; }
mkdir -p "${ART}"
if [ "$fail" = "0" ]; then echo PREFLIGHT_OK; else echo PREFLIGHT_NEEDS_REPAIR; fi`,
    })
    .step('repair-preflight', {
      agent: 'lead',
      dependsOn: ['preflight'],
      task: `Preflight output:
{{steps.preflight.output}}

If it ended PREFLIGHT_OK, do nothing.
If PREFLIGHT_NEEDS_REPAIR: a worktree is missing/dirty or the spec is absent. Resolve it WITHOUT touching main:
- Missing worktree → recreate with: git -C <origin-repo> worktree add <path> -b <branch> origin/main
- Dirty worktree from a prior run → inspect; only reset if the changes are this workflow's own.
- Spec missing → copy relaycast/docs/integration-bridge.md from the main relaycast checkout into ${RELAYCAST}/docs/.
Re-run the preflight checks and confirm PREFLIGHT_OK before proceeding.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 0b: emit the per-repo implementation contract ───────────────────
    .step('contract', {
      type: 'deterministic',
      dependsOn: ['repair-preflight'],
      captureOutput: true,
      failOnError: false,
      command: `cat <<'EOF'
IMPLEMENTATION_CONTRACT — full design: ${SPEC}

Universal idea: the canonical relayfile path (/<provider>/...) is the routing key.
The bridge moves (path, content) pairs between provider VFS and a relay channel,
carrying the source path in message metadata so replies map back. Slack is just
the first adapter; nothing in the bridge core is provider-specific.

relaycast  (cwd ${RELAYCAST}) — gap #1, the load-bearing fix
  R1  packages/engine/src/engine/inboundWebhook.ts: triggerWebhook() must persist a
      sanitized copy of data.payload into the inserted message's metadata, merged with
      inboundWebhookMessageMetadata(...). Use sanitizeUserMessageMetadata (messageMetadata.ts).
  R2  Prove round-trip: a webhook trigger carrying payload {relayfile:{provider,path,revision}}
      surfaces that metadata on the message.created delivery payload (buildRoutableDeliveryEvent).
  R3  engine tests + typecheck/build green (use the repo's existing harness; PGlite only if a real PG is needed).
  R4  docs/integration-bridge.md present on the branch (already copied in).

relay  (cwd ${RELAY}) — gap #2 + the end-user surface (packages/cli/src/cli/commands/integration.ts)
  C1  'integration subscription create' must expose --filter channel=<c>, --url <u>, --secret <s>,
      wired into relay.subscriptions.create (SDK already accepts filter/url/secret).
  C2  Add 'integration subscribe <provider>' orchestrator: detect connection via relayfile SDK; if not
      connected, run 'relayfile integration connect <provider>' inline (interactive) or, with --no-input,
      exit non-zero with the exact remediation. Then create the inbound webhook (relay.webhooks.createInbound),
      create the channel subscription, optionally --spawn <cli> the recipient, and record the relayfile binding.
      Flags: --resource, --to <agent|#channel>, --spawn <cli>, --events. SPAWN IS NEVER IMPLICIT — wizard prompts,
      one-liner requires --spawn; binding a missing agent without --spawn is an error with remediation.
  C3  Add 'integration unsubscribe <provider> --resource' (removes webhook + subscription + binding) and
      'integration subscribe --list'.
  C4  CLI tests + typecheck/build green.

relayfile  (cwd ${RELAYFILE}) — gap #3 (packages/sdk/typescript + packages/agents)
  F1  Add an OPTIONAL RelayBinding hook to the adapter contract: present?(WriteEvent)->{text,author?,skip?}|null
      and replyPathFor?(sourcePath)->string|null. Provide a GENERIC default (no per-provider code): a
      semantics-aware truncated summary via computeSemantics for present, and the conventional reply sub-path
      (or null = inbound-only) for replyPathFor.
  F2  Add 'relayfile integration bind <provider> <path-glob> --channel <c> [--webhook <id> --webhook-token <t>]'
      and 'unbind' that record/remove a binding.
  F3  Forwarder loop in packages/agents (same runtime as writeback.ts/connect.ts), SDK-only:
        inbound:  onWrite({pathPrefix}) -> adapter.present (or default) -> RelayCast SDK webhooks.trigger,
                  carrying payload {relayfile:{provider,path,revision}}.
        outbound: subscription delivery / writeback -> adapter.writeBack(replyPathFor(path), text).
      Loop-guards: inbound skip delete/non-message/bot/self & our own writeback; outbound skip messages whose
      metadata.__relaycast_origin === 'inbound_webhook' (the ones we injected).
  F4  tests + build green.

Acceptance is per-repo and evidence-based. Commit ONLY to the existing feature branch in each worktree.
NEVER push or merge to main. If a scope can't go green, write ${ART}/<repo>-BLOCKED_NO_COMMIT.md with exact evidence.
EOF`,
    })
    .step('plan', {
      agent: 'lead',
      dependsOn: ['contract'],
      task: `Read the full spec at ${SPEC} and the contract below. Produce a concise per-repo plan
(files to touch, the exact symbols, the test you'll write to prove each R/C/F item). Write it to
${ART}/plan.md. End with PLAN_COMPLETE.

Contract:
{{steps.contract.output}}`,
      retries: 2,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ── Phase 1: per-repo implementation (3 scopes, parallel) ─────────────────
    .step('impl-relaycast', {
      agent: 'impl-relaycast',
      cwd: RELAYCAST,
      dependsOn: ['plan'],
      task: `cwd is the relaycast worktree (branch feat/integration-bridge-metadata).
Implement R1–R4 from the contract and ${ART}/plan.md. The core change is small and generic:
persist sanitized data.payload into the inserted message's metadata in triggerWebhook()
(packages/engine/src/engine/inboundWebhook.ts), reusing sanitizeUserMessageMetadata.
Do NOT change delivery shape — message.created already includes metadata. Keep it provider-agnostic.
Write a self-review note to ${ART}/relaycast-impl.md (files changed, why, risks).`,
      verification: { type: 'exit_code' },
    })
    .step('impl-relay', {
      agent: 'impl-relay',
      cwd: RELAY,
      dependsOn: ['plan'],
      task: `cwd is the relay worktree (branch feat/integration-bridge-cli) — the agent-relay CLI.
Implement C1–C4 in packages/cli/src/cli/commands/integration.ts (and helpers). Reuse existing SDK calls
(relay.subscriptions.create, relay.webhooks.createInbound) and the relayfile SDK for connection detection +
inline connect. Honor the spec's frictionless rules (§12): one-liner + zero-arg wizard, inline connect on the
not-connected path, --no-input remediation, spawn-never-implicit. Write ${ART}/relay-impl.md.`,
      verification: { type: 'exit_code' },
    })
    .step('impl-relayfile', {
      agent: 'impl-relayfile',
      cwd: RELAYFILE,
      dependsOn: ['plan'],
      task: `cwd is the relayfile worktree (branch feat/integration-bridge-runtime).
Implement F1–F4: the optional RelayBinding hook + generic semantics-aware default presenter on the adapter
contract (packages/sdk/typescript), the 'integration bind/unbind' commands, and the forwarder loop in
packages/agents (SDK-only: onWrite + RelayCast SDK webhooks.trigger inbound; subscription/writeback ->
adapter.writeBack outbound) with both loop-guards. Keep the bridge core provider-agnostic; Slack-specific
niceness belongs only in the slack adapter's present/skip overrides. Write ${ART}/relayfile-impl.md.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 2: deps + tests, test-fix-rerun per repo (80-to-100) ────────────
    .step('install', {
      type: 'deterministic',
      dependsOn: ['impl-relaycast', 'impl-relay', 'impl-relayfile'],
      captureOutput: true,
      failOnError: false,
      command: `for d in "${RELAYCAST}" "${RELAY}" "${RELAYFILE}"; do
  echo "== install $d =="
  ( cd "$d" && (corepack enable 2>/dev/null; (pnpm install 2>&1 || npm install 2>&1) | tail -8) ) || echo "install issue in $d"
done
echo INSTALL_DONE`,
    })
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['install'],
      task: `Write focused tests that prove the contract, using each repo's existing harness:
- relaycast (${RELAYCAST}): a test that triggerWebhook with payload {relayfile:{provider,path,revision}}
  persists that into message.metadata AND that the routing key appears on the message.created delivery payload.
  Use PGlite only if a real Postgres is required; otherwise the repo's existing engine test harness.
- relay (${RELAY}): tests for the new subscription flags and the subscribe/unsubscribe orchestrator
  (mock the relaycast + relayfile SDKs; assert the not-connected path and spawn-never-implicit).
- relayfile (${RELAYFILE}): tests for the generic default presenter (semantics-aware) and replyPathFor,
  and the forwarder loop-guards (inbound skip self/bot; outbound skip inbound_webhook origin).
Write a coverage note to ${ART}/tests.md. End with TESTS_WRITTEN.`,
      verification: { type: 'output_contains', value: 'TESTS_WRITTEN' },
    })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      captureOutput: true,
      failOnError: false,
      command: `set +e
echo "== relaycast =="; ( cd "${RELAYCAST}" && (pnpm -s test 2>&1 || npm test --silent 2>&1) | tail -50 )
echo "== relay =="; ( cd "${RELAY}" && (pnpm -s test 2>&1 || npm test --silent 2>&1) | tail -50 )
echo "== relayfile =="; ( cd "${RELAYFILE}" && (pnpm -s test 2>&1 || npm test --silent 2>&1) | tail -50 )
echo RUN_TESTS_DONE`,
    })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: `Test output (all three repos):
{{steps.run-tests.output}}

For any repo with failures: read the failing test + source, fix the issue (test or source), and re-run that
repo's suite locally until green. Repeat until all three are green or you hit a genuine blocker. Keep changes
scoped to the contract. Update ${ART}/tests.md with the final state.`,
      verification: { type: 'exit_code' },
    })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      captureOutput: true,
      failOnError: false,
      command: `set +e
pass=1
for d in "${RELAYCAST}" "${RELAY}" "${RELAYFILE}"; do
  echo "== $d =="
  ( cd "$d" && (pnpm -s test 2>&1 || npm test --silent 2>&1) | tail -40 ) || pass=0
done
[ "$pass" = "1" ] && echo TESTS_GREEN || echo TESTS_RED`,
    })
    .step('fix-tests-final', {
      agent: 'tester',
      dependsOn: ['run-tests-final'],
      task: `If the rerun shows TESTS_GREEN, record the green evidence in ${ART}/tests.md and stop.
If TESTS_RED, fix the remaining failure and rerun the affected repo until green:
{{steps.run-tests-final.output}}`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 3: verify edits actually landed (per repo) ──────────────────────
    .step('verify-edits', {
      type: 'deterministic',
      dependsOn: ['fix-tests-final'],
      captureOutput: true,
      failOnError: false,
      command: `set +e; fail=0
# relaycast: metadata persistence touched + payload sanitization referenced
git -C "${RELAYCAST}" status --short | grep -q "engine/inboundWebhook.ts" || { echo "R: inboundWebhook.ts not modified"; fail=1; }
grep -rq "sanitizeUserMessageMetadata" "${RELAYCAST}/packages/engine/src/engine/inboundWebhook.ts" || { echo "R: payload not sanitized into metadata"; fail=1; }
# relay: new subcommands present
grep -rq "subscribe" "${RELAY}/packages/cli/src/cli/commands/integration.ts" || { echo "C: subscribe verb missing"; fail=1; }
git -C "${RELAY}" status --short | grep -q "integration.ts" || { echo "C: integration.ts not modified"; fail=1; }
# relayfile: RelayBinding + forwarder present
grep -rq "RelayBinding\\|replyPathFor\\|present(" "${RELAYFILE}/packages/sdk/typescript/src" || { echo "F: RelayBinding hook missing"; fail=1; }
git -C "${RELAYFILE}" status --short | grep -q "packages/agents" || { echo "F: packages/agents forwarder not added"; fail=1; }
[ "$fail" = "0" ] && echo VERIFY_OK || echo VERIFY_NEEDS_REPAIR`,
    })
    .step('fix-verify-edits', {
      agent: 'lead',
      dependsOn: ['verify-edits'],
      task: `If VERIFY_OK, do nothing. If VERIFY_NEEDS_REPAIR, the named change didn't land — route it to the
right scope owner to finish, then re-run the equivalent checks:
{{steps.verify-edits.output}}`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 4: Claude-then-Codex fresh-eyes review/fix over all worktrees ────
    .step('claude-review', {
      agent: 'claude-reviewer',
      dependsOn: ['fix-verify-edits'],
      task: `Fresh-eyes review the post-implementation state in all three worktrees (${RELAYCAST}, ${RELAY}, ${RELAYFILE})
against the spec ${SPEC} and the contract. Read actual files + git diff + repo AGENTS.md/CLAUDE.md. Check especially:
provider-agnosticism (no Slack-only logic in the bridge core), SDK-surfaces-only, the metadata round-trip, the
not-connected UX, and spawn-never-implicit. Write findings to ${ART}/claude-review.md, or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('claude-fix', {
      agent: 'claude-fixer',
      dependsOn: ['claude-review'],
      task: `Read ${ART}/claude-review.md. Fix every valid finding in the correct worktree, add/adjust tests,
rerun the affected repo's checks, and update ${ART}/claude-fix.md. If NO_ISSUES_FOUND, record that.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-review', {
      agent: 'codex-reviewer',
      dependsOn: ['claude-fix'],
      task: `Second-pass fresh-eyes review of the post-Claude-fix state across all three worktrees. Do not rely
on the prior review. Same focus areas + test adequacy. Write ${ART}/codex-review.md or NO_ISSUES_FOUND.`,
      verification: { type: 'exit_code' },
    })
    .step('codex-fix', {
      agent: 'codex-fixer',
      dependsOn: ['codex-review'],
      task: `Read ${ART}/codex-review.md. Fix every valid finding, add/adjust tests, rerun affected checks,
update ${ART}/codex-fix.md. If no fix is possible, write ${ART}/<repo>-BLOCKED_NO_COMMIT.md with exact evidence.
If NO_ISSUES_FOUND, record final review signoff.`,
      verification: { type: 'exit_code' },
    })

    // ── Phase 5: final acceptance + commit-if-green (feature branches only) ────
    .step('acceptance', {
      type: 'deterministic',
      dependsOn: ['codex-fix'],
      captureOutput: true,
      failOnError: false,
      command: `set +e; pass=1
ls "${ART}"/*BLOCKED_NO_COMMIT.md >/dev/null 2>&1 && { echo "BLOCKED artifact present"; pass=0; }
for d in "${RELAYCAST}" "${RELAY}" "${RELAYFILE}"; do
  echo "== acceptance $d =="
  ( cd "$d" && (pnpm -s test 2>&1 || npm test --silent 2>&1) | tail -20 ) || { echo "RED: $d"; pass=0; }
done
[ "$pass" = "1" ] && echo ACCEPTANCE_GREEN || echo ACCEPTANCE_RED`,
    })
    .step('commit-if-green', {
      type: 'deterministic',
      dependsOn: ['acceptance'],
      captureOutput: true,
      failOnError: false,
      command: `set +e
case "{{steps.acceptance.output}}" in
  *ACCEPTANCE_GREEN*) : ;;
  *) echo "NOT GREEN — skipping commit. See ${ART} for BLOCKED_NO_COMMIT evidence."; exit 0 ;;
esac
commit_one() { # $1 dir  $2 message
  cur=$(git -C "$1" rev-parse --abbrev-ref HEAD)
  case "$cur" in main|master) echo "REFUSING to commit on $cur in $1"; return ;; esac
  git -C "$1" add -A && git -C "$1" commit -m "$2" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" 2>&1 | tail -3
}
commit_one "${RELAYCAST}" "feat(engine): persist inbound webhook payload into message metadata for integration-bridge round-trip"
commit_one "${RELAY}" "feat(cli): integration subscribe/unsubscribe + subscription --filter/--url/--secret"
commit_one "${RELAYFILE}" "feat: RelayBinding adapter hook + integration bind + provider-agnostic relay forwarder"
echo "COMMITTED to feature branches (no push). User decides when to merge."`,
    })
    .step('summary', {
      agent: 'lead',
      dependsOn: ['commit-if-green'],
      task: `Write ${ART}/SHIP_REPORT.md summarizing: per-repo branch + commit (or BLOCKED reason), what each
change does, the test evidence, and the exact next steps for the user (review diffs, open PRs per repo — the
workflow intentionally did NOT push or merge to main per relay/CLAUDE.md). Reference the spec ${SPEC}.
Acceptance result: {{steps.acceptance.output}}
Commit result: {{steps.commit-if-green.output}}`,
      verification: { type: 'exit_code' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});
