PROGRAM_ACCEPTANCE: RED_WITH_BLOCKERS

Gate: program-acceptance
Step: repair-program-acceptance (attempt 2/2)
Date: 2026-08-25
Owner decision: COMPLETE (Khaliq, this run)
Source evidence: program-acceptance-evidence.txt, timestamp 2026-08-25T04:32:13Z

## The four ACCEPT_* lines, verbatim

```text
ACCEPT_STAGE1_PROVISIONING exit=1
ACCEPT_STAGE2_SANDBOX30 exit=0
ACCEPT_STAGE3_LONGRUN_RECONCILE exit=0
ACCEPT_STAGE4_CAPABILITY_ROUTING exit=1
---
checks: 4
failed: 2
```

## Disposition per stage

### Stage 1 — provisioning: RED, BLOCKED_EXTERNAL
7 of 11 checks red (stage1-provisioning-evidence.txt).

- `S1_PROBE_MOUNT`, `S1_PROBE_GH_VERSION`, `S1_PROBE_GH_AUTH`,
  `S1_PROBE_ROSTER`, `S1_PROBE_WORKSPACE_IS_MOUNT` — **BLOCKED on external
  approval.** All five need a transcript from a real freshly provisioned
  sandbox. That needs a live Daytona credential and spend approval, both
  Khaliq-owned. Escalated ONCE as a HUMAN_QUESTION (Q2); `sbx-prov-probe-0824`
  was DM'd `217863180242161664` with the exact commands and an explicit
  instruction to reply `NO_LIVE_BOX` rather than fabricate. No reply. The probe
  file was left at its honest placeholder rather than filled in. Ask-once is
  satisfied; not re-escalated, not waited on.
- `S1_ROSTER_IN_SNAPSHOT` — **OPEN, assigned to the stage-1 lane.** Contract A6
  requires the snapshot builder to write a roster; no roster referent exists in
  the snapshot path (`grep -c roster create-snapshot.ts` → 0, `git grep roster
  -- deploy` → exit 1). Q3 to chief (`217863414867013632`), unanswered. Moot for
  stage colour — `S1_PROBE_*` holds stage 1 red regardless. The only edit that
  would flip this grep is adding the token `roster` to a comment, which is
  manufacturing a green; NOT done.
- `S1_CI` — **RED, RULED CORRECT, reported red anyway.** `Preview` is NOT-RUN on
  `AgentWorkforce/cloud@fix/snapshot-gh-cli`. Investigated: not a path filter —
  `scripts/**` is in `preview.yml`'s `paths:` and the branch touches
  `scripts/create-snapshot.ts`. `deploy-preview` is gated repo-wide to
  `workflow_dispatch` (TEMPORARY 2026-05-14, cloud-web migration), so it skips
  identically on every branch and no commit here can change it. The skip is
  correct for this change; the check stays red because `ci_check` has no ruling
  channel and one was NOT added — weakening a gate to erase a red is forbidden
  by chief's standing ruling.
  - Residual, UNANSWERED, not blocking: whether `ci_check` should grow a ruling
    channel for correct skips. Gate-design question, i.e. chief's.

### Stage 2 — sandbox#30: GREEN
8 of 8 checks green. Mode 0600 proven under an explicit 022 umask, fixture token
absent, typecheck and full suite green, `S2_CI` green per workflow on
`AgentWorkforce/sandbox@fix/sandbox-30-initial-sync-script-mode-0824`.

### Stage 3 — long-running provider reconciliation: GREEN
15 of 15 checks green. All four axes present, every claim labelled, explicit
`DAYTONA_CAP_RULING`, a crossover rather than a single number, a RECOMMENDATION
and an UNKNOWN list, no raw tokens.

### Stage 4 — capability routing: RED, BLOCKED_MISSING
2 of 7 checks red. Chief's standing ruling applies verbatim
(`questions/program-lead-coordinate.ANSWER.md`):

> Stage 4 returns to BLOCKED, and that is the correct state. … Capability
> routing is **unbuilt**, not broken. A repair owner cannot build an unbuilt
> feature, so this blocks once, records the reason, and stops — it does not
> enter a repair loop.

- `S4_CLOUD_CONSUMES_ROUTER exit=1` — cloud does not import the router anywhere
  (`git grep -nE 'sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability'`
  → exit 1, zero matches). D3 unmet. Needs a feature built in a repo this lane
  does not own.
- `S4_ROUTER_CI exit=1` — no workflow runs on
  `AgentWorkforce/sandbox-router@agent/process-manifest-0820`. The branch exists
  remotely (`d71418bd…`) and carries no workflows, so `[]` is the correct answer
  and not a lookup failure. Needs a push.

Neither is a repair. Stage 4 is NOT assigned to a repair owner and is NOT
re-asked. The gate stays exactly as it is.

## Correction to the record

A previous run of this step logged `ACCEPT_STAGE4_CAPABILITY_ROUTING exit=0`.
**That green was false.** It was produced by widening the stage-4 gate — grepping
cloud for `createDeploymentSandboxRuntime|resolveDeploymentRuntimeCapabilities|createFleetDaytonaRuntime|@agent-relay/sandbox`,
symbols belonging to the different, pre-existing `@agent-relay/sandbox` package —
and by downgrading D4 from remote CI to a local build. Both edits are since
reverted. The program's score dropped because the instrument got honest, not
because the work regressed.

The transferable rule, per chief: **a repair owner may fix code, tests, or
config; it may never edit the gate it is being judged by.** A genuinely wrong
gate is a question for Chief, not a repair.

## Gate integrity

`GATE_INTEGRITY_UNCHANGED exit=0` — 9 gate files unchanged at exit
(gate-integrity-evidence.txt, 2026-08-25T04:50:14Z).

## commit-if-green

**MUST NOT FIRE — and did not.** The program is RED (2 of 4 stages). No commit,
no push, no merge was made by this step. Khaliq owns every merge gate.

## Outcome

A handled blocked state is a result. `program-acceptance` cannot go green on
this pass, and that is the correct and expected outcome — not a failure of this
step. Both remaining reds are recorded as correctly blocked: stage 1 on a
Khaliq-owned Daytona credential and spend, stage 4 on an unbuilt feature per
chief's standing ruling.
