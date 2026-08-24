#!/usr/bin/env bash
# Stage 1 gate — sandbox provisioning: mount, credential, roster.
#
# The n=2 fault: a sandbox arrives with no Relayfile mount, no `gh`, and no
# roster, so lanes fall back to an HTTPS clone into /tmp that drops uncommitted
# work. Two live lanes reported it independently on two different nodes.
#
# This gate runs LOCALLY and scores the lane's work plus the lane's fresh-box
# evidence. It deliberately does NOT try to provision a sandbox itself: the
# flow is the driver and the sandbox is the subject, and a broken subject must
# not be a precondition for starting.
#
# Acceptance (the real one, from the brief):
#   mount | grep -i relayfile   non-empty on a FRESH box
#   gh --version                exit 0
#   gh auth status              exit 0
#   roster present
#   workspace is the live mounted tree, not a /tmp clone
#
# The first four are only meaningful on a fresh box, so the lane owes a
# fresh-box probe transcript recording each check WITH ITS EXIT CODE. Missing
# evidence is a FAIL, which routes to the repair owner — it is not a skip.
set -uo pipefail
# Resolve the library next to this script without changing the runner cwd —
# ARTIFACTS_ROOT is relative to the workflow cwd, not to the gates directory.
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "stage1-provisioning"

REPO="${STAGE1_REPO:-$AW_ROOT/cloud-provisioning-0824}"
BRANCH="${STAGE1_BRANCH:-fix/snapshot-gh-cli}"
SLUG="${STAGE1_SLUG:-AgentWorkforce/cloud}"
SNAPSHOT="$REPO/scripts/create-snapshot.ts"
PROBE_EVIDENCE="${STAGE1_PROBE_EVIDENCE:-$ARTIFACTS_ROOT/stage1-freshbox-probe.txt}"

# ── The lane's own deterministic proof ──────────────────────────────────────
run_check S1_SNAPSHOT_TESTS "$REPO" npx tsx --test tests/snapshot-shell.test.ts

# ── The three things a provisioned box must arrive with ─────────────────────
# gh in the LIVE snapshot. deploy/daytona/Dockerfile is the image that never
# ships; scripts/create-snapshot.ts builds the snapshot pinned in
# infra/sandbox-snapshot.ts, so the install has to be mirrored there.
grep_check S1_GH_IN_LIVE_SNAPSHOT "$SNAPSHOT" 'gh|github-cli|githubcli'
grep_check S1_RELAYFILE_MOUNT_IN_SNAPSHOT "$SNAPSHOT" 'relayfile|Relayfile|RELAYFILE'
grep_check S1_ROSTER_IN_SNAPSHOT "$SNAPSHOT" 'roster|ROSTER'

# ── Fresh-box probe transcript: exit codes, not prose ────────────────────────
file_check S1_PROBE_PRESENT "$PROBE_EVIDENCE"
grep_check S1_PROBE_MOUNT "$PROBE_EVIDENCE" 'mount_relayfile exit=0'
grep_check S1_PROBE_GH_VERSION "$PROBE_EVIDENCE" 'gh_version exit=0'
grep_check S1_PROBE_GH_AUTH "$PROBE_EVIDENCE" 'gh_auth_status exit=0'
grep_check S1_PROBE_ROSTER "$PROBE_EVIDENCE" 'roster_present exit=0'
# The workspace must be the live mounted tree. A /tmp clone is the failure,
# not a workaround: it is what drops uncommitted work.
grep_check S1_PROBE_WORKSPACE_IS_MOUNT "$PROBE_EVIDENCE" 'workspace_is_mount exit=0'

# ── CI, per workflow, by branch ─────────────────────────────────────────────
ci_check S1_CI "$SLUG" "$BRANCH"

gate_finish
