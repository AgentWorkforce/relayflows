#!/usr/bin/env bash
#
# answer-provenance-check.sh — an *.ANSWER.md is only a standing ruling if its
# author can be established.
#
# WHY THIS EXISTS
#   The questions/ directory has no authorship control: any repair owner can
#   write an *.ANSWER.md into the same directory it is told to write its
#   questions to, and REPAIR_RULES tells every later step to treat whatever is
#   there as a binding standing ruling. `repair-program-acceptance.ANSWER.md`
#   did exactly that once already — honestly self-labelled as agent-authored,
#   but structurally the same move as editing a gate: an agent authoring the
#   authority that excuses its own reds (claude-review.md F-03).
#
# WHAT IT CHECKS
#   Every ${ARTIFACTS}/questions/*.ANSWER.md must begin with a line matching
#   exactly `RULED_BY: chief` or `RULED_BY: khaliq`. Anything else is not a
#   ruling other steps may act on.
#
# Exit 0 = every ANSWER.md present has a valid header (zero ANSWER.md files is
# also fine — nothing to establish). Exit 1 = at least one lacks it.

set -uo pipefail

ARTIFACTS="${1:?usage: answer-provenance-check.sh <artifacts-dir>}"
QDIR="$ARTIFACTS/questions"

if [ ! -d "$QDIR" ]; then
  echo "ANSWER_PROVENANCE_OK exit=0  # no questions/ directory yet"
  exit 0
fi

rc=0
COUNT=0
BAD=""
while IFS= read -r -d '' f; do
  COUNT=$((COUNT + 1))
  LINE1="$(head -1 "$f")"
  case "$LINE1" in
    "RULED_BY: chief"|"RULED_BY: khaliq") : ;;
    *)
      rc=1
      BAD="$BAD
$f  (line 1: \"$LINE1\")"
      ;;
  esac
done < <(find "$QDIR" -maxdepth 1 -name '*.ANSWER.md' -print0)

if [ "$rc" -ne 0 ]; then
  echo "ANSWER_PROVENANCE_VIOLATION exit=1"
  echo "The following *.ANSWER.md files do not start with a valid RULED_BY:"
  echo "chief|khaliq header and must not be treated as standing rulings:"
  echo "$BAD"
  exit 1
fi

echo "ANSWER_PROVENANCE_OK exit=0  # $COUNT ANSWER.md file(s) checked"
exit 0
