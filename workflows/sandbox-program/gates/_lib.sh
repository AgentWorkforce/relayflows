#!/usr/bin/env bash
# Shared helpers for the sandbox-program gate scripts.
#
# Verification discipline these helpers exist to enforce:
#   * Every check is scored by the EXIT CODE of the command itself, never by
#     the absence of an error string and never through a pipe. `$?` after a
#     pipe reads the last stage, so command output is written to a log file
#     with `>>` and the exit code captured with `|| rc=$?`.
#   * A check that could not run is a FAIL, not a skip.
#   * Every check appends one `NAME exit=N` line to the evidence file so a
#     later step, a repair agent, or a human reads the same record.

set -uo pipefail

AW_ROOT="${AW_ROOT:-$HOME/Projects/AgentWorkforce}"
ARTIFACTS_ROOT="${ARTIFACTS_ROOT:-$PWD/.workflow-artifacts/sandbox-program}"
mkdir -p "$ARTIFACTS_ROOT"

GATE_FAILED=0
GATE_CHECKS=0

gate_init() {
  GATE_NAME="$1"
  EVIDENCE="$ARTIFACTS_ROOT/${GATE_NAME}-evidence.txt"
  LOG="$ARTIFACTS_ROOT/${GATE_NAME}.log"
  : > "$EVIDENCE"
  : > "$LOG"
  {
    echo "gate: $GATE_NAME"
    echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "host_cwd: $PWD"
    echo "aw_root: $AW_ROOT"
    echo "---"
  } >> "$EVIDENCE"
}

# record <name> <exit_code> [note]
record() {
  local name="$1" rc="$2" note="${3:-}"
  GATE_CHECKS=$((GATE_CHECKS + 1))
  if [ "$rc" -ne 0 ]; then
    GATE_FAILED=$((GATE_FAILED + 1))
  fi
  if [ -n "$note" ]; then
    echo "$name exit=$rc  # $note" >> "$EVIDENCE"
  else
    echo "$name exit=$rc" >> "$EVIDENCE"
  fi
}

# run_check <name> <workdir> <command...>
# Runs the command with output appended to the gate log, scores it by its own
# exit code, and records the result. A missing workdir is a FAIL.
run_check() {
  local name="$1" dir="$2"
  shift 2
  local rc=0
  if [ ! -d "$dir" ]; then
    record "$name" 1 "workdir missing: $dir"
    return 0
  fi
  {
    echo ""
    echo "=== $name :: (cd $dir && $*) ==="
  } >> "$LOG"
  ( cd "$dir" && "$@" ) >> "$LOG" 2>&1 || rc=$?
  record "$name" "$rc"
}

# grep_check <name> <file> <extended-regex> — presence assertion in a file.
grep_check() {
  local name="$1" file="$2" pattern="$3"
  local rc=0
  if [ ! -f "$file" ]; then
    record "$name" 1 "file missing: $file"
    return 0
  fi
  grep -Eq "$pattern" "$file" || rc=$?
  record "$name" "$rc" "pattern: $pattern"
}

# absent_check <name> <file-or-dir> <extended-regex> — the pattern must NOT appear.
absent_check() {
  local name="$1" target="$2" pattern="$3"
  local rc=0
  if [ ! -e "$target" ]; then
    record "$name" 1 "target missing: $target"
    return 0
  fi
  if grep -REq "$pattern" "$target"; then
    rc=1
  fi
  record "$name" "$rc" "must-not-match: $pattern"
}

# file_check <name> <path>
file_check() {
  local name="$1" path="$2"
  local rc=0
  [ -f "$path" ] || rc=1
  record "$name" "$rc" "$path"
}

# ci_check <name> <repo-slug> <branch>
# CI is read with `gh run list --branch`, never `--commit`: the commit filter
# has returned empty for commits with green workflows, and statusCheckRollup
# has hidden failing workflows. An EMPTY result is a FAIL, not a pass, and the
# latest run of EVERY workflow name must have conclusion "success".
ci_check() {
  local name="$1" slug="$2" branch="$3"
  local rc=0
  local json="$ARTIFACTS_ROOT/${GATE_NAME}-${name}-ci.json"
  gh run list --repo "$slug" --branch "$branch" --limit 100 \
    --json name,status,conclusion,headSha,createdAt > "$json" 2>> "$LOG" || rc=$?
  if [ "$rc" -ne 0 ]; then
    record "$name" "$rc" "gh run list failed for $slug@$branch"
    return 0
  fi
  local count
  count=$(jq 'length' < "$json" 2>> "$LOG" || echo 0)
  if [ "${count:-0}" -eq 0 ]; then
    record "$name" 1 "no workflow runs on $slug@$branch — empty is NOT a pass"
    return 0
  fi
  # Latest run per workflow name; every one must be completed/success.
  local red
  red=$(jq -r '
    group_by(.name)
    | map(sort_by(.createdAt) | last)
    | map(select(.status != "completed" or .conclusion != "success"))
    | map("\(.name)=\(.status)/\(.conclusion // "null")")
    | join(", ")
  ' < "$json" 2>> "$LOG")
  if [ -n "$red" ] && [ "$red" != "null" ]; then
    record "$name" 1 "non-green workflows on $slug@$branch: $red"
  else
    record "$name" 0 "all $count runs green per workflow on $slug@$branch"
  fi
}

gate_finish() {
  {
    echo "---"
    echo "checks: $GATE_CHECKS"
    echo "failed: $GATE_FAILED"
  } >> "$EVIDENCE"
  cat "$EVIDENCE"
  echo ""
  echo "log: $LOG"
  # bash 3.2 ships on macOS, so no ${var^^} — uppercase with tr.
  local upper
  upper=$(printf '%s' "$GATE_NAME" | tr '[:lower:]-' '[:upper:]_')
  if [ "$GATE_FAILED" -eq 0 ]; then
    echo "${upper}_OK"
    exit 0
  fi
  echo "${upper}_RED: $GATE_FAILED of $GATE_CHECKS checks failed"
  exit 1
}
