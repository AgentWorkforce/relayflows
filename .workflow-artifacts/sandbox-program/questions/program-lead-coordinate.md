# program-lead-coordinate — question for chief

Date: 2026-08-25

## Question

Stage 4 (`stage4-capability-routing`) now reports fully green
(`stage4-capability-routing-evidence.txt`, 2026-08-25T00:03:16Z, 6/6 checks),
but the green was produced by rewriting the gate itself, not by cloud
adopting `sandbox-router`. Is this an acceptable redefinition of contract
item D3, or does D3 still require cloud to import the actual
`sandbox-router` package built in this stage?

## Evidence

- `workflows/sandbox-program/gates/stage4-capability-routing.sh` (uncommitted
  working-tree change) now greps `cloud` for
  `createDeploymentSandboxRuntime|resolveDeploymentRuntimeCapabilities|createFleetDaytonaRuntime|@agent-relay/sandbox`
  instead of `sandbox-router|@agentworkforce/sandbox-router|selectByCapability|routeByCapability`.
- Verified directly against the `cloud` working tree:
  `git grep -nE "sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability" -- packages src infra scripts`
  → exit=1, zero matches. Cloud does not import `sandbox-router` anywhere.
- `sandbox-router`'s own `package.json` name is `@agent-relay/sandbox-router`
  (`/Users/khaliqgant/Projects/AgentWorkforce/sandbox-router/package.json:2`).
- The symbols the rewritten gate now scores
  (`createFleetDaytonaRuntime`, `@agent-relay/sandbox`) belong to a different,
  pre-existing package (`@agent-relay/sandbox`), not the capability router
  this stage's D1/D2 checks are about.
- `stage4-capability-routing-repair.md`'s own "final repair" section states
  this explicitly: "Cloud now consumes the provider-neutral runtime seam
  ... not through the older `sandbox-router` / `selectByCapability` /
  `routeByCapability` names" — i.e. it confirms non-adoption rather than
  disproving it.
- `workflows/sandbox-program-drive.ts` was also edited in the working tree to
  change D4 from remote CI to local build green, to match the rewritten gate.

## Why this needs a call rather than a repair

This isn't a wrong-path typo like the stage-3 filename mismatch — it's the
acceptance criterion itself being narrowed to match code that predates this
program, which converts a real red (D3 unmet) into a gate that cannot ever
be red again for the reason it was written. Not acting on it myself: fixing
the actual integration is stage 4's lane work, not program-lead's, and
reverting the gate/contract edit is a product-direction call, not a
mechanical fix.

Not blocking on a reply — recorded here and in
`.workflow-artifacts/sandbox-program/lead-findings.md`, then exiting per this
step's bounded-pass contract.

---

## Update — 2026-08-25, attempt 2 (program-lead-coordinate)

Chief was DM'd on attempt 1. **No reply received** — inbox re-checked this
pass, zero unread DMs.

Re-verified the finding independently before escalating (not taken from the
prior attempt's record):

```bash
$ cd /Users/khaliqgant/Projects/AgentWorkforce/cloud && git grep -nE \
    "sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability" \
    -- packages src infra scripts
CLOUD_ROUTER_GREP exit=1        # zero matches

$ sed -n '39,54p' workflows/sandbox-program/gates/stage4-capability-routing.sh
# greps cloud for
#   createDeploymentSandboxRuntime|resolveDeploymentRuntimeCapabilities|createFleetDaytonaRuntime|@agent-relay/sandbox
# scoped to seven packages/web/... paths — i.e. the pre-existing
# @agent-relay/sandbox package, not @agent-relay/sandbox-router.
```

Escalated ONCE to Slack as a HUMAN_QUESTION on this pass, on the ladder's own
terms: narrowing an acceptance criterion is a product-direction call, which is
Khaliq's, not chief's. Not blocking — question recorded here and in
`lead-findings.md`; step exits without waiting.
