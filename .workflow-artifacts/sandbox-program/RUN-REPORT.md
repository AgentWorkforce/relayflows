# sandbox-program — RUN REPORT

Run: `f8780ed663bb5851bca97323` ("run 5")
Driver: `sbx-relayflow-0824b`
Branch: `flow/sandbox-program-drive-0824` (pushed; never merged)
Started: 2026-08-25 05:37Z · Log: `.workflow-artifacts/sandbox-program/run-0824b.log`

**This is the first run to reach program acceptance and produce an honest
program-wide result.** Runs 1–4 never got here; runs 3 and 4 died mid-flight.

---

## The honest end state

| Stage | State | Why |
|---|---|---|
| 1 — provisioning | **PENDING** | Not failing. **Unmeasured.** |
| 2 — sandbox#30 | **GREEN 8/8** | Genuine. |
| 3 — longrun reconcile | **GREEN 15/15, structurally** | Green, but see the caveat. |
| 4 — capability routing | **BLOCKED_UNBUILT** | Not broken. **Never started.** |
| program acceptance | **BLOCKED — MISSING, not wrong** | Depends on 1 and 4. |

```
ACCEPT_STAGE1_PROVISIONING       exit=1
ACCEPT_STAGE2_SANDBOX30          exit=0
ACCEPT_STAGE3_LONGRUN_RECONCILE  exit=0
ACCEPT_STAGE4_CAPABILITY_ROUTING exit=1
checks: 4   failed: 2
```

### Program acceptance is MISSING, not wrong

This is the classification that matters, and it is why no repair owner could
ever have turned this gate green. **The code does not exist yet and the
measurement was never taken.** Fixing code cannot supply either.

**Stage 1 — five of seven failures are one unmeasured thing.**
`S1_PROBE_MOUNT`, `S1_PROBE_GH_VERSION`, `S1_PROBE_GH_AUTH`, `S1_PROBE_ROSTER`,
`S1_PROBE_WORKSPACE_IS_MOUNT` are all `exit=1` because **no fresh box has ever
been probed.** `stage1-freshbox-probe.txt` says so in its first line —
`PENDING: awaiting fresh-box run from sbx-provisioning-0824` — and then honestly
records every check as `exit=1`. That file is correct. It needs a live Daytona
credential and spend approval, both Khaliq-owned.

The remaining two: `S1_ROSTER_IN_SNAPSHOT` (contract A6; no roster referent in
the snapshot builder) and `S1_CI` (`Preview` NOT-RUN on
`cloud@fix/snapshot-gh-cli` — skipped is neither pass nor fail).

**Stage 4 — unbuilt.** `git grep -nE
"sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability"
-- packages src infra scripts` in `cloud` returns **exit=1, zero matches**.
Cloud has never imported the capability router. `S4_ROUTER_CI` is also red
because `agent/process-manifest-0820` carries **no `.github/workflows` at all**
(`git ls-tree -r agent/process-manifest-0820 -- .github/workflows` → empty; a
`ci.yml` exists in the working tree but is uncommitted). Empty is not a pass.

**So the correct disposition is: block once, record the evidence, stop.** It is
not a repair loop. Pointing successive agents at an unachievable gate is the
same trap that produced two false greens on stage 4 last night, and the failure
mode is predictable: the cheapest way to go green is to widen the criterion.

### The stage 3 caveat — read this before trusting the 15/15

Every one of stage 3's fifteen checks is a **marker-string grep**:

```
S3_DAYTONA_CAP_RULING exit=0  # pattern: DAYTONA_CAP_RULING
S3_CROSSOVER          exit=0  # pattern: crossover|breakeven|59\.8
```

A well-marked-up document that was **wrong** would score 15/15. The gate proves
the document has the right headings, not the right content. It should assert
that the Daytona ruling names `autoStopInterval=0`, no-ttl, and Modal as the
only unreset cap. **Not tightened during this run on purpose** — editing a gate
mid-run is exactly what the integrity guard exists to catch, and it would
correctly have failed the run for it.

---

## How to verify a step is actually alive

**This misled two readers of this run, so it is written down.** A step name, its
heartbeat name, and its process name are **three different strings**, and the
obvious roster check misses the live agent.

One step, `repair-program-acceptance`, ran under all of these:

| What | Name |
|---|---|
| step name (in the DAG) | `repair-program-acceptance` |
| attempt 1 agent | `repair-program-acceptance-f8780ed6` |
| pre-retry repair agent | `repair-program-acceptance-repair-1` |
| attempt 2 agent | `repair-program-acceptance-f8780ed6-r2` |

So `ps aux | grep "repair-program-acceptance-f8780ed6"` returns **nothing** while
`-repair-1` is the live agent — the run looks dead and is not. The heartbeat
line prints the *agent* name, so `[repair-program-acceptance-repair-1] still
running (300s)` names something the roster check never looks for.

**Check in this order. The log clock is authoritative; ps is corroborating.**

```sh
# 1. Is the runner process itself alive?           (4 procs = healthy)
ps aux | grep -c '[s]andbox-program-drive'

# 2. Is the log still ADVANCING? This is the real signal.
stat -f '%Sm' -t '%H:%M:%S' .workflow-artifacts/sandbox-program/run-0824b.log
date '+%H:%M:%S'          # a gap of minutes during an agent step is NORMAL
tail -3 .workflow-artifacts/sandbox-program/run-0824b.log

# 3. Which agent is live for this run — match the RUN ID, never the step name.
ps aux | grep '[a]gent-relay-broker pty' | grep -oE 'agent-name [a-z0-9-]+'
```

**Rule: match on the run id, not the step name.** Attempts append `-r2`; the
pre-retry repair agent replaces the run id entirely with `-repair-N`. A step is
dead only when the runner is gone **or** the log clock has stopped advancing —
not when a name you guessed is absent from `ps`.

---

## What this run also established

**The crash that killed runs 3 and 4 was not an uncaught throw.**
`RelayFileClient.subscribe` is synchronous, returns a Subscription, and keeps
its setup promise in a closure. A token with no `workspace_id` claim rejected
that promise with nothing attached while `subscribe` returned normally — so the
`try/catch` saw no throw, the await chain never saw a rejection, and Node killed
the process. That is why a timeout at `[87:38]` survived and a setup failure at
`[115:03]` did not. **No try/catch could have caught it.** Fixed at the point it
surfaces; the same hole existed in `waitFor` event gates.

**Slack human assistance is off; the answer loop is closed.** The reply now
arrives at `questions/<step>.ANSWER.md` and is injected. The program lead read
chief's standing ruling from a *previous* run and did not re-ask it.

**The gate-integrity guard held.** `GATE_INTEGRITY_OK: 9 gate files unchanged`
at every checkpoint, across four repair owners and the program lead. Last night
two owners rewrote the gates they were judged by; tonight none did.

**Stage 4, then vs now:**

| | last night | this run |
|---|---|---|
| checks | `6 checks, 0 failed` | `7 checks, 2 failed` |
| consumer | `exit=0` (widened to a different package) | `exit=1`, zero matches |
| CI check | **deleted** | **restored**, `exit=1` |
| state | green | `BLOCKED_UNBUILT` |

---

## What Khaliq should take from this

The centre of the sandbox program — capability routing — **has not been
started**, and provisioning **has never been measured on a real box**. Those are
the two things standing between this program and done. Stage 2 is genuinely
finished; stage 3 has a document that passes a gate too weak to confirm it.

Two unblocks are yours and only yours:
1. **A live Daytona credential and spend approval** so the fresh-box probe can
   actually run. Until then stage 1 is unmeasurable, not failing.
2. **A decision on capability routing** — whether `sandbox-router` is still the
   architecture, given `cloud` went to a provider-neutral runtime seam instead.

## Follow-ups, deliberately not done during this run

All three would have meant editing a gate mid-flight, which the integrity guard
correctly fails the run for.

1. Tighten stage 3 to assert content, not markers.
2. Fix `RECON_STAGE1_PROBE` — it reports **green because the probe file exists**
   while its contents are entirely `exit=1`. Existence where it means exit code.
3. Restore the `git grep` command echo in the stage-4 blocked record (the
   evidence shows `exit=1` without the command line above it).

## Provenance note

The previous `RUN-REPORT.md` at this path (mtime `2026-08-25T00:05:24Z`) was
written by hand by `sbx-relayflow-0824`. **No step in this flow writes this
file**, so its staleness was never a symptom of a stuck run. This copy is also
written by hand, by `sbx-relayflow-0824b`.
