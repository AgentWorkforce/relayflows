# Daytona process-backend blocker — evidence bundle

Issue: https://github.com/AgentWorkforce/relayflows/issues/52
Branch: `fix/daytona-process-source-binding-0905`
Fix commit: `c0b2000` (`fix(core): bind Daytona deterministic steps to one synced, named sandbox`)
Fix commit tree digest: `7dd5a231594397e5e5ed3e65027838aed0cb1fe8`
Packed candidate: `relayflows-core-candidate-1.1.3.tgz`
sha256(candidate tgz): `97c96ce784bd5e378073c48398aa8f9c3852ad29d3af3f7592a050f35470f4dd`
Baseline (released): `@relayflows/core@1.1.4` from the npm registry (verified: no source binding, per-step `createEnvironment` in its shipped `process-backend-executor.js` / `sandbox-backend.js`).

## The exact reproducer

A two-step deterministic workflow (`reproducer-fixture-v3.tgz`, driver
`reproducer-driver-run.mjs`) against a git source root —
fixture commit `3861e2448c39c2be11e01564dc23436f0ed5a85d`,
tree digest `a44f513c9283de2d772dbd7131e925a38e8a46d4`, identical in every run:

- `probe-bindings`: prints `RELAYFLOWS_SANDBOX_ID` / `RELAYFLOWS_SOURCE_COMMIT` /
  `RELAYFLOWS_TREE_DIGEST` (or `ABSENT`), asserts the synced source is present
  (`test -f reproducer-marker.txt`), and writes the sandbox id to a file.
- `probe-continuity`: asserts it runs in the SAME sandbox (reads the id file
  back) with the SAME bound commit and digest.

Run under `RELAYFLOWS_SANDBOX_PROVIDER=daytona`,
`RELAYFLOWS_SANDBOX_HOME_DIR=/home/daytona`,
`RELAYFLOWS_SANDBOX_SNAPSHOT=relay-sandbox-lite-sdk-11.8.2-relayfile-v0.10.50-runtime-4.1.41-rf113`,
`DAYTONA_API_KEY` supplied via a mode-600 file (never printed, never committed).

## 1. Released baseline FAILS in a fresh Daytona sandbox

- Outer sandbox (fresh, from the same snapshot): `596a2c4a-0d99-4ac4-aa47-8dab4ef1167c`
- Engine: `npm install @relayflows/core@1.1.4` (registry)
- Run id: `67a4f01c11eadeec58317fa0` — **FAILED**, driver exit 1
- Log: `baseline-released-1.1.4-run.log`

The failure is the blocker itself, three ways:

1. **Separate sandboxes.** Each of the step's 3 retry attempts provisioned its
   own fresh sandbox (`createEnvironment` per attempt in 1.1.4's
   `process-backend-executor.js`); nothing carried between them.
2. **No source or workdir sync.** Every attempt passed the runner-local cwd
   (`/home/daytona/reproducer`) verbatim to the remote sandbox, where it does
   not exist and no source was uploaded: `fork/exec /usr/bin/bash: no such file
   or directory` — the command never even ran.
3. **No sandbox id.** `RELAYFLOWS_SANDBOX_ID` appears in the log only inside
   the command text; no value was ever exposed to any command, and no
   provisioned sandbox is identifiable from the run.

## 2. Packed unpublished candidate installed in a fresh sandbox

- Outer sandbox (fresh): `1c947406-2ebc-45a7-9421-c429ea84e13f`
- Engine: `npm install /home/daytona/relayflows-core-candidate.tgz @daytonaio/sdk`
  — tarball sha256 verified in-sandbox as
  `97c96ce784bd5e378073c48398aa8f9c3852ad29d3af3f7592a050f35470f4dd`
  (identical to the pack from fix commit `c0b2000`).

## 3. Same exact reproducer PASSES

- Run id: `e07ca8efd128eb67caea09ad` — **COMPLETED**, driver exit 0
- Log: `candidate-packed-run.log`

Step outputs (both steps):

```
sid=ee58c343-fddf-44bd-8d32-de66b74ba399
commit=3861e2448c39c2be11e01564dc23436f0ed5a85d
digest=a44f513c9283de2d772dbd7131e925a38e8a46d4
CONTINUITY_OK sid=ee58c343-fddf-44bd-8d32-de66b74ba399 commit=3861e2448c39c2be11e01564dc23436f0ed5a85d digest=a44f513c9283de2d772dbd7131e925a38e8a46d4
```

- **One sandbox for the run**: both steps saw `ee58c343-fddf-44bd-8d32-de66b74ba399`;
  step 2 read back the id file step 1 wrote (continuity).
- **Exact source and workdir synced**: `test -f reproducer-marker.txt` passed —
  the committed tree was uploaded (`git archive HEAD`), digest-verified
  (sha256), extracted, and file-set-verified against the committed tree.
- **Source commit and tree digest bound into every step**: both steps report
  the fixture's exact `HEAD` commit and tree digest (values identical to the
  baseline run's fixture).
- **Exact sandbox id available to the process**: `RELAYFLOWS_SANDBOX_ID` was
  set (and identical) in both steps.

A pre-flight of the same candidate from the orchestrator's machine (before the
sandbox-in-sandbox run) is in `candidate-local-preflight-run.log`
(inner sandbox `9eca9416-48e1-4cb9-a501-8c18b3aa7612`, same PASS shape).

## 4. Cleanup — same IDs Not Found and absent from full inventory after bounded polling

`poll-gone` = bounded polling (deadline-bounded loop, 3s interval) requiring
BOTH get-by-id = Not Found AND absence from the full sandbox inventory in the
same round:

| Sandbox | Role | Evidence file | Result |
| --- | --- | --- | --- |
| `ee58c343-fddf-44bd-8d32-de66b74ba399` | run-shared inner sandbox (candidate run, destroyed by the engine at run end) | `candidate-inner-sandbox-poll-gone.txt` | NOT_FOUND, inInventory=false, inventory 124, 844 ms |
| `1c947406-2ebc-45a7-9421-c429ea84e13f` | outer candidate sandbox (destroyed after evidence) | `candidate-outer-sandbox-poll-gone.txt` | NOT_FOUND, inInventory=false, inventory 123, 10.8 s, sawPresentBefore=true |
| `596a2c4a-0d99-4ac4-aa47-8dab4ef1167c` | outer baseline sandbox (destroyed after evidence) | `baseline-outer-sandbox-poll-gone.txt` | NOT_FOUND, inInventory=false, inventory 125, 4.3 s, sawPresentBefore=true |
| `9eca9416-48e1-4cb9-a501-8c18b3aa7612` | pre-flight inner sandbox | `candidate-local-preflight-inner-sandbox-poll-gone.txt` | NOT_FOUND, inInventory=false, inventory 124, 1.0 s |

The baseline run's own per-step sandboxes were destroyed inline by the released
engine's per-step `finally` (inventory went 128 → 126 across the run window;
no run leftovers: `base-inventory-before.txt` / `base-inventory-after.txt`).

## Unit tests

`packages/core/src/__tests__/sandbox-source-sync.test.ts` (16 tests) pins the
contract exactly: binding to `HEAD` commit + tree digest; label stamping;
archive upload + digest + extraction + file-set verification; every fail-closed
refusal (non-git root, digest mismatch, extraction failure, file-set mismatch —
with nothing provisioned); one shared sandbox per run (including concurrent
first steps); binding env in every command; cwd mapping and escape refusal;
per-step behavior preserved byte-for-byte on unbound backends; dispose teardown;
and the full runner-level contract through a real `WorkflowRunner.execute`.

## Commands (reproducible skeleton)

```bash
# pack the candidate from the fix branch
npm run build --workspace=packages/core && npm pack --workspace=packages/core

# fresh outer sandbox
daytona create --snapshot "$SNAPSHOT" --name rf-evidence-base
# install engine, upload fixture + driver, then run:
export DAYTONA_API_KEY=$(cat /home/daytona/.daytona-key)
export RELAYFLOWS_SANDBOX_PROVIDER=daytona \
       RELAYFLOWS_SANDBOX_HOME_DIR=/home/daytona \
       RELAYFLOWS_SANDBOX_SNAPSHOT=$SNAPSHOT
node run.mjs /home/daytona/reproducer        # baseline: exit 1 / FAILED
                                            # candidate: exit 0 / COMPLETED

# cleanup proof (bounded polling, both conditions)
daytona info <id>    # -> not Found
daytona list         # -> id absent from full inventory
```
