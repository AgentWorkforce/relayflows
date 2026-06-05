# `@relayflows/core` — `@agent-relay/sdk` v7 → v8 migration plan

> Status: **proposed, not started.** This plan was produced from a read-only
> investigation of `packages/core` and the relay monorepo HEAD (all `@agent-relay/*`
> at `8.0.4` source / `8.1.2` npm). Review before any code is written.

## 1. Why core doesn't compile today

`packages/core` straddles two incompatible majors of the relay SDK family:

- Its **RelayAuth** code (`provisioner.ts`, `runner.ts`) imports symbols
  (`mintAgentToken`, `resolveAgentPermissions`, `createLocalJwksKeyPair`,
  `compileAgentScopes`, …) that **only exist in `@agent-relay/cloud@8.x`**.
- Its **agent-spawn + broker-event** code (`runner.ts`) is written against the
  **`@agent-relay/sdk@7.x` API**, all of which was removed/redesigned in 8.x.

cloud + sdk move in lockstep, so no published version set satisfies both. Bumping
`@agent-relay/{cloud,config,sdk}` to `^8.0.4` (done) cleared all 16 cloud errors and
surfaced the real work: **82 sdk errors, 80 in `runner.ts`.**

## 2. The key realization — the broker surface became `HarnessDriverClient`

> **REVISED after tracing the v8 source.** An earlier draft assumed the runner
> had to be re-modelled onto the SDK's *messaging* event system (`message.created`,
> session/status events). That is **not** the right target and would have been a
> large rewrite. The correct, far smaller target:

v7 `AgentRelay` was one object that did **both** messaging **and** local
process/PTY spawning + broker lifecycle. v8 split those:
- **Messaging** → `@agent-relay/sdk` (`AgentRelay`). **Core doesn't use this for the
  broker** — it does messaging via `@relaycast/sdk` already. Every `this.relay.*`
  call in `runner.ts` is a *broker* concern (verified: `addListener`×7, `spawnPty`,
  `onBrokerStderr`, `listAgents`/`listAgentsRaw`, `human`).
- **Broker / PTY / lifecycle** → `@agent-relay/harness-driver` `HarnessDriverClient`.

`HarnessDriverClient` is essentially what v7 `AgentRelay`'s broker half became, and
it preserves core's model **almost verbatim**:

| v7 `AgentRelay` (broker) | v8 `HarnessDriverClient` | Match |
|---|---|---|
| `addListener('workerOutput'\|'messageReceived'\|'agentSpawned'\|'agentReleased'\|'agentExited'\|'agentIdle'\|'deliveryUpdate', …)` | same `addListener<K extends keyof HarnessDriverEvents>(event, handler)` — **same event names** | ✅ verbatim |
| `workerOutput {name, chunk}` / `messageReceived {eventId,from,to,text,threadId}` / `agentIdle {name,idleSecs}` payloads | `WorkerOutputPayload` / `DriverMessage` / `AgentIdlePayload` — **same field names** | ✅ verbatim |
| `onBrokerStderr(cb)` | `onStderr` **construction option** | ✅ moved to ctor |
| `spawnPty(opts)` | `spawnPty(SpawnPtyInput)` — same field names | ✅ |
| `listAgents()` / `listAgentsRaw()` | `listAgents(): ListAgent[]` (one method) | ✅ |
| `shutdown()` | `shutdown()` | ✅ |
| `BrokerEvent` re-emit | `onEvent((e: BrokerEvent)=>…)` — **same `BrokerEvent` union/kinds** | ✅ |
| spawn return = rich `Agent` (`.release()`,`.waitForExit()`,`.waitForIdle()`,`.send()`,`.exitCode`) | `SpawnAgentResult` = plain `{name,runtime,sessionId?,pid?}` | ⚠️ **needs adapter** |
| `relay.human({name}).sendMessage(...)` (idle nudge) | not on driver — route through relaycast messaging or `createHuman` | ⚠️ small |

CLI utils (`getCliDefinition`/`resolveCliSync`/`resolveSpawnPolicy`) and `stripAnsi`
are gone from the SDK → vendored into `core/src/cli-registry.ts` / `strip-ansi` pkg
(done in WS-0).

So the migration is **swap `this.relay: AgentRelay` → a `HarnessDriverClient`**, with
two real pieces of work: (1) an agent-handle adapter, (2) the idle-nudge sender.

## 3. Blockers / decisions

1. **`@agent-relay/harnesses` — ✅ RESOLVED.** It is now published
   (`@agent-relay/harnesses@8.1.2`, confirmed resolvable on `registry.npmjs.org`).
   **Decision: core depends on `@agent-relay/harnesses` directly** (option a). It
   provides the `claude`/`codex`/`gemini`/`opencode` PTY harnesses and `createHuman`.
2. **Direction confirmation.** Two coherent end-states:
   - **Forward (recommended):** migrate core's sdk usage to 8.x so it matches the
     cloud 8.x RelayAuth it already uses. Aligns with relay HEAD.
   - **Backward:** pin sdk+cloud to 7.1.1 and **remove the RelayAuth/provisioner
     feature** (scoped agent-token minting). Only viable if that feature is
     droppable — it appears intentional, so this is likely not acceptable.
3. **Broker process ownership — ✅ largely addressed.** In v8 the broker is owned
   by the harness layer: `harness.create({ relay })` starts/attaches a `BrokerDriver`
   bound to the relay's workspace (`harnesses/src/broker-binding.ts`). So core's
   manual `brokerName` / `relay.shutdown()` / broker bootstrap mostly **goes away**.
   - **Remaining open question:** `onBrokerStderr` (broker diagnostic lines) has no
     obvious 1:1 on the `BrokerDriver` surface. Decide whether core still needs raw
     broker stderr, or whether session/status events suffice. Low priority — affects
     only diagnostic logging at `runner.ts:3336`.

## 4. Workstreams (assuming "forward" + a resolved harness source)

Ordered to minimize churn; each is independently compilable-checkable.

### WS-0 — Utilities (small, do first)
- `stripAnsi`: add `strip-ansi` dependency (or a 3-line local helper); update
  `runner.ts:28`, `channel-messenger.ts:1`, and static wrapper `runner.ts:7712`.
- `getCliDefinition` / `resolveCliSync` / `resolveSpawnPolicy`: these were CLI-
  registry helpers (`runner.ts:31,32,30`, `process-spawner.ts:4,5`,
  `proxy-env.ts:1`). Confirm whether equivalents exist in `@agent-relay/config` /
  `harness-driver`; if not, **vendor** them into a new `core/src/cli-registry.ts`
  (they're self-contained PATH/known-dir resolution + arg/env policy).
- Move `BrokerEvent` / `AgentSpawner` type imports to `@agent-relay/harness-driver`
  (`runner.ts:29,126`).

### WS-1 — AgentRelay construction & options (`runner.ts:3145`, types in `builder.ts:4`, `run.ts:1`)
- v7 `new AgentRelay({ brokerName, channels, env, requestTimeoutMs })` →
  v8 `new AgentRelay({ workspaceKey, baseUrl, retryPolicy, harness })`.
- `env` / `brokerName` / `requestTimeoutMs` are gone from options. Decide where
  each goes: `env` → harness-driver `SpawnRuntimeInput`; `brokerName` → broker
  transport config; `requestTimeoutMs` → `retryPolicy`.
- Update the `AgentRelayOptions` type references in `builder.ts`, `run.ts`,
  `runner.ts:481`.

### WS-2 — Agent spawning (`runner.ts:444-456`, `6739`, `6742`, `7200`)
Grounded against the now-available `@agent-relay/harnesses` API:
- `getWorkflowSdkSpawner()` switch over `relay.claude/.codex/.gemini/.opencode` →
  lookup into `{ claude, codex, gemini, opencode }` imported from
  `@agent-relay/harnesses` (each is a `PtyHarness`).
- `sdkSpawner.spawn(opts)` / `relay.spawnPty(opts)` →
  `await harness.create(input)` where
  `input: HarnessCreateInput = { name, model, args, task, cwd, env, channels, relay }`
  and the returned `HarnessAgent` (extends `RelayAgentClient`: `id`, `name`,
  `handle`, `sendMessage`, plus `cli`/`runtime`/`definition`) replaces the v7
  `Agent` handle. **The current `spawnOptions` map ~1:1 onto `HarnessCreateInput`.**
- `harness.create({ relay })` internally attaches/starts the broker for the
  workspace — remove core's manual broker bootstrap.
- `relay.human({ name })` (idle-nudge sender, `7200`) →
  `createHuman({ relay, name })` from `@agent-relay/harnesses`.
- Replace the `Agent` type (`runner.ts:126`, fields at `320/332/507`) with
  `HarnessAgent` / `RelayAgentClient`.

### WS-3 — Event stream rewrite (the bulk: `runner.ts:3158-3343`)
Re-model the 7 listeners onto the v8 surface. Mapping target per listener:

| v7 listener (fields) | v8 source |
|---|---|
| `workerOutput` `{name, chunk}` (3158) | session event `terminal.output`/`transcript.chunk` → `event.text`/`chunk` |
| `messageReceived` `{eventId,from,to,text,threadId}` (3206) | `addListener('message.created')` → `event.message.text`, `event.envelope.from/to`, `event.message.parentId` |
| `agentSpawned` `{name,runtime}` (3254) | session `status.active` / spawn ack from driver runtime |
| `agentReleased` `{name}` (3272) | driver `release()` / session `status.offline` |
| `agentExited` `{name,exitCode,exitSignal}` (3285) | session `command.completed` `{exitCode}` / `status.offline` |
| `deliveryUpdate` (3305) | `addListener` delivery events (`deliveries` surface) |
| `agentIdle` `{name,idleSecs}` (3311) | `agent.status.becomes('idle')` predicate (note: `idleSecs` may be unavailable — see open question) |
| `onBrokerStderr(line)` (3336) | no direct equivalent — see Blocker #3 |

- Preserve the internal `BrokerEvent` re-emission contract (the
  `{type:'broker:event', runId, event}` shape consumed by the CLI) by **adapting**
  v8 events into the existing `BrokerEvent` union, so downstream (`WorkflowEvent`,
  CLI logging) is unchanged. This keeps the blast radius inside `runner.ts`.

### WS-4 — Agent listing & teardown (`runner.ts:3486`, `5234`, `5250`, `6810`)
- `relay.listAgents()` / `listAgentsRaw()` → `relay.messaging.agents.list()`.
  Rework the stale-retry-agent cleanup + the wait-for-cleanup poll accordingly.
- `relay.shutdown()` → broker/transport lifecycle teardown (depends on Blocker #3).

### WS-5 — Implicit-`any` cleanup (9 × TS7006, `runner.ts:2437…7077`)
- Trivial once the surrounding types resolve; annotate the `.map`/callback params.
  Deferred to last because the types they touch change in WS-2/WS-3.

## 5. Open questions for the SDK owners
- Is per-agent **idle duration** (`idleSecs`) still observable, or only a boolean
  `idle` status? (Affects the idle-nudge debounce at `runner.ts:3311-3328`.)
- Is there a supported way to get **broker stderr** / diagnostics off the
  `BrokerDriver` in v8, or should core drop raw broker-stderr logging?
- ~~Will `@agent-relay/harnesses` be published?~~ ✅ Published at `8.1.2`.

## 6. Suggested sequencing & checkpoints
1. Resolve Blockers #1–#3 (decisions).
2. WS-0 (utils) → typecheck: cloud + util errors gone.
3. WS-1 (construction) → typecheck.
4. WS-2 (spawn) → typecheck + a smoke spawn of one CLI.
5. WS-3 (events) → typecheck + observe a real run's event stream.
6. WS-4, WS-5 → full `tsc` clean.
7. Run `packages/core` test suite (`vitest`) + one end-to-end workflow via the CLI.

## 7. Effort estimate (REVISED DOWN)
The `HarnessDriverClient` discovery collapses most of the original risk:
- **WS-0 — done & verified** (85→77 errors, SDK unified on 8.x, utils vendored).
- **WS-1/WS-3** — largely a `this.relay → HarnessDriverClient` swap; listeners and
  payloads are verbatim. The only event remap is `agentExited` exit code/signal
  (source it from the `agent_exited` `BrokerEvent` via `onEvent`, since the named
  `agentExited` payload is a method-less `DriverAgent`).
- **WS-2** — the one real build: a `WorkflowAgentHandle` adapter wrapping
  `SpawnAgentResult` + the driver client to restore `.release()` / `.waitForExit()`
  / `.waitForIdle()` / `.exitCode` (driven off the driver event bus), plus routing
  the idle-nudge sender. Unify the two spawn paths (`getWorkflowSdkSpawner().spawn()`
  and `spawnPty()`) into one `spawnPty()` call.
- **WS-4/5** — `listAgents()` + `client.release(name)` (note: `ListAgent` is data,
  has no `.release()`), `shutdown()`, implicit-`any`s.

Revised estimate: **~1–1.5 days**, the bulk in the WS-2 handle adapter and a
real-run validation of the event stream + spawn lifecycle.
