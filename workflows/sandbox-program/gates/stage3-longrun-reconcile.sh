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
# sandbox-router is a PUBLIC repo, so the gate also refuses content that would
# leak: raw tokens, or the PRIVATE- economics material pasted into a public doc.
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

# ── The four axes ───────────────────────────────────────────────────────────
grep_check S3_AXIS_INDEFINITE "$DOC" 'autoStopInterval|indefinite|idle reaper|wall-clock cap'
grep_check S3_AXIS_IDLE_COST "$DOC" 'idle|billed-while-idle'
grep_check S3_AXIS_RESTART "$DOC" 'restart|stop.?resume|survive'
grep_check S3_AXIS_OUR_STACK "$DOC" 'mount|gh |roster|attach'

# ── Evidence discipline, applied per claim ──────────────────────────────────
grep_check S3_LABEL_OBSERVED "$DOC" 'OBSERVED'
grep_check S3_LABEL_DOCUMENTED "$DOC" 'DOCUMENTED'
grep_check S3_LABEL_INFERRED "$DOC" 'INFERRED'
grep_check S3_UNKNOWN_LIST "$DOC" 'UNKNOWN'

# ── The rulings the brief actually asked for ────────────────────────────────
grep_check S3_DAYTONA_CAP_RULING "$DOC" 'DAYTONA_CAP_RULING'
grep_check S3_CROSSOVER "$DOC" 'crossover|breakeven|59\.8'
grep_check S3_RECOMMENDATION "$DOC" 'RECOMMENDATION'
grep_check S3_SUPERSEDES_BOTH_PRS "$DOC" '#16'
grep_check S3_SUPERSEDES_17 "$DOC" '#17'

# ── Public-repo hygiene ─────────────────────────────────────────────────────
absent_check S3_NO_RAW_TOKENS "$DOC" '(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-)'

gate_finish
