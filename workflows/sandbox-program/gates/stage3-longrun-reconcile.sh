#!/usr/bin/env bash
# Stage 3 gate — the long-running provider reconciliation.
# Brief: chief/.briefs/sbx-longrun-reconcile-0824.md
#
# Deliverable: ONE document that supersedes sandbox-router#16 and #17, plus a
# recommendation. This gate checks the document answers the four axes with
# per-claim evidence labels, rules explicitly on the disputed Daytona cap
# question, gives a crossover point rather than a single-number ranking, and
# lists what could not be established as UNKNOWN rather than inferring it.
#
# F-12: sandbox-router is actually PRIVATE (verified: `gh repo view
# AgentWorkforce/sandbox-router --json visibility`), not PUBLIC as an earlier
# version of this comment claimed — REPAIR_RULES in the driver had the same
# wrong premise; see workflows/sandbox-program/gates/lane-reconcile.sh for a
# deterministic per-lane visibility check derived at runtime instead of
# hardcoded. This doc's own PRIVATE- filename already signals it is not meant
# for a public surface, and it lives in the private repo where it belongs.
# S3_NO_RAW_TOKENS below only checks for raw credential-shaped strings in the
# doc itself — it does NOT check whether this content gets pasted elsewhere
# into a public repo or doc; no such cross-repo check exists here.
set -uo pipefail
# Resolve the library next to this script without changing the runner cwd —
# ARTIFACTS_ROOT is relative to the workflow cwd, not to the gates directory.
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "stage3-longrun-reconcile"

REPO="${STAGE3_REPO:-$AW_ROOT/sandbox-router-longrun-0824}"
DOC="${STAGE3_DOC:-$REPO/docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md}"

file_check S3_DOC_PRESENT "$DOC"

# heading_section_check <name> <heading-pattern> [window-lines]
# F-11: a bare word match (`crossover`, `RECOMMENDATION`, ...) anywhere in a
# 751-line doc proves nothing — it would pass on a single passing mention with
# no real analysis behind it. This requires a labelled markdown heading
# matching <heading-pattern>, AND at least one evidence label (OBSERVED /
# DOCUMENTED / INFERRED) within <window-lines> lines after it, so the section
# has to actually exist and actually carry the evidence discipline the
# contract asks for.
heading_section_check() {
  local name="$1" heading_pat="$2" window="${3:-40}"
  local rc=1 line_no note="heading: $heading_pat"
  line_no=$(grep -nE "$heading_pat" "$DOC" 2>/dev/null | head -1 | cut -d: -f1)
  if [ -n "$line_no" ]; then
    if sed -n "${line_no},$((line_no + window))p" "$DOC" | grep -qE 'OBSERVED|DOCUMENTED|INFERRED'; then
      rc=0
      note="heading at line $line_no, labelled evidence within $window lines"
    else
      note="heading at line $line_no but no OBSERVED/DOCUMENTED/INFERRED within $window lines"
    fi
  else
    note="no heading matching: $heading_pat"
  fi
  record "$name" "$rc" "$note"
}

# ── The four axes ───────────────────────────────────────────────────────────
heading_section_check S3_AXIS_INDEFINITE '^#+.*[Aa]xis 1'
heading_section_check S3_AXIS_IDLE_COST '^#+.*[Aa]xis 2'
heading_section_check S3_AXIS_RESTART '^#+.*[Aa]xis 3'
heading_section_check S3_AXIS_OUR_STACK '^#+.*[Aa]xis 4'

# ── Evidence discipline, applied per claim ──────────────────────────────────
grep_check S3_LABEL_OBSERVED "$DOC" 'OBSERVED'
grep_check S3_LABEL_DOCUMENTED "$DOC" 'DOCUMENTED'
grep_check S3_LABEL_INFERRED "$DOC" 'INFERRED'
grep_check S3_UNKNOWN_LIST "$DOC" 'UNKNOWN'

# ── The rulings the brief actually asked for ────────────────────────────────
grep_check S3_DAYTONA_CAP_RULING "$DOC" 'DAYTONA_CAP_RULING'
heading_section_check S3_CROSSOVER '^#+.*[Cc]rossover' 60
heading_section_check S3_RECOMMENDATION '^#+.*RECOMMENDATION'
grep_check S3_SUPERSEDES_BOTH_PRS "$DOC" '#16'
grep_check S3_SUPERSEDES_17 "$DOC" '#17'

# ── Public-repo hygiene ─────────────────────────────────────────────────────
absent_check S3_NO_RAW_TOKENS "$DOC" '(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-)'

gate_finish
