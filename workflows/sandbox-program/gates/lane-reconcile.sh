#!/usr/bin/env bash
# Deterministic lane reconcile — the step that keeps the repairable gates on
# the critical path.
#
# The four sandbox-program lanes are live, long-running, interactive agents in
# their own clones. If the first gate depended on one of them, a dropped PTY or
# a transport failure would masquerade as "the product failed". So the flow
# never depends on a lane process. It depends on THIS: a deterministic read of
# what is actually on disk in each lane's clone — branch, HEAD, working-tree
# status, diff stats against the base, and the presence of the files each lane
# owes. Whatever is missing becomes work for the repair owner.
set -uo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "lane-reconcile"

# lane <label> <repo-path> <base-ref> <scoped-paths...>
lane() {
  local label="$1" repo="$2" base="$3"
  shift 3
  echo "" >> "$EVIDENCE"
  echo "## lane: $label" >> "$EVIDENCE"
  if [ ! -d "$repo/.git" ]; then
    record "RECON_${label}_CLONE" 1 "not a git clone: $repo"
    return 0
  fi
  record "RECON_${label}_CLONE" 0 "$repo"
  {
    echo "branch: $( cd "$repo" && git rev-parse --abbrev-ref HEAD 2>/dev/null )"
    echo "head:   $( cd "$repo" && git log -1 --pretty='%h %s' 2>/dev/null )"
    echo "status --short (scoped):"
    ( cd "$repo" && git status --short -- "$@" 2>/dev/null ) | sed 's/^/  /'
    echo "diff --stat vs $base:"
    ( cd "$repo" && git diff --stat "$base"...HEAD -- "$@" 2>/dev/null | tail -20 ) | sed 's/^/  /'
  } >> "$EVIDENCE"
  # `git status --short` and not `git diff --quiet`: the latter ignores
  # untracked files, so a valid new test, doc, or package directory would be
  # misread as "no changes".
  local changed
  changed=$( cd "$repo" && { git status --short -- "$@"; git diff --stat "$base"...HEAD -- "$@"; } 2>/dev/null )
  if [ -z "$changed" ]; then
    record "RECON_${label}_MATERIALIZED" 1 "no committed or working-tree change in scope"
  else
    record "RECON_${label}_MATERIALIZED" 0
  fi

  # F-08: nothing recorded whether a lane pushed during the run, so the fact
  # was unrecoverable from evidence alone. Informational (exit=0 whenever the
  # read itself succeeds) — this is a visibility record, not a hard gate; the
  # standing question of who is allowed to push a lane branch is chief/Khaliq's
  # call, not this gate's.
  local upstream unpushed_count
  upstream=$( cd "$repo" && git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null )
  if [ -n "$upstream" ]; then
    unpushed_count=$( cd "$repo" && git log --oneline "${upstream}..HEAD" 2>/dev/null | wc -l | tr -d ' ' )
    record "RECON_${label}_UNPUSHED" 0 "$unpushed_count unpushed commit(s) vs $upstream"
  else
    record "RECON_${label}_UNPUSHED" 0 "no upstream tracking branch configured"
  fi

  # F-13: reconcile scoped this lane to specific paths (e.g. `src docs`), so an
  # untracked file elsewhere in the clone — like a new .github/ CI workflow —
  # was invisible to evidence. Record it; do not fail the gate on it, since
  # whether a repair owner may add CI config is a ruling this check does not
  # make (see claude-review.md F-13).
  local untracked_ci
  untracked_ci=$( cd "$repo" && git status --short --porcelain -- '.github' 2>/dev/null )
  if [ -n "$untracked_ci" ]; then
    record "RECON_${label}_UNTRACKED_CI" 0 "untracked/changed under .github/: $(echo "$untracked_ci" | tr '\n' ';' | sed 's/;$//')"
  else
    record "RECON_${label}_UNTRACKED_CI" 0 "no untracked/changed files under .github/"
  fi

  # F-12: the repo-visibility roster in REPAIR_RULES was hardcoded and wrong
  # (sandbox-router is PRIVATE, not PUBLIC as the driver text claimed). Derive
  # it at runtime instead of trusting a hardcoded list.
  local origin_url slug visibility vrc
  origin_url=$( cd "$repo" && git remote get-url origin 2>/dev/null )
  slug=$(printf '%s' "$origin_url" | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')
  vrc=0
  if [ -n "$slug" ]; then
    visibility=$(gh repo view "$slug" --json visibility -q .visibility 2>>"$LOG") || vrc=$?
  else
    visibility=""
    vrc=1
  fi
  if [ "$vrc" -eq 0 ] && [ -n "$visibility" ]; then
    record "RECON_${label}_VISIBILITY" 0 "$slug is $visibility"
  else
    record "RECON_${label}_VISIBILITY" 1 "could not determine visibility for $slug (origin: $origin_url)"
  fi
}

lane STAGE1_PROVISIONING "${STAGE1_REPO:-$AW_ROOT/cloud-provisioning-0824}" \
  "${STAGE1_BASE:-origin/main}" scripts tests infra
lane STAGE2_SANDBOX30 "${STAGE2_REPO:-$AW_ROOT/sandbox-sec30-0824}" \
  "${STAGE2_BASE:-origin/main}" src
lane STAGE3_LONGRUN "${STAGE3_REPO:-$AW_ROOT/sandbox-router-longrun-0824}" \
  "${STAGE3_BASE:-origin/main}" docs
lane STAGE4_ROUTING "${STAGE4_ROUTER_REPO:-$AW_ROOT/sandbox-router}" \
  "${STAGE4_ROUTER_BASE:-origin/main}" src docs

# Required deliverables that no lane has necessarily produced yet. A missing
# one is a red check with an owner, not a silent gap.
file_check RECON_STAGE1_PROBE "${STAGE1_PROBE_EVIDENCE:-$ARTIFACTS_ROOT/stage1-freshbox-probe.txt}"
file_check RECON_STAGE3_DOC "${STAGE3_DOC:-$AW_ROOT/sandbox-router-longrun-0824/docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md}"

gate_finish
