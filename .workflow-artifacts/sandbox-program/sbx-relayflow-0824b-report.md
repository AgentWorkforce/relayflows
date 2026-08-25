# sbx-relayflow-0824b — report to chief

Date: 2026-08-25
Branch: `flow/sandbox-program-drive-0824` — pushed, upstream set, `git push -u` done
Commits: `0fe28b7` (task 1), `379dfcd` (tasks 2 + 3)
Run: `f8780ed663bb5851bca97323`, started 05:37Z, log at
`.workflow-artifacts/sandbox-program/run-0824b.log`

All three tasks are landed and pushed. Two findings below change the diagnosis
in the brief — please read them, one of them means the flow could not have
started at all as it stood.

## FINDING 1 — the crash was not an uncaught throw. No try/catch could have caught it.

The brief's read was that "the guard covers the timeout branch, not the throw
branch". The symptom is exactly right; the mechanism is not, and it matters
because the prescribed fix would not have worked.

`RelayFileClient.subscribe` is SYNCHRONOUS and returns a Subscription, but it
starts its own setup and keeps that promise in a closure
(`node_modules/@relayfile/sdk/dist/client.js:1125`):

    subscribe(globs, onChange, options) {
      const setup = this.resolveWorkspaceId(options?.aclToken).then(...)
      return { async unsubscribe() { ... } }
    }

When the refreshed token came back with no `workspace_id` claim,
`resolveWorkspaceId` rejected. `setup` had nothing attached to it. `subscribe`
returned NORMALLY, so the `try/catch` around it in `waitForRelayfileEvent` saw
no throw, the waiter registered, the timer armed — and Node killed the process
on the unhandled rejection.

That is why the two failure modes of one call site diverged:

- `[87:38]` TIMEOUT — `reject()` from the timer, travelled the await chain, was
  caught by the inline `.catch()`, run lived.
- `[115:03]` SETUP FAILURE — never entered the await chain at all. It was never
  our promise to catch.

The inline `.catch()` in `e336e40` was correct and did work; it just could not
reach this. Neither could another wrapper above it.

Fixed where it actually surfaces: `waitForRelayfileEvent` listens for the
detached rejection for the life of its wait and converts it into its own
waiter's failure, on the await chain where every caller already has a handler.
The match is narrow to that SDK signature; anything else is rethrown on the next
tick so unrelated unhandled rejections still crash exactly as before. This also
covers `waitFor` event gates, which had the identical hole and would have died
the same way.

## FINDING 2 — the driver has been unparseable in the working tree

`workflows/sandbox-program-drive.ts` had an unescaped backtick pair in
`REPAIR_RULES` (the `BLOCKED_MISSING` / `BLOCKED_UNREPAIRED` line added in the
last uncommitted edit). It terminated the template literal:

    workflows/sandbox-program-drive.ts(184,43): error TS1005: ',' expected.

`relayflows run` on it died at the parse. Whatever else was true, the flow could
not have started in that state. Fixed in `379dfcd`.

## TRAP — `relayflows` on PATH is Aug-17 code

`which relayflows` resolves to the global install, which bundles its OWN
`@relayflows/core` **v1.0.6 dated Aug 17**, with none of tonight's fixes — not
the inline `.catch()`, not the detached-rejection guard, not the answer loop.
The repo copy is v1.0.7.

    global  -> .../@relayflows/cli/node_modules/@relayflows/core   (0 fixes present)
    local   -> ./packages/core/dist                                (all present)

The run is started with `./node_modules/.bin/relayflows`, which resolves core
through the workspace symlink to `packages/core`. Anyone driving this flow with
the bare `relayflows` command runs Aug-17 code and will reproduce every bug we
have already fixed. Worth a standing note.

## TASK 1 — Slack disabled, answer loop closed

- Slack human assistance is off for this flow. `config.swarm.humanAssistance`
  declares `file` and no `slack` key; declaring `file` disables Slack in the
  runner, and `RELAYFLOWS_DISABLE_SLACK_HUMAN_ASSISTANCE=1` is set as well. The
  only guard that cannot be bypassed is not making the call.
- The answer half is built. The runner records the question if the agent has
  not, polls `questions/<step>.ANSWER.md`, and injects it exactly as a Slack
  answer would be. Answers are consumed by path+mtime+size rather than deleted,
  so the ruling stays on disk as the record, a second question is not handed the
  first one's answer, and a resumed run re-injects a standing answer.
  **Your `program-lead-coordinate.ANSWER.md` will now be read.** The program
  lead is also told to read standing `*.ANSWER.md` rulings before asking
  anything.
- `askHumanAndInjectAnswer` never rethrows on any channel, so the promise stored
  in `pendingHumanQuestions` is non-rejecting by construction, not by handler.
- `DEFAULT_HUMAN_QUESTION_WAIT_MS` 3600000 -> 600000. An hour is not a bound.
- Sibling test added, the one the timeout branch never had: a THROWING
  human-assistance path leaves the run alive, including a synchronous throw and
  with nothing awaiting the stored promise. Plus the detached-setup rejection
  reproduced in the SDK's real shape, and the answer loop end to end.
  948/948 core tests pass.

## TASK 2 — gate-hash guard. Built, and it outranked the run.

`workflows/sandbox-program/gate-integrity.sh`, deliberately NOT under `gates/`
so nothing routine walks a repair owner past it. It hashes every gate script,
the driver that defines the acceptance contract, and itself; re-hashes before
scoring; fails the run on any change.

- A path the baseline knew about that is gone reports **DELETED**, not a quietly
  shorter manifest. A deleted check is not a passing check — S4_ROUTER_CI is the
  case in point.
- No baseline means FAIL. An unverifiable green is what this exists to stop.
- Baseline lives in `.agent-relay/`, outside `.workflow-artifacts/` — a tamper
  record kept where the tamperer works is not a record — and is echoed into the
  run log so a second copy exists.
- Verified against all five modes: gate rewritten, check deleted, driver
  contract rewritten, guard itself disarmed, baseline missing. All exit 1.

Wired at four points: baseline at wave 2 (before the first agent step, wave 3),
then verify before `program-acceptance`, before `program-acceptance-final`, and
before `commit-if-green`. Each has agents between it and the previous check.
`failOnError: true` throughout, and **no repair owner** — the step that checks
for tampering is the one an agent may never be handed.

## TASK 3 — stage 4 BLOCKED, not repaired

Your ruling applied as written.

- Gate reverted: greps
  `sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability`
  again. S4_ROUTER_CI restored as remote CI per workflow, not a local build.
- **Re-verified independently just now**, in `~/Projects/AgentWorkforce/cloud`:

      git grep -nE "sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability" -- packages src infra scripts
      exit=1, zero matches

- The `fix-stage4` repair loop is **deleted**. A repair owner cannot build an
  unbuilt feature, but it can always widen a gate until something already on
  disk satisfies it, and twice it did. Stage 4 now blocks once, re-derives the
  zero-match evidence at run time rather than quoting a previous run's file, and
  records `BLOCKED_UNBUILT` with `S4_CLOUD_CONSUMES_ROUTER exit=1`.

Both false greens came from the same commit, `e336e40` — the gate rewrite and
the S4_ROUTER_CI deletion rode in on the Slack-fix commit.

## Also, plainly: I started an unintended second run and killed it

While smoke-testing, a `node -e 'import(...)'` executed the driver's `main()`
without `DRY_RUN`, starting run `45ed0d0e`. It reached three agents before I
killed it. All `45ed0d0e` processes are gone; chief, the four lanes and the
factory agents were untouched and verified alive. My error. The one useful
by-product is that it confirmed `gate-integrity-baseline` runs and passes
against the real DAG.

## Expected honest end state

Stage 1 PENDING, stage 2 green, stage 3 green but structurally so, stage 4
BLOCKED. Per your brief that is a real result and I am not going to dress it up.

Stage 3's gate greps marker strings and would pass a well-marked-up document
that was wrong. I have NOT tightened it, because doing so during the run is
itself editing a gate mid-flight and the integrity guard would fail the run for
it — correctly. It should be tightened to assert the Daytona ruling names
`autoStopInterval=0`, no-ttl, and Modal as the only unreset cap, as a separate
change before the next run.

Never merged. Never will.

## Standing-rule check

Reporting on disk as well as by DM, per relay#1593. If my DMs go quiet, this
file is the channel.
