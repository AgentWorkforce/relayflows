# repair-lane-reconcile

Gate: `workflows/sandbox-program/gates/lane-reconcile.sh`
Contract: `.workflow-artifacts/sandbox-program/ACCEPTANCE.md`

## Starting state

`lane-reconcile-evidence.txt` (2026-08-25T00:51:31Z): 10 checks, 1 failed.

- `RECON_STAGE1_PROBE exit=1` — genuine: no fresh-box probe transcript exists.
- `RECON_STAGE3_DOC exit=0` — already green going into this repair. The
  handed-off task text describing this as "the document does not exist yet"
  is stale (from before a prior repair renamed the doc to the gate-expected
  filename); the gate itself already agrees the file is present. No action
  taken here — record only.

## RECON_STAGE1_PROBE

`RECON_STAGE1_PROBE` is a `file_check` (existence only, not content) on
`.workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt` — it is a
different, weaker check than stage1-provisioning's own `S1_PROBE_*` checks,
which `grep_check` each line for `exit=0`.

Per this step's explicit contract, did NOT provision a box myself and did
NOT fabricate a passing transcript. Coordinated first:

- DM'd `sbx-provisioning-0824` (the lane owner for this fault) asking
  whether a real fresh-box run/transcript exists or is in progress. No reply
  received in this step's window; not blocking on it further (per rules:
  ask once, do not stall).
- No fresh-box probe evidence found anywhere else in the workspace
  (`find`d for `*freshbox*`/`*fresh-box*` repo-wide; nothing under
  `cloud-provisioning-0824` either — only unrelated smoke/probe tooling for
  other faults).

Wrote `.workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt` with
all five checks recorded `exit=1` and an explicit
`PENDING: awaiting fresh-box run from sbx-provisioning-0824` line, exactly
as the fallback instructs. This makes `RECON_STAGE1_PROBE` (existence)
green while keeping the real stage-1 gate's `S1_PROBE_MOUNT`,
`S1_PROBE_GH_VERSION`, `S1_PROBE_GH_AUTH`, `S1_PROBE_ROSTER`,
`S1_PROBE_WORKSPACE_IS_MOUNT` checks honestly red — they `grep` for
`exit=0`, which this PENDING file does not contain. Stage 1 remains
correctly blocked pending a real fresh-box run; only the reconcile-level
"deliverable exists" bookkeeping check is satisfied.

## Rerun

```
$ bash workflows/sandbox-program/gates/lane-reconcile.sh
...
RECON_STAGE1_PROBE exit=0  # .workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt
RECON_STAGE3_DOC exit=0    # sandbox-router-longrun-0824/docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md
checks: 10
failed: 0
LANE_RECONCILE_OK
```

## No scope creep

- No box provisioned, no transcript fabricated.
- No edits to any lane's clone.
- No merge, no push.

OWNER_DECISION: COMPLETE
REASON: The one genuine red (RECON_STAGE1_PROBE) is now recorded honestly as
PENDING per the explicit fallback contract after coordinating with the
owning lane and finding no real transcript available; the other named item
(RECON_STAGE3_DOC) was already green and needed no action. Reran the gate:
10/10 checks pass, LANE_RECONCILE_OK.

STEP_COMPLETE:repair-lane-reconcile

## 2026-08-25T03:45:09Z — reconfirm, no repair needed

New broker handoff (`init_a83b897873364c77bcd7ec261316dd28`) restated the
same "two most likely red" candidates verbatim, but the reconcile output it
attached already showed both green (`RECON_STAGE1_PROBE exit=0`,
`RECON_STAGE3_DOC exit=0`, 10 checks, 0 failed). Treated that as the stale
static instruction text it is, not as live signal, and verified from disk
instead of trusting either the prose or the pasted output at face value:

- Read `stage1-freshbox-probe.txt` directly: still the honest `PENDING`
  placeholder from the prior pass — `mount_relayfile`, `gh_version`,
  `gh_auth_status`, `roster_present`, `workspace_is_mount` all `exit=1`.
  Confirmed via `stage1-provisioning-evidence.txt`
  (2026-08-25T02:45:55Z) that stage1-provisioning's own `S1_PROBE_*` checks
  (which `grep` for `exit=0`) are still correctly red, and that lane's
  `BLOCKED_NO_COMMIT.md` / `stage1-provisioning-repair.md` already carry the
  `BLOCKED_MISSING` record with `sbx-provisioning-0824` as owner. Nothing to
  redo here — a fresh-box run is still not available, and this step still
  must not provision one or fabricate a transcript.
- Confirmed `docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md`
  still exists in `sandbox-router-longrun-0824` at the gate-expected path.
- Reran `bash workflows/sandbox-program/gates/lane-reconcile.sh` fresh
  (not reused from the handoff): `checks: 10  failed: 0  LANE_RECONCILE_OK`,
  identical shape to the pasted output. No drift since the last pass.

No edits to any lane clone, no box provisioned, no transcript fabricated, no
merge, no push.

OWNER_DECISION: COMPLETE
REASON: Reran the gate fresh and confirmed 10/10 checks pass with no
regression since the prior repair pass; both named candidates were already
correctly resolved (one honest PENDING placeholder, one already-present
doc) and needed no further action.

STEP_COMPLETE:repair-lane-reconcile
