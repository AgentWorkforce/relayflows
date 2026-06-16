# Factory build-out — sequenced relayflows (p1–p13)

Autonomous, sequenced relayflows that build the **cloud-watches → local-node factory**
end to end (epic: `factory/planning/factory-cloud-watches-local-node-linear-issue.md`).
Each workflow implements one planning issue with a full squad + review loop and ships a
draft PR. Ricky runs them via `relayflows run <file>`.

## Why these live here
`@relayflows/core` (the `workflow` builder + `createGitHubStep`) and `@agent-relay/config`
(models) resolve from this repo, so the files live in `relayflows/factory-build/`. Ricky
executes them by pointing `relayflows run` at these absolute paths — it does **not** need
its own copy.

## The squad (per the user's spec)
- **lead-claude** — lead + QA (plans, assigns, repairs red gates)
- **impl-codex** — primary implementer
- **assist-opencode** — assisting implementer (needs `opencode` on PATH, `~/.opencode/bin`)
- **shadow-claude** — live shadow reviewer (flags spec drift while work happens)
- **reviewer-claude / fixer-claude** — first fresh-eyes review/fix loop
- **reviewer-codex / fixer-codex** — second loop (deep tier only)

The squad + the 80-to-100 review ladder (self-reflection → scoped change-detection →
soft/hard validate → Claude review/fix/final → [deep] Codex review/fix/final →
green-or-blocked acceptance → signoff → scoped commit → push → draft PR) live once in
`lib/factory-build-lib.ts`. Each wave file is thin: it supplies repo, branch, spec, file
targets, acceptance command, tier, and the implementation goal.

## Review tiers
- **standard** (Claude loop): p1, p2, p3, p5 — low-risk, focused refactors.
- **deep** (Claude + Codex loops): p6–p13, p11 — cloud/relay integration and the crux.

## Waves & dependency order
```
wave1 (parallel)  p1 p2 p3 (pear prep)   p11 (relay broker — independent)
wave2             p4  extraction  ──►  ⛔ PUBLISH GATE (human: npm publish + pear swap)
wave3 (parallel)  p5 (pear teardown)     p6 (cloud host orchestrator)
wave4 (parallel)  p7 (label→scope)  p8 (linear webhook)  p9 (dispatch-target seam)
wave5             p10 (RelayFleetClient + cloud fleet-node branch)
wave6             p12 (node placement)
wave7             p13 (factory node-definition for `agent-relay fleet serve`)
```

Run:
```bash
./run-factory-build.sh prep --dry-run     # validate wave1
./run-factory-build.sh wave1              # extraction prep + broker heartbeat
./run-factory-build.sh wave2              # p4 → stops at the publish gate
#   operator: publish @agent-relay/factory + swap pear (see PUBLISH_READY.md)
./run-factory-build.sh post-publish       # wave3..wave7
```

## ⛔ The publish gate (between wave2 and wave3)
p4 seeds + pushes `AgentWorkforce/factory` and **stops before `npm publish`** (irreversible).
A human publishes `@agent-relay/factory@0.1.0` and runs the pear dep-swap (see the generated
`PUBLISH_READY.md`). Only then can wave3+ run: **p6** imports the published package into cloud;
**p5** assumes pear consumes it. p7/p10/p13 edit the factory repo source (which exists after
the p4 seed) and don't strictly need the publish, but the gate keeps the sequence simple.

## Net result
After the full sequence: **no factory logic lives in pear.** Pear imports
`@agent-relay/factory` only for types and renders a read-only view of cloud state (p5 deletes
the Electron daemon entirely). The brain runs in cloud; the user runs one command —
`agent-relay fleet serve <factory-node-def>` — which **auto-starts the broker**
(`startBrokerWithPortFallback`, no separate `agent-relay up` needed) and executes
cloud-placed spawns on their own machine.

## Safety notes
- PRs are opened **draft** with a `[factory]` title and the **`no-agent-relay-review`** label,
  which disables the autonomous pr-reviewer bot that otherwise pushes unreviewed commits to
  held draft PRs.
- PR creation uses local `gh` (the broker runs on the user's machine where `gh` is authed).
  For cloud execution, swap the `open-pr` step in the lib for `createGitHubStep({action:'createPR'})`
  (imported from `@relayflows/core/integrations/github`).
- Acceptance gates are **green-or-blocked**: a red final gate writes `BLOCKED_NO_COMMIT.md`
  and skips commit/PR, so red work never signs off as complete.

## Cross-repo workflows (residual risk)
p4, p10, p11 touch two repos. They set `cwd` to the primary repo and reference the secondary
by absolute path via `crossRepoNote`; they open the secondary repo's PR separately and note it
in the signoff. Review these closely.

## Per-issue traceability
Each file maps 1:1 to a planning doc in `factory/planning/`. The workflow name is
`factory-<id>-<slug>`; artifacts land in `<target repo>/.workflow-artifacts/factory-<id>-<slug>/`.
