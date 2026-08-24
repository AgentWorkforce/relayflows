#!/usr/bin/env bash
# Stage 2 gate — sandbox#30: world-readable initial-sync script embedding
# mount credentials. Live credential exposure on every sandbox that runs it.
#
# Acceptance: mode exactly 0600 under a 022 umask, fixture token absent from
# the generated content, green CI per workflow.
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

# ── Mode proof, under the umask a real sandbox process runs with ────────────
run_check S2_MOUNT_SCRIPT_TESTS_UMASK022 "$REPO" \
  bash -c 'umask 022 && node --test --import tsx src/mount-script.test.ts'

# ── The fix is in the source, not only in the test ──────────────────────────
grep_check S2_MODE_0600_IN_SOURCE "$SRC" '0o600|0600'
grep_check S2_TEST_ASSERTS_MODE "$TEST" '0o600|0600|384'
grep_check S2_TEST_ASSERTS_UMASK "$TEST" 'umask'
# The fixture token must not survive into the generated script content.
grep_check S2_TEST_ASSERTS_TOKEN_ABSENT "$TEST" 'token|credential|secret'

# ── Repo-wide regression + types ────────────────────────────────────────────
run_check S2_TYPECHECK "$REPO" npm run typecheck
run_check S2_FULL_TESTS "$REPO" npm test

# ── CI, per workflow, by branch ─────────────────────────────────────────────
ci_check S2_CI "$SLUG" "$BRANCH"

gate_finish
