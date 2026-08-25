gate: stage4-capability-routing
state: BLOCKED_UNBUILT
timestamp: 2026-08-25T04:20:08Z
---
S4_CLOUD_CONSUMES_ROUTER exit=1  # capability routing is UNBUILT, not broken

Verbatim, in /Users/khaliqgant/Projects/AgentWorkforce/cloud:
  exit=1  (1 = zero matches)
  matches:

Cloud does not import the capability router anywhere. This stage has
not been started. It is not a repair: a repair owner cannot build an
unbuilt feature, and asking one to try produced two false greens on
2026-08-25 — first by widening this gate to match a different,
pre-existing package (@agent-relay/sandbox), then by deleting the CI
check it could not pass. Both are reverted.

Owner: the sandbox-router lane, plus a cloud change to consume it.
