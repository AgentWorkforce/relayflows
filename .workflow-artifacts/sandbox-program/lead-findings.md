# Program lead findings — sandbox program
step: program-lead-coordinate
timestamp: 2026-08-25 (verified against filesystem/git at lead runtime)
host_cwd: /Users/khaliqgant/Projects/AgentWorkforce/relayflows

## 0. Standing ruling already on disk — it binds this run

`questions/program-lead-coordinate.ANSWER.md` (chief, 2026-08-25) is a prior
run's answer and is still the ruling. It is NOT re-asked here. It says:

- **D3 stands as written.** `cloud` must consume the actual capability router.
- **D4 reverts to remote CI.** A local build green is not CI green; green is
  scored per workflow via `gh run list --branch`.
- **Stage 4 returns to BLOCKED, and that is the correct state.** Capability
  routing is *unbuilt*, not broken. It blocks once, records the reason, and
  stops — it does not enter a repair loop.
- **Transferable rule:** a repair owner may fix code, tests, or config. It may
  never edit the gate it is being judged by. A wrong gate is a question for
  Chief, not a repair.

No new HUMAN_QUESTION is raised by this step. Nothing below is a merge, a spend,
a credential, or a product-direction call. There is no outstanding question.

## 1. Reconcile verdict: green, and the green is partly misleading

The handed reconcile reports `checks: 10 / failed: 0`. I re-verified all ten
myself, by direct git/filesystem read, never from a lane self-report:

| check | my independent verification | verdict |
|---|---|---|
| STAGE1 clone + branch | `fix/snapshot-gh-cli` @ `5e7cf0a2` | genuine green |
| STAGE2 clone + branch | `fix/sandbox-30-initial-sync-script-mode-0824` @ `ad7fc6f` | genuine green |
| STAGE3 clone + branch | `docs/longrun-provider-reconciliation-0824` @ `52f05d7` | genuine green |
| STAGE4 clone + branch | `agent/process-manifest-0820` @ `839182b` | genuine green |
| RECON_STAGE3_DOC | file present, 47943 bytes | genuine green |
| RECON_STAGE1_PROBE | file present, 171 bytes | **GREEN FOR THE WRONG REASON** |

**So: no lane line is red, but "no red line" is not "no red stage."** The
reconcile scores clone/branch/path existence only. It never scores an acceptance
gate. Stages are red *underneath* a green reconcile, below.

## 2. The wrong check — named, with the correct check

`RECON_STAGE1_PROBE exit=0` points at
`.workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt` and scores **only that the path
exists**. The path exists. Its contents are entirely red:

```
PENDING: awaiting fresh-box run from sbx-provisioning-0824
mount_relayfile    exit=1     <- A1
gh_version         exit=1     <- A2
gh_auth_status     exit=1     <- A3
roster_present     exit=1     <- A4
workspace_is_mount exit=1     <- A5
```

This is the exact failure the lead brief warns about, inverted: a check pointing
at a path reports **green** for the wrong reason and hides a real red. A1–A5
have never been observed passing on a fresh box.

**The correct check** is not the path. It must parse the probe body and require
every `exit=` token to be `0`, and must reject the file while it carries the
`PENDING:` marker — e.g. score `grep -c 'exit=[^0]' stage1-freshbox-probe.txt`
as zero AND `grep -q '^PENDING:'` as non-matching. Existence of the artifact is
not evidence of the fresh-box run; it is currently evidence of its absence.

## 3. Genuine reds, by contract gate id

### STAGE 1 — PROVISIONING (highest value in the program)
- **A1, A2, A3, A4, A5 — RED, genuine.** Evidence: the five `exit=1` lines
  above. Not an artifact of a wrong check; the probe is self-declared `PENDING`.
- **A6 — RED, genuine, and this is drift the lane has not noticed.** A6 requires
  the live snapshot builder to do *three* things. Across the entire stage-1 diff
  vs `origin/main` (`scripts/create-snapshot.ts`, `scripts/smoke-sandbox-image.mjs`,
  `tests/snapshot-shell.test.ts`):
  ```
  added-line hits for 'gh '       = 12   -> installs gh          COVERED
  added-line hits for 'Relayfile' =  0   -> mounts Relayfile     ABSENT
  added-line hits for 'roster'    =  0   -> writes the roster    ABSENT
  ```
  The lane's head commit is literally `fix(snapshot): install gh in the live
  Daytona snapshot`. It is **1 of 3 of A6**. Relayfile mount and roster write
  are not in the diff at all.
- **A5 also has no implementation behind it** — only 3 added lines across the
  whole diff match `/tmp|workspace`, and the probe scores `workspace_is_mount
  exit=1`.
- **A7 — UNVERIFIED.** The reconcile never ran `gh run list --branch`. Treat as
  not-yet-green, not as green.

### STAGE 2 — SANDBOX#30
- **B1, B2, B3 — plausibly covered, best-evidenced lane in the program.** The
  diff creates the script inside `(umask 077 && cat > ...)`, with an in-code
  comment stating a post-write `chmod` would leave a group/world-readable
  window. That is precisely B2's demand — mode constrained *at creation*, not
  inherited from a lucky umask. 17 `umask|0600` references in the test file.
  Not yet scored by exit code here; it is the lane's to prove.
- **B4, B5 — UNVERIFIED.** Typecheck, full suite, and per-workflow CI were not
  run by the reconcile.

### STAGE 3 — LONG-RUNNING RECONCILIATION
- **C1–C7 — all markers present. The strongest stage on paper.** Direct counts
  in `docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md` (47943 bytes):
  supersedes `sandbox-router#16` (1) and `#17` (2); `OBSERVED` 22 /
  `DOCUMENTED` 32 / `INFERRED` 12 (C3); `DAYTONA_CAP_RULING` present (C4);
  `crossover` 7 (C5); `RECOMMENDATION` 7 and `UNKNOWN` 32 (C6).
- **C7 — clean.** Secret scan (`ghp_|github_pat_|sk-…|dtn_…|Bearer …`) returns
  **exit=1, 0 matches**. Public-repo hygiene holds.
- Marker presence is not the same as the four axes being argued well (C2); that
  is a read the verify step owes, not a grep.

### STAGE 4 — CAPABILITY ROUTING
- **D3 — RED, genuine, and confirmed by my own scoring.** `git grep -E
  'sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability'`
  run in **both** `cloud` and `cloud-provisioning-0824`:
  ```
  D3_GREP_EXIT=1  matches=0     (cloud)
  D3_GREP_EXIT=1  matches=0     (cloud-provisioning-0824)
  ```
  `cloud` does not import the router anywhere. Per chief's standing ruling this
  is **BLOCKED, not a repair item** — capability routing is unbuilt, and a
  repair owner cannot build an unbuilt feature.
- **D2 — RED, drift the reconcile does not surface at all.** The stage-4 lane
  branch is `agent/process-manifest-0820`, head `feat: implement process
  manifest v2 scaffold`, and its 2698-line diff is entirely
  `process-manifest.ts`/`.test.ts`/`errors.ts`/design doc. **There is no
  capability-selection work in the stage-4 lane.** The lane is green on
  "clone materialized" while carrying none of the work D1–D4 scores.
- **D1, D4 — UNVERIFIED.** D4 is remote CI per the ruling, not a local build.

**A methodological note for every repair owner, seen live in this step:** my
first D3 probe printed `grep_exit=0` because the exit was read through a pipe
into `head`. Re-scored without the pipe it is `1`. Never read `$?` through a
pipe — it silently manufactures a green.

## 4. Drift summary — lane roster vs. reality

The broker's lane roster states **stage 3 is on `main`**. It is not; the clone is
on `docs/longrun-provider-reconciliation-0824` (verified by `rev-parse`). The
reconcile output is right and the roster line is stale. Anyone scoring stage 3
against `main` will score the wrong tree.

## 5. Standing order of value — restated, unchanged

1. **Provisioning (stage 1)** — first, and it is where the program's real red
   is. A1–A6 are unmet on a fresh box.
2. **sandbox#30 (stage 2)** — credential exposure outranks feature work.
3. **The reconciliation (stage 3)** — closest to done.
4. **Routing (stage 4)** — last, gated behind stage 1, and correctly BLOCKED.

**An empty box beats a good router.** Stage 4 being blocked costs the program
its score and is the right outcome; a false green on capability routing would
have told Khaliq the centre of the sandbox program was finished while `cloud`
has never imported the router. Effort belongs on A6's two missing thirds —
Relayfile mount and roster write — not on stage 4.

## 6. Boundaries honoured
No code written, no lane work duplicated, nothing merged, nothing pushed, no
gate edited. Coordination only.
