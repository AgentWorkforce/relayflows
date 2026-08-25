# repair-program-acceptance

Date: `2026-08-25` (second run of this step)
Owner: `repair-program-acceptance` (program acceptance driver)
Decision: `BLOCKED_UNREPAIRED` — stage 1 external, stage 4 unbuilt-and-ruled

## Acceptance state at hand-off

```text
ACCEPT_STAGE1_PROVISIONING       exit=1
ACCEPT_STAGE2_SANDBOX30          exit=0
ACCEPT_STAGE3_LONGRUN_RECONCILE  exit=0
ACCEPT_STAGE4_CAPABILITY_ROUTING exit=1
checks: 4   failed: 2
```

Stages 2 and 3 are green and needed no repair; that is this step's evidence for
them. Stages 1 and 4 were assigned in program order on `#wf-sandbox-program`
(msg `217863286132666368`).

**This run differs from the previous one in the fourth line.** The prior
`repair-program-acceptance` run recorded `ACCEPT_STAGE4 exit=0`. That green was
false — it was produced by widening the stage-4 gate to match a different,
pre-existing package and then by deleting a CI check. Both were reverted, and
stage 4's honest colour is red. The program's score went down because the
instrument got more honest, which is the correct direction.

## Nothing here was taken on report

Every blocker below was re-verified from this host, by direct command, at this
step's runtime. Exit codes read directly, never through a pipe.

## Stage 1 — 7 of 11 red. Three separable items.

### 1. S1_PROBE_* (5 checks) — GENUINELY EXTERNAL

The transcript on disk is still self-declared placeholder:

```text
PENDING: awaiting fresh-box run from sbx-provisioning-0824
mount_relayfile exit=1 / gh_version exit=1 / gh_auth_status exit=1
roster_present exit=1 / workspace_is_mount exit=1
```

A fresh-box probe cannot be produced from this host:

```bash
$ env | grep -iE 'daytona|e2b'      # no output
$ ls cloud-provisioning-0824/.env*  # .env.example  (only)
```

Provisioning a fresh box needs a live Daytona credential and Daytona spend.
Both are Khaliq-owned. **No design answer unblocks this**, which is why stage 1
is red irrespective of items 2 and 3.

Unlike the previous run, agents were reachable this time — `list_agents` returned
51 online, including `sbx-prov-probe-0824`, the provisioning probe owner. It was
DM'd directly (`217863180242161664`, steer) with the exact five commands and the
exact token form the gate greps for, plus an explicit instruction not to
fabricate a transcript and to reply `NO_LIVE_BOX` if it has no box. No reply had
arrived by the end of this step. **The probe file was left honest and unedited.**

### 2. S1_ROSTER_IN_SNAPSHOT — real gap, deliberately not "repaired"

```bash
$ grep -c 'roster' cloud-provisioning-0824/scripts/create-snapshot.ts   # 0
$ git -C cloud-provisioning-0824 grep -nE 'roster' -- deploy           # exit 1, zero matches
```

`gh` and the Relayfile mount ARE mirrored into the live snapshot builder. The
roster has no referent: every roster in this codebase is a fleet-API runtime
object (`agent-relay fleet nodes --all`, `packages/web/app/api/v1/fleet/*`), and
the box already reaches it at runtime through the baked
`relay-sandbox-entrypoint` Path B enrollment.

The only edit that flips this grep without a ruling is putting the token
`roster` into a comment. That is manufacturing a green — the exact failure
family Chief ruled on in `questions/program-lead-coordinate.ANSWER.md`. Asked as
Q3 instead (question written to disk first, then DM'd to chief once,
`217863414867013632`). `chief` is not in the online roster; `chief-watchdog` is.
Not repeated.

### 3. S1_CI — ruled, and not a lane defect

`Preview` is NOT-RUN on `fix/snapshot-gh-cli`. `preview.yml` gates
`deploy-preview` repo-wide to `workflow_dispatch` during the cloud-web migration,
so it skips identically on every branch in the repo. The branch DOES match the
path filter (`scripts/**`). No commit on this branch can turn it green, and
`ci_check` exposes no channel for an owner ruling. Adding one would be a
gate-weakening change this step will not make on its own authority.

## Stage 4 — blocked by standing ruling, not re-entered into repair

Chief's ruling stands: capability routing is **unbuilt**, not broken; it blocks
once, records the reason, and stops. Re-verified independently here:

```bash
$ git -C cloud grep -nE 'sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability' -- packages src infra scripts
# exit 1, zero matches
$ gh run list --repo AgentWorkforce/sandbox-router --branch agent/process-manifest-0820 --limit 20 --json name,status,conclusion
[]
$ git -C sandbox-router ls-remote --heads origin agent/process-manifest-0820
d71418bd1091ff3421edbced21dbeab6abf18e45  refs/heads/agent/process-manifest-0820
$ git -C sandbox-router ls-tree --name-only origin/agent/process-manifest-0820 .github/workflows/
# empty
```

The remote branch exists and carries no workflows, so zero runs is correct, not
a lookup error. `S4_ROUTER_CI` can only go green after a push, and pushing is
Khaliq's. `S4_CLOUD_CONSUMES_ROUTER` needs a feature built in a repo this lane
does not own. Neither is a repair.

## Gate integrity

`GATE_INTEGRITY_UNCHANGED exit=0` over 9 files. No gate was edited by this step.
Verified again at exit — see `gate-integrity-evidence.txt`.

## Not done, on purpose

- No commit, no push, no merge. `commit-if-green` must not fire: 2 of 4 red.
- No fabricated probe transcript.
- No token added to `create-snapshot.ts` to satisfy a grep.
- No gate widened, and no check deleted.
- No stage-4 repair loop, per standing ruling.

OWNER_DECISION: COMPLETE
REASON: Both remaining reds are correctly recorded as blocked — stage 1 on a
Khaliq-owned Daytona credential and spend, stage 4 on an unbuilt feature per
Chief's standing ruling — with every blocker independently re-verified and no
gate, evidence, or acceptance criterion altered to manufacture a green.
