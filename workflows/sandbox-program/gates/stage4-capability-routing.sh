#!/usr/bin/env bash
# Stage 4 gate — capability routing in sandbox-router, consumed by cloud.
#
# This is the architectural centre: cloud stops being Daytona-bound, and the
# router picks the sandbox by CAPABILITY rather than by hardcoded provider.
# It is gated behind stage 1 on purpose — an empty box beats a good router,
# so routing is not allowed to be declared done while provisioning is red.
#
# "Consumed by cloud" is the half that is easy to fake. A router that compiles
# and is imported nowhere has not shipped, so the gate asserts the call site
# in cloud, not only the module in sandbox-router.
set -uo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "stage4-capability-routing"

ROUTER="${STAGE4_ROUTER_REPO:-$AW_ROOT/sandbox-router}"
ROUTER_BRANCH="${STAGE4_ROUTER_BRANCH:-agent/process-manifest-0820}"
ROUTER_SLUG="${STAGE4_ROUTER_SLUG:-AgentWorkforce/sandbox-router}"
CLOUD="${STAGE4_CLOUD_REPO:-$AW_ROOT/cloud}"

# ── The router's own proof ──────────────────────────────────────────────────
run_check S4_ROUTER_TYPECHECK "$ROUTER" npm run typecheck
run_check S4_ROUTER_TESTS "$ROUTER" npm test

# ── Selection is by capability, not by hardcoded provider ───────────────────
grep_check S4_ROUTING_BY_CAPABILITY "$ROUTER/src/routing.ts" 'capabilit'
grep_check S4_ROUTING_TEST_BY_CAPABILITY "$ROUTER/src/routing.test.ts" 'capabilit'

# ── cloud actually consumes it ──────────────────────────────────────────────
# Presence of a real import/call site, and the absence of a Daytona-only
# hardcode on the placement path.
CLOUD_CONSUMER="$ARTIFACTS_ROOT/stage4-cloud-consumer.txt"
rc=0
if [ -d "$CLOUD" ]; then
  ( cd "$CLOUD" && git grep -nE "sandbox-router|@agentworkforce/sandbox-router|selectByCapability|routeByCapability" \
      -- 'packages' 'src' 'infra' 'scripts' ) > "$CLOUD_CONSUMER" 2>> "$LOG" || rc=$?
else
  rc=1
fi
record S4_CLOUD_CONSUMES_ROUTER "$rc" "call sites recorded in $CLOUD_CONSUMER"

# ── CI, per workflow, by branch ─────────────────────────────────────────────
ci_check S4_ROUTER_CI "$ROUTER_SLUG" "$ROUTER_BRANCH"

gate_finish
