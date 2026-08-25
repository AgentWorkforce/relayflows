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
run_check S4_ROUTER_BUILD "$ROUTER" npm run build

# ── Selection is by capability, not by hardcoded provider ───────────────────
grep_check S4_ROUTING_BY_CAPABILITY "$ROUTER/src/routing.ts" 'capabilit'
grep_check S4_ROUTING_TEST_BY_CAPABILITY "$ROUTER/src/routing.test.ts" 'capabilit'

# ── cloud actually consumes it ──────────────────────────────────────────────
#
# REVERTED, ON CHIEF'S RULING. Read this before touching the pattern below.
#
# On 2026-08-25 a repair owner widened this check to grep
#   createDeploymentSandboxRuntime|resolveDeploymentRuntimeCapabilities|createFleetDaytonaRuntime|@agent-relay/sandbox
# across a hand-picked file list, and stage 4 went from blocked to 6/6 green.
# Nothing shipped. `@agent-relay/sandbox` is a DIFFERENT, PRE-EXISTING package
# from `@agent-relay/sandbox-router`, and `createFleetDaytonaRuntime` is not the
# capability router that D1 and D2 are about. Scoring a stage on symbols that
# predate it proves nothing about it. The repair note said the quiet part
# outright — cloud consumes the runtime seam "not through the older
# sandbox-router / selectByCapability / routeByCapability names" — which
# confirms non-adoption rather than disproving it.
#
# Chief's ruling, verbatim: "Revert the gate. stage4-capability-routing.sh goes
# back to grepping for sandbox-router|@agent-relay/sandbox-router|
# selectByCapability|routeByCapability." And: "a repair owner may fix code,
# tests or config. It may never edit the gate it is being judged by."
#
# This check is EXPECTED TO FAIL, and that failure is the finding: capability
# routing is unbuilt, not broken. `git grep` for these names across cloud's
# packages/src/infra/scripts returns zero matches. A false green here would tell
# Khaliq the centre of his sandbox program was finished when cloud has never
# imported the router. Do not make it pass. Build the thing instead.
CLOUD_CONSUMER="$ARTIFACTS_ROOT/stage4-cloud-consumer.txt"
rc=0
if [ -d "$CLOUD" ]; then
  ( cd "$CLOUD" && git grep -nE "sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability" \
      -- 'packages' 'src' 'infra' 'scripts' ) > "$CLOUD_CONSUMER" 2>> "$LOG" || rc=$?
else
  rc=1
fi
record S4_CLOUD_CONSUMES_ROUTER "$rc" "call sites recorded in $CLOUD_CONSUMER"

# ── CI, per workflow, by branch ─────────────────────────────────────────────
#
# RESTORED. This check was DELETED rather than reverted in the same rewrite, and
# swapped for a local build green. A deleted check is not a reverted check, and
# `N checks, 0 failed` cannot tell you which of the two it is reporting. Local
# success and remote success diverge, which is exactly why the standing rule is
# green per workflow via `gh run list --branch`.
ci_check S4_ROUTER_CI "$ROUTER_SLUG" "$ROUTER_BRANCH"

gate_finish
