#!/usr/bin/env bash
#
# secret-scan.sh — deterministic pre-commit scan of exactly what's staged.
#
# sandbox, sandbox-router and relayflows are PUBLIC repos: no customer names,
# no credentials, no exploit paths in any file, commit, issue or comment.
# `commit-if-green` is the only step that writes history, and it stages an
# artifacts allow-list built by repair-owner agents — this is the last check
# before that content becomes public (claude-review.md F-05).
#
# Scored by exit code: 0 = clean, 1 = at least one hit. Never read past a
# pipe — `git diff --cached --name-only` output is captured into a real
# array, and each file's content check sets $rc directly.

set -uo pipefail

# Common credential-shaped patterns. Anchored where practical to cut false
# positives; a fixture token like `relay_pa_thisisasecrettoken_do_not_leak`
# is expected to match `relay_pa_` — that is the point. The `_API_KEY` rule
# requires an actual value after the `=` (claude-review-final.md F-16): a
# bare `DAYTONA_API_KEY=`-shaped mention in prose (e.g. a list of patterns a
# reviewer scanned for) is not a credential and must not trip the scan.
PATTERN='gh[pousr]_[A-Za-z0-9]|sk-[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|relay_pa_[A-Za-z0-9_]+|dtn_[A-Za-z0-9]+|[A-Z_]*_API_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{8,}'

# Known-safe fixture tokens that exist on purpose, in this codebase's own test
# fixtures and in review artifacts discussing them (claude-review-final.md
# F-16). Each is redacted by EXACT LITERAL match before the pattern runs —
# never by loosening the pattern itself — so a real, different token of the
# same shape is still caught. Add a token here only when it is a documented,
# non-secret fixture; do not add prefixes or wildcards.
ALLOWLIST_TOKENS=(
  'relay_pa_thisisasecrettoken_do_not_leak'
)

FILES="$(git diff --cached --name-only --diff-filter=ACM)"
if [ -z "$FILES" ]; then
  echo "SECRET_SCAN_OK exit=0  # nothing staged"
  exit 0
fi

rc=0
HITS=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  CONTENT="$(cat "$f" 2>/dev/null)" || continue
  for tok in "${ALLOWLIST_TOKENS[@]}"; do
    CONTENT="${CONTENT//$tok/[ALLOWLISTED_FIXTURE_TOKEN]}"
  done
  # No temp file (claude-review-final.md F-22): the prior `/tmp/secret-scan-hit.$$`
  # path was predictable and not created with mktemp. Every other temp file in
  # this codebase uses mktemp; here the grep output is small, so it is simply
  # captured into a variable instead.
  HIT="$(printf '%s\n' "$CONTENT" | grep -EnI "$PATTERN" || true)"
  if [ -n "$HIT" ]; then
    HITS="$HITS
--- $f ---
$HIT"
    rc=1
  fi
done <<< "$FILES"

if [ "$rc" -ne 0 ]; then
  echo "SECRET_SCAN_VIOLATION exit=1"
  echo "$HITS"
  exit 1
fi

echo "SECRET_SCAN_OK exit=0  # $(echo "$FILES" | wc -l | tr -d ' ') files scanned"
exit 0
