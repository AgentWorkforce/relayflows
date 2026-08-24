# sbx-relayflow-0824 — the sandbox-program relayflow is written and running

Brief: `~/Projects/AgentWorkforce/chief/.briefs/sbx-relayflow-0824.md`
Seat: `~/Projects/AgentWorkforce/relayflows` (real clone, branch
`flow/sandbox-program-drive-0824`, no other writer)

## The deliverable

| What | Path |
|---|---|
| The flow | `workflows/sandbox-program-drive.ts` (29 steps, 21 waves, 8 agents) |
| Gate scripts | `workflows/sandbox-program/gates/*.sh` |
| Evidence | `.workflow-artifacts/sandbox-program/*-evidence.txt` |
| Run log | `.workflow-artifacts/sandbox-program/run.log` |

Commits on `flow/sandbox-program-drive-0824`:
`781aa7e` the flow, `c60a624` a preflight fix the first run exposed.
Not pushed, not merged — Khaliq owns every merge gate.

## Evidence it is EXECUTING, not authored

- Run id **`075570b618ee39e8d073cebe`**, started locally
  (`relayflows run workflows/sandbox-program-drive.ts`).
- Live processes: the `relayflows run` parent and the
  `node --experimental-strip-types .../sandbox-program-drive.ts` child.
- Broker up, channel `wf-sandbox-program` created, 29 steps dispatching.
- Steps already completed with real output on disk:
  `preflight` → `acceptance-contract` (wrote `ACCEPTANCE.md`) →
  `repair-preflight` spawned as a live PTY agent
  (`repair-preflight-075570b6`).
- Deterministic gates already produced evidence files before the run, and are
  re-run inside it: `lane-reconcile-evidence.txt` (10 checks, 3 red),
  `stage3-longrun-reconcile-evidence.txt` (15 checks, 15 red).

Resume, do not restart:

    RESUME_RUN_ID=075570b618ee39e8d073cebe relayflows run workflows/sandbox-program-drive.ts

## Shape

Repair before failure, per `relay-80-100-workflow`. Every gate is
`run-*` (`captureOutput: true`, `failOnError: false`) → `fix-*` (agent reading
`{{steps.run-*.output}}`) → `verify-*` (deterministic rerun). `commit-if-green`
reruns the full acceptance command, records each exit code, and commits only
when every one is zero; anything still red becomes `BLOCKED_NO_COMMIT.md` with
the failing evidence and the step **exits successfully**, so the run reports a
handled blocked state rather than a `FAILED` run.

Gates stay on the critical path. No gate depends on a live lane process: the
critical path runs through `lane-reconcile`, a deterministic read of
`git status --short`, diff stats and required files across the four lane
clones. `program-lead-coordinate` runs in parallel and is a dependency of
nothing, so a dropped PTY cannot masquerade as "the product failed".

`integrations.relayfile: {}` — the existing Relayfile connection, no
workspaceId, no tokens, no Slack bot token in the file.
`swarm.humanAssistance.slack` is declared and every agent is instructed to
print exactly one `HUMAN_QUESTION:` line when blocked. Human assistance is
switched **off** for the two one-shot reviewer steps: a reviewer that can
answer its own approval gate fails open.

Runs locally, by design. The flow is the driver and the sandbox is the
subject. No step tries to prove the runtime can reach a sandbox.

## What the four stages gate on

1. **Provisioning** (`sbx-provisioning-0824`, `cloud-provisioning-0824`,
   `fix/snapshot-gh-cli`) — the live snapshot builder must install `gh`, mount
   Relayfile, and write the roster; plus a fresh-box probe transcript recording
   `mount_relayfile`, `gh_version`, `gh_auth_status`, `roster_present`,
   `workspace_is_mount`, each with its own exit code. A missing transcript is a
   FAIL routed to the repair owner, not a skip.
2. **`sandbox#30`** (`sbx-sec30-0824`) — the repo's own mount-script tests run
   under an explicit `umask 022`, because 0600 inherited from a lucky umask is
   not a fix. Plus typecheck, full suite, and CI.
3. **Long-run reconciliation** (`sbx-longrun-0824`) — one document superseding
   `sandbox-router#16`/`#17`: four axes, per-claim OBSERVED/DOCUMENTED/INFERRED
   labels, an explicit `DAYTONA_CAP_RULING`, a crossover point rather than a
   single-number ranking, a `RECOMMENDATION`, an UNKNOWN list, and no raw
   tokens in a public repo.
4. **Capability routing** — `sandbox-router` typecheck/tests, selection by
   capability rather than hardcoded provider, and a **real call site in
   cloud**. Gated behind stage 1: an empty box beats a good router.

Verification standards are enforced in `gates/_lib.sh`: every check is scored
by the exit code of the command itself, never through a pipe and never by
absence of an error; CI is read with `gh run list --branch` (never `--commit`),
the latest run of every workflow name must be `completed/success`, and an empty
result is a **FAIL**, not a pass.

## First red gates — real work, already surfaced

`lane-reconcile`: 3 of 10 red.
- `RECON_STAGE3_LONGRUN_MATERIALIZED` — no committed or working-tree change in
  `docs/` on the longrun lane.
- `RECON_STAGE1_PROBE` — no fresh-box provisioning probe transcript exists yet.
- `RECON_STAGE3_DOC` — the reconciliation document does not exist yet.

`stage3-longrun-reconcile`: 15 of 15 red, all downstream of the missing
document.

Both are routed to repair owners inside the run. Neither stops it.

## One flow bug found and fixed by running it

The first run's `preflight` blocked on unexpected drift — its own broker
writes `.agentworkforce/relay/state-*.json` into the seat at startup. Ignored
now the way `.agent-relay/` already was, and allowed in preflight (`c60a624`).
`preflight` is `failOnError: false` with a repair owner, so the run continued
through it rather than dying on it. That is the shape working as intended.

## Standing constraints honoured

Never merge, never push. `relayflows`, `sandbox` and `sandbox-router` are
public: no customer names, no credentials, no exploit paths. Repair owners are
each scoped to one lane clone — one writer per repo by placement.

Per `relay#1593`, an agent can stop receiving DM injections after roughly 1–5
hours while every send still reports success. If my inbound goes quiet, that is
the reason, and this artifact stays the source of truth.
