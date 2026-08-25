#!/usr/bin/env bash
#
# Negative tests for gate-integrity.sh.
#
# F-01 asked for exactly one of these and it was never written: the guard was
# shipped, reported GATE_INTEGRITY_OK three times in run f8780ed6, and was
# defeated in that same run by a one-line move. A guard with no negative test
# is a claim, not a control.
#
#   run: bash workflows/sandbox-program/gate-integrity.test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$REPO_ROOT/workflows/sandbox-program/gate-integrity.sh"
PASS=0; FAIL=0

# Each test runs against a throwaway clone of the gate surface so no test can
# touch the real baseline or the real gates.
setup() {
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/workflows/sandbox-program/gates" "$WORK/.agent-relay"
  cp "$REPO_ROOT"/workflows/sandbox-program/gates/*.sh "$WORK/workflows/sandbox-program/gates/"
  cp "$GUARD" "$WORK/workflows/sandbox-program/gate-integrity.sh"
  cp "$REPO_ROOT/workflows/sandbox-program-drive.ts" "$WORK/workflows/"
  RUN_ID_FILE="$WORK/.run-id"
  echo "testrun0001" > "$RUN_ID_FILE"
}
teardown() { rm -rf "$WORK"; }

guard() (
  cd "$WORK" && AGENT_RELAY_RUN_ID_FILE="$RUN_ID_FILE" \
    ARTIFACTS_ROOT="$WORK/artifacts" REPO_ROOT="$WORK" \
    bash workflows/sandbox-program/gate-integrity.sh "$@"
)

check() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    echo "  PASS  $name"; PASS=$((PASS+1))
  else
    echo "  FAIL  $name (wanted exit $want, got $got)"; FAIL=$((FAIL+1))
  fi
}

echo "gate-integrity negative tests"

# ── F-01: the exact sequence that defeated the guard ────────────────────────
# baseline -> edit a gate -> re-baseline -> verify MUST fail.
# Before the runId binding, step 3 silently succeeded and step 4 exited 0.
setup
guard baseline >/dev/null 2>&1
echo '# widened to match a pre-existing package' >> "$WORK/workflows/sandbox-program/gates/stage4-capability-routing.sh"
guard baseline >/dev/null 2>&1; rebase_rc=$?
check "F-01 re-baseline inside a run is refused" 1 "$rebase_rc"
guard verify >/dev/null 2>&1; verify_rc=$?
check "F-01 verify still fails after an attempted re-baseline" 1 "$verify_rc"
teardown

# ── F-01: a forced reset is allowed but leaves an archive ───────────────────
setup
guard baseline >/dev/null 2>&1
echo '# declared amendment' >> "$WORK/workflows/sandbox-program/gates/stage2-sandbox30.sh"
( cd "$WORK" && AGENT_RELAY_RUN_ID_FILE="$RUN_ID_FILE" ARTIFACTS_ROOT="$WORK/artifacts" \
  REPO_ROOT="$WORK" RESET_BASELINE=1 bash workflows/sandbox-program/gate-integrity.sh baseline ) >/dev/null 2>&1
archives=$(ls "$WORK"/.agent-relay/gate-integrity.baseline.*.txt 2>/dev/null | wc -l | tr -d ' ')
check "forced reset archives the prior manifest" 1 "$archives"
teardown

# ── F-16: a NEW run must be able to take a baseline over last run's leftover ─
# This is the regression that made the next run die at step 2 (failOnError).
setup
guard baseline >/dev/null 2>&1
echo "testrun0002" > "$RUN_ID_FILE"          # a different run, same host, same dir
guard baseline >/dev/null 2>&1; newrun_rc=$?
check "F-16 a new run may baseline over a stale one" 0 "$newrun_rc"
guard verify >/dev/null 2>&1; newrun_verify=$?
check "F-16 and that fresh baseline verifies clean" 0 "$newrun_verify"
teardown

# ── a baseline from another run cannot attest to this one ───────────────────
setup
guard baseline >/dev/null 2>&1
echo "testrun0003" > "$RUN_ID_FILE"          # verify under a different run id
guard verify >/dev/null 2>&1; mismatch_rc=$?
check "stale baseline is a run mismatch, not a pass" 1 "$mismatch_rc"
teardown

# ── the baseline FILE being swapped is caught by the lock ───────────────────
setup
guard baseline >/dev/null 2>&1
echo '# tampered' >> "$WORK/workflows/sandbox-program/gates/lane-reconcile.sh"
# Hand-edit the baseline to agree with the tampered gate, as a silent re-baseline would.
( cd "$WORK" && sha=$(shasum -a 256 workflows/sandbox-program/gates/lane-reconcile.sh | awk '{print $1}')
  sed -i '' "s|^[0-9a-f]*  workflows/sandbox-program/gates/lane-reconcile.sh|$sha  workflows/sandbox-program/gates/lane-reconcile.sh|" .agent-relay/gate-integrity.baseline.txt )
guard verify >/dev/null 2>&1; swap_rc=$?
check "a swapped baseline file is caught by the lock" 1 "$swap_rc"
teardown

# ── the ordinary tamper still fails ────────────────────────────────────────
setup
guard baseline >/dev/null 2>&1
echo '# rewritten by the owner it judges' >> "$WORK/workflows/sandbox-program/gates/stage1-provisioning.sh"
guard verify >/dev/null 2>&1; tamper_rc=$?
check "an edited gate fails verify" 1 "$tamper_rc"
teardown

# ── a deleted check still fails ────────────────────────────────────────────
setup
guard baseline >/dev/null 2>&1
rm "$WORK/workflows/sandbox-program/gates/stage4-capability-routing.sh"
guard verify >/dev/null 2>&1; del_rc=$?
check "a deleted gate fails verify" 1 "$del_rc"
teardown

# ── the clean case still passes ────────────────────────────────────────────
setup
guard baseline >/dev/null 2>&1
guard verify >/dev/null 2>&1; clean_rc=$?
check "an untouched gate surface verifies clean" 0 "$clean_rc"
teardown

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
