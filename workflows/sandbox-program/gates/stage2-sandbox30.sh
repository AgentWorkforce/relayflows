#!/usr/bin/env bash
# Stage 2 gate — sandbox#30. See internal tracking for the vulnerability
# detail; this public repo names it by id only until Khaliq confirms rotation
# and disclosure (claude-review.md F-05).
#
# Acceptance: mode exactly 0600 under a 022 umask, fixture token absent from
# the generated content on the production call path, green CI per workflow.
#
# The umask matters. A file that happens to be 0600 because the caller's umask
# was 077 is not fixed — it is lucky. The repo's own tests are therefore run
# under an explicit `umask 022`, which is the umask a real sandbox process has.
set -uo pipefail
# Resolve the library next to this script without changing the runner cwd —
# ARTIFACTS_ROOT is relative to the workflow cwd, not to the gates directory.
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "stage2-sandbox30"

REPO="${STAGE2_REPO:-$AW_ROOT/sandbox-sec30-0824}"
BRANCH="${STAGE2_BRANCH:-fix/sandbox-30-initial-sync-script-mode-0824}"
SLUG="${STAGE2_SLUG:-AgentWorkforce/sandbox}"
SRC="$REPO/src/mount-script.ts"
TEST="$REPO/src/mount-script.test.ts"
ORCHESTRATOR="$REPO/src/orchestrator.ts"

# ── Mode proof, under the umask a real sandbox process runs with ────────────
run_check S2_MOUNT_SCRIPT_TESTS_UMASK022 "$REPO" \
  bash -c 'umask 022 && node --test --import tsx src/mount-script.test.ts'

# ── The fix is in the source, not only in the test ──────────────────────────
grep_check S2_MODE_0600_IN_SOURCE "$SRC" '0o600|0600'
grep_check S2_TEST_ASSERTS_MODE "$TEST" '0o600|0600|384'
grep_check S2_TEST_ASSERTS_UMASK "$TEST" 'umask'
# B3 is "the fixture token is absent from the generated content" — on the code
# path that actually ships, not merely somewhere in the test file. Grepping
# the test file for the word "token" (the old S2_TEST_ASSERTS_TOKEN_ABSENT)
# passed on a test that asserts the OPPOSITE: mount-script.test.ts:918-923
# proves the default (argv) ingress DOES put the credential in the script,
# and only the opt-in `tokenIngress: "creds-file"` path (:924-966) keeps it
# out. The production call site, orchestrator.ts, never sets `tokenIngress`
# (claude-review.md F-02), so the token-free path is proven but unused.
#
# This check verifies the two pieces of that chain that a repair owner in
# this lane can actually move without editing another stage's repository:
# that the token-free ingress exists and is proven (S2_CREDS_FILE_INGRESS_*),
# and that the production caller pins it (S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS).
# The second is EXPECTED TO FAIL until the sandbox#30 lane wires
# `tokenIngress: "creds-file"` (or "env") into its real call site — that red
# is B3's honest state today, not a gate bug.
grep_check S2_CREDS_FILE_INGRESS_DEFINED "$SRC" 'tokenIngress.*creds-file|creds-file.*tokenIngress'
grep_check S2_TEST_PROVES_CREDS_FILE_TOKEN_ABSENT "$TEST" 'tokenIngress:\s*"creds-file"'
if [ -f "$ORCHESTRATOR" ]; then
  grep_check S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS "$ORCHESTRATOR" 'tokenIngress'
else
  record S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS 1 "file missing: $ORCHESTRATOR"
fi

# ── Repo-wide regression + types ────────────────────────────────────────────
run_check S2_TYPECHECK "$REPO" npm run typecheck
# B4 is "full test suite green" — a skip is not a pass (claude-review.md F-10).
# The suite gates a handful of live-provider smoke/bench tests behind an env
# var for a real external credential (Daytona, Agent37, Microsandbox, Modal);
# those, and only those, are an allowed skip. Anything else skipped fails
# S2_FULL_TESTS_NO_UNALLOWED_SKIPS. Verified live: today's 9 skips are exactly
# DAYTONA_API_KEY/AGENT37_LIVE_SMOKE/MICROSANDBOX_SMOKE_IMAGE/MODAL_LIVE_BENCH
# gates, all matched by this pattern.
run_check_tap S2_FULL_TESTS "$REPO" \
  'DAYTONA_API_KEY is not set|AGENT37_LIVE_SMOKE is not 1|MICROSANDBOX_SMOKE_IMAGE is not set|MODAL_LIVE_BENCH is not 1' \
  npm test

# ── CI, per workflow, by branch ─────────────────────────────────────────────
# HEAD-bound (claude-review.md F-06): fails if the latest green run is not for
# this lane clone's current commit, not merely "a green run exists somewhere".
ci_check S2_CI "$SLUG" "$BRANCH" "$REPO"

gate_finish
