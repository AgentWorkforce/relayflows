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
#
# F-11: bare `gh|github-cli|githubcli` matches inside `high`/`light`/`weight`
# and proves nothing structural. These patterns require the actual install or
# verification invocation, not just the word.
grep_check S1_GH_IN_LIVE_SNAPSHOT "$SNAPSHOT" \
  'apt-get install.*--no-install-recommends.*gh|command -v gh|gh --version'
# F-11: bare `relayfile` matches the file's own doc-comment (line 5). Require
# the actual install path the snapshot writes the binary to.
grep_check S1_RELAYFILE_MOUNT_IN_SNAPSHOT "$SNAPSHOT" '/usr/local/bin/relayfile-mount'
# F-11 (claude-review-final.md, incompletely fixed the first time): a bare
# `roster|ROSTER` passes on the word appearing in this file's own doc-comment
# and proves nothing structural, the same defect the two checks above were
# given the real treatment for. This does not exist yet in create-snapshot.ts
# (roster writing is stage 1's still-unbuilt work), so there is no real
# install/write call to anchor to today — this requires the word to co-occur
# with an actual write/emit call within ~80 chars, so a bare mention (a
# comment, a TODO, a string) still fails, and only a genuine write of a
# roster artifact can turn it green.
grep_check S1_ROSTER_IN_SNAPSHOT "$SNAPSHOT" \
  '(writeFileSync|appendFileSync|fs\.write|cat[[:space:]]*>|<<[[:space:]]*.?EOF).{0,80}[Rr]oster|[Rr]oster.{0,80}(writeFileSync|appendFileSync|fs\.write|cat[[:space:]]*>|<<[[:space:]]*.?EOF)'

# ── Fresh-box probe transcript: exit codes, not prose ────────────────────────
file_check S1_PROBE_PRESENT "$PROBE_EVIDENCE"

# F-09: the probe file lives at $ARTIFACTS_ROOT, the one path every repair
# owner is told to write to, and the checks below score bare strings like
# `mount_relayfile exit=0` with no signature, host identity, or timestamp — a
# hand-typed `echo` satisfies them. This requires a provenance header first:
# a sandbox id, a provider, an ISO-8601 timestamp that actually parses and is
# not from before this program existed, and the literal mount command output.
# A probe missing any of those fails S1_PROBE_PROVENANCE regardless of what
# the exit-code lines below say.
#
# Expected header lines in the probe transcript (any order, one per line):
#   sandbox_id: <id>
#   provider: <name>
#   timestamp: <ISO-8601, e.g. 2026-08-25T12:34:56Z>
#   mount_output: <verbatim `mount | grep -i relayfile` output>
check_probe_provenance() {
  local name="S1_PROBE_PROVENANCE" f="$PROBE_EVIDENCE"
  if [ ! -f "$f" ]; then
    record "$name" 1 "file missing: $f"
    return 0
  fi
  local sandbox_id provider ts_line mount_line ts_val ts_epoch anchor_epoch
  sandbox_id=$(grep -m1 -E '^sandbox_id:[[:space:]]*\S+' "$f" || true)
  provider=$(grep -m1 -E '^provider:[[:space:]]*\S+' "$f" || true)
  ts_line=$(grep -m1 -E '^timestamp:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$f" || true)
  mount_line=$(grep -m1 -E '^mount_output:' "$f" || true)
  if [ -z "$sandbox_id" ] || [ -z "$provider" ] || [ -z "$ts_line" ] || [ -z "$mount_line" ]; then
    record "$name" 1 "missing provenance header — need sandbox_id:, provider:, timestamp: (ISO-8601), mount_output: lines"
    return 0
  fi
  ts_val=$(printf '%s\n' "$ts_line" | sed -E 's/^timestamp:[[:space:]]*//')
  if date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts_val" +%s >/dev/null 2>&1; then
    ts_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts_val" +%s)
  else
    ts_epoch=$(date -u -d "$ts_val" +%s 2>/dev/null || echo "")
  fi
  anchor_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "2026-08-24T00:00:00Z" +%s 2>/dev/null \
    || date -u -d "2026-08-24T00:00:00Z" +%s 2>/dev/null || echo 0)
  if [ -z "$ts_epoch" ] || [ "$ts_epoch" -lt "$anchor_epoch" ]; then
    record "$name" 1 "timestamp unparseable or predates this program (2026-08-24): '$ts_val'"
    return 0
  fi
  record "$name" 0 "sandbox_id/provider/timestamp/mount_output present, timestamp parses: $ts_val"
}
check_probe_provenance

grep_check S1_PROBE_MOUNT "$PROBE_EVIDENCE" 'mount_relayfile exit=0'
grep_check S1_PROBE_GH_VERSION "$PROBE_EVIDENCE" 'gh_version exit=0'
grep_check S1_PROBE_GH_AUTH "$PROBE_EVIDENCE" 'gh_auth_status exit=0'
grep_check S1_PROBE_ROSTER "$PROBE_EVIDENCE" 'roster_present exit=0'
# The workspace must be the live mounted tree. A /tmp clone is the failure,
# not a workaround: it is what drops uncommitted work.
grep_check S1_PROBE_WORKSPACE_IS_MOUNT "$PROBE_EVIDENCE" 'workspace_is_mount exit=0'

# ── CI, per workflow, by branch ─────────────────────────────────────────────
ci_check S1_CI "$SLUG" "$BRANCH" "$REPO"

gate_finish
