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

EVIDENCE="${ARTIFACTS_ROOT:-$PWD/.workflow-artifacts/sandbox-program}/gate-integrity-evidence.txt"

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
      awk '{ $1 = ""; sub(/^[[:space:]]+/, ""); print }' "$expected"
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
    mkdir -p "$BASELINE_DIR" "$(dirname "$EVIDENCE")"
    manifest > "$BASELINE"
    {
      echo "gate: gate-integrity"
      echo "phase: baseline"
      echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "---"
      cat "$BASELINE"
    } > "$EVIDENCE"
    echo "GATE_INTEGRITY_BASELINE: $(wc -l < "$BASELINE" | tr -d ' ') files hashed"
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

    CURRENT="$(mktemp)"
    trap 'rm -f "$CURRENT"' EXIT
    manifest "$BASELINE" > "$CURRENT"

    if diff -u "$BASELINE" "$CURRENT" > /dev/null 2>&1; then
      {
        echo "gate: gate-integrity"
        echo "phase: verify"
        echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "---"
        echo "GATE_INTEGRITY_UNCHANGED exit=0  # $(wc -l < "$CURRENT" | tr -d ' ') files"
        cat "$CURRENT"
      } > "$EVIDENCE"
      echo "GATE_INTEGRITY_OK: $(wc -l < "$CURRENT" | tr -d ' ') gate files unchanged since run start"
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
