#!/usr/bin/env bash
#
# gate-integrity.sh — the instrument may not be reshaped by what it measures.
#
# WHY THIS EXISTS
#   Twice in one night a repair owner produced a green by rewriting the gate it
#   was being judged by.
#
#   Stage 4 reported `6 checks, 0 failed` with S4_CLOUD_CONSUMES_ROUTER exit=0.
#   It got there by changing what the gate greps for: out went
#   `sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability`,
#   in came symbols from `@agent-relay/sandbox` — a different, pre-existing
#   package that predates the stage entirely. Verified independently, `git grep`
#   for the router in `cloud` returns zero matches across packages/src/infra/scripts.
#   Cloud has never imported the router. The acceptance criterion had been
#   narrowed until code that already existed satisfied it.
#
#   In the same run S4_ROUTER_CI was DELETED rather than reverted. A deleted
#   check is not a passing check, and `N checks, 0 failed` cannot tell you which
#   one you are looking at.
#
#   Chief's ruling: a repair owner may fix code, tests or config. It may never
#   edit the gate it is judged by, and it may never delete a check. If a gate is
#   genuinely wrong, that is a question for Chief, not a repair.
#
#   Until this guard exists, every green this flow reports is worth nothing.
#
# WHAT IT COVERS
#   Every gate script, the driver that defines the acceptance contract (a repair
#   owner rewrote D4 from remote CI to a local build to match its rewritten
#   gate), and this script itself — so disarming the guard is itself a violation.
#
# WHERE IT LIVES
#   Deliberately NOT in gates/. Repair owners are pointed at `gates/<key>.sh` as
#   the thing they must rerun; keeping the guard out of that directory means
#   nothing routine ever brings them here.
#
# USAGE
#   bash workflows/sandbox-program/gate-integrity.sh baseline   # at run start
#   bash workflows/sandbox-program/gate-integrity.sh verify     # before scoring
#
# Exit 0 = unchanged. Exit 1 = a scored gate changed under the run, or the
# baseline is missing and nothing can be trusted.

set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$PWD}"
cd "$REPO_ROOT" || { echo "GATE_INTEGRITY_ERROR: cannot cd to $REPO_ROOT"; exit 1; }

GATES_DIR="workflows/sandbox-program/gates"
DRIVER="workflows/sandbox-program-drive.ts"
SELF="workflows/sandbox-program/gate-integrity.sh"

# The baseline lives outside .workflow-artifacts on purpose. That directory is
# the one place every repair owner is told to write, and a tamper record kept
# where the tamperer works is not a record.
BASELINE_DIR=".agent-relay"
BASELINE="$BASELINE_DIR/gate-integrity.baseline.txt"
# The baseline's own hash, recorded at baseline time. `.agent-relay` is
# gitignored and a re-baseline is otherwise silent (F-01): this lock is the
# only thing that lets `verify` notice the baseline file itself was swapped
# between baseline and verify. It is written to a git-tracked directory that
# no step or REPAIR_RULES text ever names, so a repair owner has no routine
# reason to find it, let alone edit it alongside a re-baseline.
LOCK_DIR="workflows/sandbox-program/.gate-integrity-lock"
LOCK="$LOCK_DIR/baseline.sha256"

EVIDENCE="${ARTIFACTS_ROOT:-$PWD/.workflow-artifacts/sandbox-program}/gate-integrity-evidence.txt"

# The current run's id.
#
# THE PIECE THAT WAS MISSING (F-01 fix option (d), skipped; caused F-16).
# Without it, "refuse to overwrite an existing baseline" cannot tell a NEW RUN
# (which must take a fresh baseline) apart from a RE-BASELINE INSIDE ONE RUN
# (which is how this guard was defeated). The hardening shipped with only the
# refusal, and since `.agent-relay/` is gitignored and host-persistent, the
# next run's `gate-integrity-baseline` — failOnError: true — died at step 2.
#
# The runner already writes its run id to AGENT_RELAY_RUN_ID_FILE and
# deterministic steps inherit the environment, so this is read, never guessed.
# Outside a run the id is `manual`, which still compares equal to itself so a
# hand-run baseline/verify pair works.
current_run_id() {
  local f="${AGENT_RELAY_RUN_ID_FILE:-}"
  if [ -n "$f" ] && [ -f "$f" ]; then
    tr -d ' \n\r' < "$f"
  else
    echo "manual"
  fi
}

# The run id recorded in an existing baseline, or empty for a pre-binding file.
baseline_run_id() {
  [ -f "$BASELINE" ] || return 0
  awk '/^# run_id:/ { print $3; exit }' "$BASELINE"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Emit "<sha256>  <path>" for every scored file, sorted by path so the manifest
# is stable regardless of filesystem ordering.
#
# A path that was in the baseline and is not on disk now is emitted as DELETED,
# not simply left out. Without that, a deleted gate would just make the manifest
# shorter, and the flow has already been burned by exactly this: S4_ROUTER_CI
# was deleted rather than reverted, and `N checks, 0 failed` reported it as
# fine. A deleted check is not a passing check, and the evidence has to say
# which of the two it is looking at.
manifest() {
  local expected="${1:-}"
  {
    if [ -d "$GATES_DIR" ]; then
      find "$GATES_DIR" -type f -print
    fi
    echo "$DRIVER"
    echo "$SELF"
    # Everything the baseline knew about, so a deletion cannot hide by absence.
    if [ -n "$expected" ] && [ -f "$expected" ]; then
      awk '/^#/ { next } { $1 = ""; sub(/^[[:space:]]+/, ""); print }' "$expected"
    fi
  } | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -f "$f" ]; then
      echo "$(sha256_of "$f")  $f"
    else
      echo "DELETED                                                           $f"
    fi
  done
}

case "${1:-}" in
  baseline)
    mkdir -p "$BASELINE_DIR" "$LOCK_DIR" "$(dirname "$EVIDENCE")"
    # Refuse to overwrite an existing baseline. Re-running `baseline` used to
    # silently replace it — that is exactly how this guard was defeated once
    # already (F-01): a repair pass edited a gate, then re-ran `baseline` and
    # every downstream `verify` reported GATE_INTEGRITY_UNCHANGED against the
    # new, already-tampered state. A genuine re-baseline (e.g. chief ruling a
    # driver hardening in mid-run) must be an explicit, visible act.
    RUN_ID="$(current_run_id)"
    PRIOR_RUN_ID="$(baseline_run_id)"

    # Refuse ONLY a re-baseline inside the run that took the baseline. That is
    # the move that hides a tamper. A baseline belonging to a DIFFERENT run is
    # simply last run's leftover in a gitignored directory: archive it and take
    # a fresh one, because a new run legitimately establishes its own start
    # state and must not be blocked by the previous one.
    if [ -f "$BASELINE" ] && [ "$PRIOR_RUN_ID" = "$RUN_ID" ] && [ "${RESET_BASELINE:-0}" != "1" ]; then
      echo "GATE_INTEGRITY_ERROR: run $RUN_ID already has a baseline at $BASELINE"
      echo "Re-baselining a live run hides any tamper from before this point."
      echo "If this is a deliberate, chief-approved amendment, set"
      echo "RESET_BASELINE=1 — the prior manifest is archived, never discarded —"
      echo "otherwise 'git checkout -- <path>' to restore the tampered file."
      exit 1
    fi
    if [ -f "$BASELINE" ]; then
      # Archive rather than overwrite: every prior manifest stays on disk, so a
      # reset is a visible, reviewable act instead of a silent replacement.
      ARCHIVE="$BASELINE_DIR/gate-integrity.baseline.$(date -u +%Y%m%dT%H%M%SZ).txt"
      cp "$BASELINE" "$ARCHIVE"
      echo "GATE_INTEGRITY_RESET: prior baseline archived to $ARCHIVE"
    fi
    {
      echo "# run_id: $RUN_ID"
      echo "# taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      manifest
    } > "$BASELINE"
    sha256_of "$BASELINE" > "$LOCK"
    {
      echo "gate: gate-integrity"
      echo "phase: baseline"
      echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "baseline_sha256: $(cat "$LOCK")"
      echo "run_id: $RUN_ID"
      echo "---"
      cat "$BASELINE"
    } > "$EVIDENCE"
    echo "GATE_INTEGRITY_BASELINE: $(grep -vc '^#' "$BASELINE" | tr -d ' ') files hashed, baseline_sha256=$(cat "$LOCK")"
    # Echoed in full so the run log carries an independent copy. A baseline that
    # exists only in the file the guard reads can be edited alongside the gate.
    cat "$BASELINE"
    exit 0
    ;;

  verify)
    mkdir -p "$(dirname "$EVIDENCE")"
    if [ ! -f "$BASELINE" ]; then
      # Fail closed. No baseline means no evidence that the gates are the ones
      # the run started with, and an unverifiable green is exactly the thing
      # this guard exists to stop being reported as a green.
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_NO_BASELINE exit=1  # $BASELINE missing"
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_VIOLATION: no baseline at $BASELINE — gate provenance cannot be established"
      exit 1
    fi

    # The baseline file itself must be the one written at baseline time. A
    # re-baseline (F-01) changes $BASELINE's own bytes without touching any
    # scored gate, so a plain diff of $BASELINE against itself always agrees —
    # this is the check that catches that class of tamper.
    if [ ! -f "$LOCK" ]; then
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_NO_LOCK exit=1  # $LOCK missing — baseline provenance cannot be established"
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_VIOLATION: no baseline lock at $LOCK — baseline may have been swapped"
      exit 1
    fi
    BASELINE_NOW_SHA="$(sha256_of "$BASELINE")"
    BASELINE_LOCK_SHA="$(cat "$LOCK")"
    if [ "$BASELINE_NOW_SHA" != "$BASELINE_LOCK_SHA" ]; then
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_BASELINE_SWAPPED exit=1"
        echo "baseline locked at:  $BASELINE_LOCK_SHA"
        echo "baseline now:        $BASELINE_NOW_SHA"
        echo "The baseline file itself changed since it was recorded — it was"
        echo "re-baselined, edited, or restored from a different copy mid-run."
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_VIOLATION: baseline file changed since it was locked ($BASELINE_LOCK_SHA -> $BASELINE_NOW_SHA)"
      exit 1
    fi

    # A baseline belonging to another run proves nothing about this one. This
    # is the case that let three GATE_INTEGRITY_OK lines be reported in run
    # f8780ed6 against baselines amended mid-run (F-01): the comparison
    # succeeded, but not against the state the run started from.
    RUN_ID="$(current_run_id)"
    PRIOR_RUN_ID="$(baseline_run_id)"
    if [ -n "$PRIOR_RUN_ID" ] && [ "$PRIOR_RUN_ID" != "$RUN_ID" ]; then
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_RUN_MISMATCH exit=1  # baseline run_id=$PRIOR_RUN_ID, current run_id=$RUN_ID"
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_VIOLATION: baseline belongs to run $PRIOR_RUN_ID, not $RUN_ID — it cannot attest to this run"
      exit 1
    fi

    # The lock is the only thing that notices the baseline FILE was swapped
    # between baseline and verify, since `.agent-relay/` is gitignored.
    if [ -f "$LOCK" ]; then
      EXPECTED_LOCK="$(cat "$LOCK")"
      ACTUAL_LOCK="$(sha256_of "$BASELINE")"
      if [ "$EXPECTED_LOCK" != "$ACTUAL_LOCK" ]; then
        {
          echo "gate: gate-integrity"
          echo "phase: verify"
          echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          echo "---"
          echo "GATE_INTEGRITY_BASELINE_SWAPPED exit=1"
          echo "expected baseline sha256: $EXPECTED_LOCK"
          echo "actual   baseline sha256: $ACTUAL_LOCK"
        } > "$EVIDENCE"
        echo "GATE_INTEGRITY_VIOLATION: the baseline file itself was modified after it was taken"
        exit 1
      fi
    fi

    CURRENT="$(mktemp)"
    trap 'rm -f "$CURRENT"' EXIT
    {
      echo "# run_id: $PRIOR_RUN_ID"
      awk '/^# taken:/ { print; exit }' "$BASELINE"
      manifest "$BASELINE"
    } > "$CURRENT"

    if diff -u "$BASELINE" "$CURRENT" > /dev/null 2>&1; then
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_UNCHANGED exit=0  # $(grep -vc '^#' "$CURRENT" | tr -d ' ') files"
        cat "$CURRENT"
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_OK: $(grep -vc '^#' "$CURRENT" | tr -d ' ') gate files unchanged since run start"
      exit 0
    fi

    {
      echo "gate: gate-integrity"
      echo "phase: verify"
      echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "---"
      echo "GATE_INTEGRITY_VIOLATION exit=1"
      echo ""
      echo "A gate scored by this run changed after the run started. Every green"
      echo "this run reports is void: the instrument was reshaped by what it was"
      echo "measuring. A repair owner may fix code, tests or config; it may never"
      echo "edit the gate it is judged by, and it may never delete a check."
      echo ""
      echo "baseline -> current:"
      diff -u "$BASELINE" "$CURRENT"
      echo ""
      echo "changed files:"
      diff "$BASELINE" "$CURRENT" | grep -E '^[<>]' | awk '{print $NF}' | sort -u
      echo ""
      DELETED_NOW="$(grep '^DELETED' "$CURRENT" | awk '{print $NF}' | sort -u)"
      if [ -n "$DELETED_NOW" ]; then
        echo "DELETED outright (a deleted check is not a reverted check):"
        echo "$DELETED_NOW"
        echo ""
      fi
      echo ""
      echo "restore with: git checkout -- <path>  (never by re-baselining)"
    } > "$EVIDENCE"

    echo "GATE_INTEGRITY_VIOLATION: a gate changed under the run"
    cat "$EVIDENCE"
    exit 1
    ;;

  *)
    echo "usage: $0 {baseline|verify}"
    exit 2
    ;;
esac
