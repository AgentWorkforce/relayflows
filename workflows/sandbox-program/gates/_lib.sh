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

# ci_check <name> <repo-slug> <branch> [repo-dir]
# CI is read with `gh run list --branch`, never `--commit`: the commit filter
# has returned empty for commits with green workflows, and statusCheckRollup
# has hidden failing workflows. An EMPTY result is a FAIL, not a pass, and the
# latest run of EVERY workflow name must have conclusion "success".
#
# The run must also correspond to the lane clone's actual HEAD (claude-review.md
# F-06): `headSha` was already requested in the `--json` field list and written
# to the artifact but never checked, so a lane that commits locally without
# pushing — or is read before CI starts on a fresh push — could score green
# off a stale run for an older commit. If <repo-dir> is given, its
# `git rev-parse HEAD` must match the scored run's headSha or the check fails
# with a distinct note, rather than silently trusting whatever `gh` returns.
ci_check() {
  local name="$1" slug="$2" branch="$3" repo_dir="${4:-}"
  local rc=0
  # Overridable (claude-review-final.md F-23): fail-closed on truncation is
  # right, but a branch that legitimately accumulates 100+ runs needs an
  # escape hatch rather than a permanently red gate.
  local limit="${CI_RUN_LIMIT:-100}"
  local json="$ARTIFACTS_ROOT/${GATE_NAME}-${name}-ci.json"
  gh run list --repo "$slug" --branch "$branch" --limit "$limit" \
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
  if [ "${count:-0}" -eq "$limit" ]; then
    record "$name" 1 "gh run list returned exactly --limit $limit results for $slug@$branch — possible truncation, a workflow name may be silently missing from the scored set"
    return 0
  fi

  local head_sha="" head_unresolved=0
  if [ -n "$repo_dir" ]; then
    if [ -d "$repo_dir" ]; then
      head_sha="$(cd "$repo_dir" && git rev-parse HEAD 2>> "$LOG")" || head_sha=""
      [ -n "$head_sha" ] || head_unresolved=1
    else
      head_unresolved=1
    fi
  fi
  # A check that could not run is a FAIL, not a skip (_lib.sh's own
  # discipline, claude-review-final.md F-18): a repo_dir that is missing, a
  # plain directory, or has a detached/unborn HEAD used to fall through to
  # the unbound green below, scoring exactly as it did before HEAD binding
  # existed and with no note distinguishing "HEAD-verified green" from
  # "HEAD check silently unavailable".
  if [ -n "$repo_dir" ] && [ "$head_unresolved" -eq 1 ]; then
    record "$name" 1 "could not resolve HEAD for $repo_dir — workdir missing, not a git repo, or detached/unborn HEAD; HEAD-bound CI scoring requires it"
    return 0
  fi

  # Latest run per workflow name. Three outcomes, kept apart on purpose:
  #
  #   success  — green.
  #   skipped / neutral / cancelled — NOT a pass and NOT a failure. A path
  #     filter that skips a Preview deploy on a scripts-only change is correct;
  #     a classifier that skipped the job that mattered is how a green deploy
  #     shipped nothing in cloud#3155. Silently accepting it is the bug, so it
  #     is surfaced as its own state for an owner to rule on explicitly.
  #   anything else — failing.
  local failing skipped
  failing=$(jq -r '
    group_by(.name)
    | map(sort_by(.createdAt) | last)
    | map(select(
        .status != "completed"
        or ((.conclusion // "null") | . != "success" and . != "skipped" and . != "neutral")
      ))
    | map("\(.name)=\(.status)/\(.conclusion // "null")")
    | join(", ")
  ' < "$json" 2>> "$LOG")
  skipped=$(jq -r '
    group_by(.name)
    | map(sort_by(.createdAt) | last)
    | map(select(.status == "completed" and ((.conclusion // "null") == "skipped" or (.conclusion // "null") == "neutral")))
    | map(.name) | join(", ")
  ' < "$json" 2>> "$LOG")

  if [ -n "$failing" ] && [ "$failing" != "null" ]; then
    record "$name" 1 "FAILING workflows on $slug@$branch: $failing"
    return 0
  fi
  if [ -n "$skipped" ] && [ "$skipped" != "null" ]; then
    record "$name" 1 "NOT-RUN workflows on $slug@$branch: $skipped — skipped is neither pass nor fail; an owner must rule whether the skip is correct for this change"
    return 0
  fi

  if [ -n "$head_sha" ]; then
    local stale
    stale=$(jq -r --arg sha "$head_sha" '
      group_by(.name)
      | map(sort_by(.createdAt) | last)
      | map(select(.headSha != $sha))
      | map("\(.name)@\(.headSha)")
      | join(", ")
    ' < "$json" 2>> "$LOG")
    if [ -n "$stale" ] && [ "$stale" != "null" ]; then
      record "$name" 1 "runs exist and are green but not for HEAD ($head_sha) on $slug@$branch: $stale"
      return 0
    fi
    record "$name" 0 "all $count runs green per workflow on $slug@$branch, matching HEAD $head_sha"
    return 0
  fi

  record "$name" 0 "all $count runs green per workflow on $slug@$branch"
}

# run_check_tap <name> <dir> <allow-skip-pattern> <command...>
# Like run_check, but a "full test suite green" claim (e.g. contract B4) is
# not proven if the suite's exit code was 0 only because some tests were
# skipped (claude-review.md F-10). `ci_check` already refuses to treat a
# skipped workflow as a pass; `run_check` had no equivalent for a TAP-style
# test runner where `npm test` exits 0 whether 784 tests ran or 9 were
# env-gated out. This records the base check exactly like run_check, then a
# second `<name>_NO_UNALLOWED_SKIPS` check: PASS only if there were no skips,
# or every skip line matches <allow-skip-pattern> (an extended regex; pass ''
# to allow none). A skip that does not match the pattern is a FAIL — the same
# treatment `ci_check` gives a workflow that didn't run.
run_check_tap() {
  local name="$1" dir="$2" allow="$3"
  shift 3
  local rc=0
  if [ ! -d "$dir" ]; then
    record "$name" 1 "workdir missing: $dir"
    record "${name}_NO_UNALLOWED_SKIPS" 1 "workdir missing: $dir"
    return 0
  fi
  local outfile
  outfile="$(mktemp)"
  {
    echo ""
    echo "=== $name :: (cd $dir && $*) ==="
  } >> "$LOG"
  ( cd "$dir" && "$@" ) > "$outfile" 2>&1 || rc=$?
  cat "$outfile" >> "$LOG"
  record "$name" "$rc"

  # Only per-test TAP annotations ("ok N - name # SKIP reason"), never the
  # summary "# skipped N" line — that line has no reason text to match
  # against the allow-pattern and would otherwise always count as unallowed.
  local skip_lines
  skip_lines=$(grep -E '^[[:space:]]*(ok|not ok)[[:space:]]+[0-9]+.*#[[:space:]]*SKIP' "$outfile" || true)
  if [ -z "$skip_lines" ]; then
    record "${name}_NO_UNALLOWED_SKIPS" 0 "no skips"
    rm -f "$outfile"
    return 0
  fi
  local unallowed=""
  if [ -n "$allow" ]; then
    unallowed=$(printf '%s\n' "$skip_lines" | grep -Eiv "$allow" || true)
  else
    unallowed="$skip_lines"
  fi
  rm -f "$outfile"
  if [ -n "$unallowed" ]; then
    record "${name}_NO_UNALLOWED_SKIPS" 1 "skipped test(s) not on the allow-list: $(printf '%s' "$unallowed" | tr '\n' '|')"
  else
    record "${name}_NO_UNALLOWED_SKIPS" 0 "all skips matched allow-pattern: $allow"
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
