# fix-stage1-provisioning

Date: `2026-08-25`
Owner lane: `sbx-provisioning-0824`
Decision: `BLOCKED_MISSING`

## Gate rerun

```text
gate: stage1-provisioning
timestamp: 2026-08-25T03:58:30Z
host_cwd: /Users/khaliqgant/Projects/AgentWorkforce/relayflows
aw_root: /Users/khaliqgant/Projects/AgentWorkforce
---
S1_SNAPSHOT_TESTS exit=0
S1_GH_IN_LIVE_SNAPSHOT exit=0
S1_RELAYFILE_MOUNT_IN_SNAPSHOT exit=0
S1_ROSTER_IN_SNAPSHOT exit=1
S1_PROBE_PRESENT exit=0
S1_PROBE_MOUNT exit=1
S1_PROBE_GH_VERSION exit=1
S1_PROBE_GH_AUTH exit=1
S1_PROBE_ROSTER exit=1
S1_PROBE_WORKSPACE_IS_MOUNT exit=1
S1_CI exit=1
checks: 11
failed: 7
STAGE1_PROVISIONING_RED: 7 of 11 checks failed
```

## Classification

This red is `MISSING`, not `WRONG`.

- `S1_ROSTER_IN_SNAPSHOT exit=1`
- `S1_PROBE_MOUNT exit=1`
- `S1_PROBE_GH_VERSION exit=1`
- `S1_PROBE_GH_AUTH exit=1`
- `S1_PROBE_ROSTER exit=1`
- `S1_PROBE_WORKSPACE_IS_MOUNT exit=1`
- `S1_CI exit=1`

## Why It Is Missing

`S1_ROSTER_IN_SNAPSHOT exit=1` is unbuilt work. The live snapshot builder path
checked by the gate, `cloud-provisioning-0824/scripts/create-snapshot.ts`,
contains mirrored `gh` and Relayfile-mount installation paths but no roster
provisioning path at all. Verification command and result:

```bash
rg -n "\\broster\\b|ROSTER" \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/scripts/create-snapshot.ts \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/tests/snapshot-shell.test.ts \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/deploy/daytona/Dockerfile
# exit 1
```

`S1_PROBE_MOUNT exit=1`, `S1_PROBE_GH_VERSION exit=1`,
`S1_PROBE_GH_AUTH exit=1`, `S1_PROBE_ROSTER exit=1`, and
`S1_PROBE_WORKSPACE_IS_MOUNT exit=1` are also missing work. The required
fresh-box acceptance transcript has not been produced; the only file on disk is
the reconcile placeholder:

```text
PENDING: awaiting fresh-box run from sbx-provisioning-0824

mount_relayfile exit=1
gh_version exit=1
gh_auth_status exit=1
roster_present exit=1
workspace_is_mount exit=1
```

That is not a real fresh-box run and cannot be turned green by local repair.

`S1_CI exit=1` has no passing evidence for the branch because the latest
workflow set still includes `Preview` as `skipped`:

```json
[
  {"name":"CI","status":"completed","conclusion":"success"},
  {"name":"Smoke Sandbox Image","status":"completed","conclusion":"success"},
  {"name":"Preview","status":"completed","conclusion":"skipped"},
  {"name":"Snapshot Impact Check","status":"completed","conclusion":"success"}
]
```

The gate treats that as red and there is no local repair surface here that
converts it into a pass without changing branch workflow policy or obtaining a
different run.

## Owner

Lane that owns building the missing work: `sbx-provisioning-0824`.

Per contract, this repair pass did not build an unbuilt feature, fabricate a
fresh-box transcript, or edit the lane clone.

## Commands Run

```bash
bash workflows/sandbox-program/gates/stage1-provisioning.sh
sed -n '1,120p' .workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt
gh run list --repo AgentWorkforce/cloud --branch fix/snapshot-gh-cli --limit 20 --json name,status,conclusion,createdAt,headSha
rg -n "\\broster\\b|ROSTER" \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/scripts/create-snapshot.ts \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/tests/snapshot-shell.test.ts \
  /Users/khaliqgant/Projects/AgentWorkforce/cloud-provisioning-0824/deploy/daytona/Dockerfile
```

OWNER_DECISION: COMPLETE
REASON: BLOCKED_MISSING was recorded with the exact failed checks, exit codes,
and owner lane; this is a handled blocked result.
