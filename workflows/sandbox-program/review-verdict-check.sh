#!/usr/bin/env bash
#
# review-verdict-check.sh — the one place the claude-review-final /
# claude-signoff / BLOCKED_NO_COMMIT verdict is scored.
#
# WHY THIS EXISTS
#   `final-review-pass-gate` and `commit-if-green` used to score the same
#   review independently, one of them by `grep -q NO_ISSUES_FOUND` on the
#   reviewer's prose — a substring match that a review saying "this is NOT
#   NO_ISSUES_FOUND, see 6 blockers" would pass (claude-review.md finding
#   F-04). Scoring it twice, differently, also meant the two gates could
#   disagree. This script is the single source of truth both call.
#
# Exit 0 = review verdict is CLEAN, or FINDINGS with every finding_id named
#          in a signoff. Exit 1 = blocked, unresolved, or malformed.
#
# Usage: review-verdict-check.sh <artifacts-dir>

set -uo pipefail

ARTIFACTS="${1:?usage: review-verdict-check.sh <artifacts-dir>}"
REVIEW="$ARTIFACTS/claude-review-final.md"
SIGNOFF="$ARTIFACTS/claude-signoff.md"
BLOCKED="$ARTIFACTS/BLOCKED_NO_COMMIT.md"

if [ ! -f "$REVIEW" ]; then
  echo "REVIEW_GATE_RED: no final review artifact ($REVIEW)"
  exit 1
fi

# Blocked branch first: a blocked artifact says findings remain and were not
# fixed, so it must never be shadowed by a stray or self-written signoff.
if [ -f "$BLOCKED" ]; then
  echo "REVIEW_GATE_BLOCKED: findings remain, blocked artifact present"
  exit 1
fi

# Line 1 must be the exact verdict token, never a substring match on prose.
VERDICT="$(head -1 "$REVIEW")"
if [ "$VERDICT" = "REVIEW_VERDICT: CLEAN" ]; then
  echo "REVIEW_GATE_OK: CLEAN"
  exit 0
fi
if [ "$VERDICT" != "REVIEW_VERDICT: FINDINGS" ]; then
  echo "REVIEW_GATE_RED: line 1 of $REVIEW is not a recognised verdict: $VERDICT"
  exit 1
fi

if [ ! -f "$SIGNOFF" ]; then
  echo "REVIEW_GATE_RED: findings remain and no signoff artifact exists"
  exit 1
fi

# A signoff over FINDINGS must name every finding_id, or it is the fixer
# certifying its own work by merely touching a file.
SIGN_LINE="$(head -1 "$SIGNOFF")"
case "$SIGN_LINE" in
  SIGNED_OFF_FINDINGS:*) : ;;
  *)
    echo "REVIEW_GATE_RED: $SIGNOFF line 1 is not SIGNED_OFF_FINDINGS: ...: $SIGN_LINE"
    exit 1
    ;;
esac

# Ids are parsed only from lines of the exact shape `finding_id: F-NN`
# (claude-review-final.md F-20) — the reviewer prompt requires that shape.
# Zero ids parsed from a FINDINGS verdict is a scoring failure, not a signoff
# of nothing: the vacuous pass F-04 was raised to close, one layer down.
IDS="$(grep -oE '^finding_id: F-[0-9]+$' "$REVIEW" | awk '{print $2}' | sort -u)"
if [ -z "$IDS" ]; then
  echo "REVIEW_GATE_RED: $REVIEW is REVIEW_VERDICT: FINDINGS but no finding_id: F-NN lines could be parsed"
  exit 1
fi

MISSING=""
for fid in $IDS; do
  n="${fid#F-}"
  n="${n#0}"
  n="${n#0}"
  n="${n#0}"
  # Match only on the SIGNED_OFF_FINDINGS: line, with a word boundary, so
  # "F-1" cannot prefix-match "F-10" and an id mentioned elsewhere in the
  # file (e.g. "F-03 is NOT fixed") cannot count as signed off.
  echo "$SIGN_LINE" | grep -qE "\\bF-0*${n}\\b" || MISSING="$MISSING $fid"
done
if [ -n "$MISSING" ]; then
  echo "REVIEW_GATE_RED: signoff omits findings:$MISSING"
  exit 1
fi

echo "REVIEW_GATE_OK: FINDINGS, all signed off"
exit 0
