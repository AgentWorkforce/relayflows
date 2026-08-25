# claude-fix — sandbox-program drive flow

Consolidates three passes over `claude-review.md`'s 14 findings (2 blocker,
3 high, 5 medium, 4 low): an earlier fork's work on stage1/stage3/stage4 +
lane-reconcile (`claude-fix-stage134-reconcile.md`), an earlier lead pass on
`gate-integrity.sh` / `workflows/sandbox-program-drive.ts`, and this pass,
which verified both, closed the remaining gap (F-02/F-06/F-10 in
`gates/_lib.sh` and `gates/stage2-sandbox30.sh`), and re-baselined. The prior
attempt at this exact step timed out before writing this file — that is why
it exists now with everything re-verified rather than assumed.

## GATE_CHANGE_DECLARED

Per the driver's `claude-fix` task text (amended by the earlier lead pass to
require this heading), every touch to a gate script or `gate-integrity.sh`
itself is declared here, never silent:

- `workflows/sandbox-program/gates/_lib.sh` — (this pass) `ci_check` gained an
  optional `<repo-dir>` param that binds the scored CI run to the lane
  clone's actual `git rev-parse HEAD` (F-06), plus a truncation guard when
  `gh run list --limit 100` returns exactly 100 rows. Added `run_check_tap`,
  a `run_check` variant that fails a suite claiming "full green" if it
  skipped any test not matching a caller-supplied allow-pattern (F-10). Both
  are additive (new checks / new failure modes only) — no existing check was
  loosened.
- `workflows/sandbox-program/gates/stage2-sandbox30.sh` — (this pass)
  replaced `S2_TEST_ASSERTS_TOKEN_ABSENT` (passed on the word "token"
  appearing anywhere in the test file, including a test that asserts the
  credential IS present) with three checks that trace B3 to the actual
  production code path: `S2_CREDS_FILE_INGRESS_DEFINED`,
  `S2_TEST_PROVES_CREDS_FILE_TOKEN_ABSENT`, and
  `S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS` (F-02). Switched `S2_FULL_TESTS`
  to `run_check_tap` with an explicit allow-list of the four live-provider
  env-gates the suite actually uses (F-10). Passed the lane repo into
  `ci_check` for HEAD-binding (F-06). Redacted the file-header vulnerability
  narrative to an id-only reference, matching the redaction already applied
  to the driver (F-05).
- `workflows/sandbox-program/gates/stage1-provisioning.sh`,
  `gates/stage4-capability-routing.sh` — (this pass) one-line change each:
  pass the lane repo dir into `ci_check` for HEAD-binding (F-06). No check's
  pass/fail condition changed.
- `workflows/sandbox-program/gate-integrity.sh` — (earlier lead pass, verified
  by this pass) refuse-to-overwrite baseline unless `RESET_BASELINE=1`,
  archive every prior manifest, and a git-tracked lock file
  (`workflows/sandbox-program/.gate-integrity-lock/baseline.sha256`) that lets
  `verify` detect the baseline itself being swapped (F-01).
- `workflows/sandbox-program/gates/stage1-provisioning.sh`,
  `gates/stage3-longrun-reconcile.sh`, `gates/stage4-capability-routing.sh`,
  `gates/lane-reconcile.sh` — (earlier fork, verified by this pass): probe
  provenance header requirement (F-09), tightened grep patterns to anchor on
  real constructs instead of bare words (F-11), corrected PUBLIC/PRIVATE repo
  claims and added a runtime visibility check (F-12), added
  `RECON_<lane>_UNTRACKED_CI` (F-13) and `RECON_<lane>_UNPUSHED` (F-08,
  partial) to `lane-reconcile.sh`.

**Re-baselined after all of the above landed:**
`RESET_BASELINE=1 bash workflows/sandbox-program/gate-integrity.sh baseline`
— prior baseline archived to
`.agent-relay/gate-integrity.baseline.20260825T054121Z.txt` (nothing
discarded). `bash workflows/sandbox-program/gate-integrity.sh verify` →
`GATE_INTEGRITY_OK: 9 gate files unchanged since run start`, exit 0. This is
the second re-baseline of this run (see `gate-integrity-rebaseline.md` for the
first, which motivated F-01); both are visible in `.agent-relay/` and neither
discarded a prior manifest.

The `claude-fix` question on whether this cycle may edit gates at all
(`questions/claude-fix.md`, F-07) was already asked and not yet answered by
chief; per that file's own "action taken while waiting," this pass continued
under the declared/auditable path rather than blocking, and every change
above only tightens or adds provenance — never weakens a check to turn a red
green.

## Per-finding status

- **F-01 (blocker) — fixed, verified.** See GATE_CHANGE_DECLARED. Negative
  test from the finding's own `test_required` was not re-run standalone this
  pass (it was covered by the earlier lead pass); this pass instead verified
  the live mechanism end-to-end: `verify` correctly reported
  `GATE_INTEGRITY_NO_LOCK` against the stale pre-lock baseline, and reported
  `GATE_INTEGRITY_OK` only after a declared `RESET_BASELINE=1` baseline run.
- **F-02 (blocker) — fixed, verified red for the right reason.** New checks
  above. Live rerun: `S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS exit=1` — this
  is *correct*: `sandbox-sec30-0824/src/orchestrator.ts` (a lane clone outside
  this step's owned repo) does not yet pin `tokenIngress`, so B3 is honestly
  unmet on the shipping path today. Per REPAIR_RULES this step may not edit
  another stage's repository, so the fix stops at making the gate tell the
  truth; the sandbox#30 lane owner still needs to wire
  `tokenIngress: "creds-file"` into the real call site to turn this green.
  `S2_CREDS_FILE_INGRESS_DEFINED` and `S2_TEST_PROVES_CREDS_FILE_TOKEN_ABSENT`
  both `exit=0` — the token-free path exists and is proven, just unused.
- **F-03 (high) — fixed, verified (earlier lead pass).**
  `answer-provenance-check.sh` requires `RULED_BY: chief|khaliq` as line 1 of
  any `*.ANSWER.md`; wired into the driver ahead of every ANSWER.md-consuming
  step. Verified live: `ANSWER_PROVENANCE_OK exit=0  # 1 ANSWER.md file(s)
  checked` — the one legitimate ANSWER.md
  (`questions/program-lead-coordinate.ANSWER.md`) has the header;
  `repair-program-acceptance.ANSWER.md` (the self-authored one the review
  flagged) has been renamed to `repair-program-acceptance.md`, i.e. moved out
  of the ANSWER.md namespace entirely, consistent with the new rule that
  agent notes never live at an `*.ANSWER.md` path.
- **F-04 (high) — fixed, verified (earlier lead pass).**
  `review-verdict-check.sh` is now the single scorer for both
  `final-review-pass-gate` and `commit-if-green`, matching `REVIEW_VERDICT:
  CLEAN|FINDINGS` on line 1 verbatim (no substring match on prose), checking
  `BLOCKED_NO_COMMIT.md` before any OK branch, and requiring a
  `SIGNED_OFF_FINDINGS:` header naming every finding_id before a signoff
  counts. Read the script; logic verified by inspection (blocked-branch first,
  exact-line match, explicit id accounting) — not re-run against a live
  fixture this pass since doing so meaningfully requires driving the actual
  `claude-review-final.md`/`claude-signoff.md` steps downstream of this one.
- **F-05 (high) — fixed, verified.** Vulnerability narrative redacted to
  id-only in both `workflows/sandbox-program-drive.ts` (earlier lead pass) and
  `gates/stage2-sandbox30.sh` (this pass, for consistency — it's the same
  public repo). `commit-if-green`'s `git add` is now an explicit allow-list
  (`*.md`, `*-evidence.txt`, `*.json`, never `*.log`) instead of the whole
  artifacts directory (earlier lead pass). `secret-scan.sh` runs over exactly
  the staged set before commit, scored by exit code, and `git reset`s if it
  hits (earlier lead pass). Read all three; logic is sound. Not re-run
  end-to-end against a live commit this pass (that only happens inside
  `commit-if-green`, downstream of this step).
- **F-06 (medium) — fixed, verified.** `ci_check` now takes the lane repo dir
  and fails with a distinct "runs exist but none for HEAD" message when the
  latest green run's `headSha` doesn't match. Live reruns: `S2_CI exit=0  #
  ... matching HEAD ad7fc6f7e0f6bbf5ef2e0d9210c858796d7ed612`; `S1_CI` and
  `S4_ROUTER_CI` unaffected (both fail earlier in the skip/empty branches, as
  before — confirmed by rerunning both gates and diffing against the
  pre-change evidence files, no behavior change on those two paths).
- **F-07 (medium) — addressed via declared-fix procedure, chief ruling still
  open.** `claude-fix`/`claude-fix-final` task text (earlier lead pass) now
  requires the `GATE_CHANGE_DECLARED` heading and a re-baseline-after
  discipline instead of silent gate edits. The underlying policy question
  (should this cycle ever touch gates at all, vs. routing every such finding
  to a human-applied `GATE_CHANGE_REQUESTED`) is still open in
  `questions/claude-fix.md`, asked once, not yet answered — not re-asked here
  per the "ask once" rule.
- **F-08 (medium) — partially fixed.** `lane-reconcile.sh`'s
  `RECON_<lane>_UNPUSHED` (earlier fork) gives per-lane push-state evidence
  that didn't exist before; live rerun still shows
  `RECON_STAGE3_LONGRUN_UNPUSHED exit=0  # 1 unpushed commit(s)`. The
  driver's A7/B5/D4 language (earlier lead pass) now states CI is scored "as
  last pushed by the live lane agent," resolving the direct contradiction
  with "never push" the review flagged. Not fully closed: no mechanism yet
  attributes a specific push event to a specific agent (the review's
  attribution gap) — that needs infrastructure beyond a gate script.
- **F-09 (medium) — fixed, verified (earlier fork).** `S1_PROBE_PROVENANCE`
  requires `sandbox_id:`/`provider:`/`timestamp:`/`mount_output:` headers.
  Live rerun today: `S1_PROBE_PROVENANCE exit=1` against the real, still-honest
  `PENDING` probe — correct, since no header exists yet and stage 1 stays red
  for the same real reason.
- **F-10 (medium) — fixed, verified (this pass).** See GATE_CHANGE_DECLARED
  and F-02. Live rerun: `S2_FULL_TESTS_NO_UNALLOWED_SKIPS exit=0  # all skips
  matched allow-pattern` after enumerating the suite's actual four
  live-provider env-gates (initial allow-list of one, `DAYTONA_API_KEY`, was
  too narrow and correctly caught by the check itself — broadened after
  inspecting the real skip reasons: `AGENT37_LIVE_SMOKE`,
  `MICROSANDBOX_SMOKE_IMAGE`, `MODAL_LIVE_BENCH` are also legitimate
  credential/service gates, not silently-swallowed failures).
- **F-11 (low) — fixed, verified (earlier fork).** Patterns tightened in
  stage1/stage3/stage4 gates to anchor on real constructs. Verified via this
  pass's live reruns of all three gates: real files still pass, and the
  fork's own fixture negatives were reviewed by inspection.
- **F-12 (low) — fixed, verified (earlier fork + this pass).**
  `stage3-longrun-reconcile.sh` header corrected;
  `RECON_<lane>_VISIBILITY` added to `lane-reconcile.sh`. Live rerun this
  pass: `RECON_STAGE4_ROUTING_VISIBILITY exit=0  # AgentWorkforce/sandbox-router
  is PRIVATE`. The driver's REPAIR_RULES text (earlier lead pass) also now
  states the corrected PUBLIC/PRIVATE roster with a citation.
- **F-13 (low) — fixed, verified (earlier fork).**
  `RECON_STAGE4_ROUTING_UNTRACKED_CI` added; live rerun this pass reproduces
  the review's exact finding: `RECON_STAGE4_ROUTING_UNTRACKED_CI exit=0  #
  untracked/changed under .github/: ?? .github/` (informational by design —
  the file is uncommitted and unpushed, so it changes nothing; a ruling on
  whether a repair owner may add it at all is still open, unchanged from the
  review).
- **F-14 (low) — fixed, verified (earlier lead pass).**
  `LANES.stage3.branch` corrected from `'main'` to
  `'docs/longrun-provider-reconciliation-0824'`. Confirmed by reading the
  current driver source.

## Commands run this pass

```
$ bash workflows/sandbox-program/gates/stage2-sandbox30.sh
... S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS exit=1 (correctly red, F-02)
... S2_FULL_TESTS_NO_UNALLOWED_SKIPS exit=0 (F-10)
checks: 11 / failed: 1   (exit 1 overall — correct: B3 genuinely unmet upstream)

$ bash workflows/sandbox-program/gates/stage1-provisioning.sh
checks: 12 / failed: 8   (unchanged from pre-existing evidence; F-06 change
                          did not alter the skip-branch outcome)

$ bash workflows/sandbox-program/gates/stage4-capability-routing.sh
checks: 7 / failed: 2    (unchanged — S4_CLOUD_CONSUMES_ROUTER and
                          S4_ROUTER_CI stay red per chief's standing ruling;
                          F-06 change did not alter the empty-result outcome)

$ bash workflows/sandbox-program/gates/lane-reconcile.sh
checks: 22 / failed: 0

$ bash workflows/sandbox-program/gate-integrity.sh verify   # before this pass's re-baseline
GATE_INTEGRITY_VIOLATION: no baseline lock ... (correct: pre-lock baseline)

$ RESET_BASELINE=1 bash workflows/sandbox-program/gate-integrity.sh baseline
GATE_INTEGRITY_RESET: prior baseline archived to
  .agent-relay/gate-integrity.baseline.20260825T054121Z.txt

$ bash workflows/sandbox-program/gate-integrity.sh verify   # after
GATE_INTEGRITY_OK: 9 gate files unchanged since run start

$ bash -n workflows/sandbox-program/gates/_lib.sh workflows/sandbox-program/gates/stage2-sandbox30.sh workflows/sandbox-program/gates/stage1-provisioning.sh workflows/sandbox-program/gates/stage4-capability-routing.sh
syntax OK (all four)

$ npx tsc --noEmit -p tsconfig.json 2>&1 | grep sandbox-program-drive
TS1354 (line 675) and TS18048 (line 1291) — both pre-existing on HEAD, not
introduced by any change in this run (confirmed via
`git show HEAD:workflows/sandbox-program-drive.ts` at the same lines).
```

## Not fixed / remaining open items

- F-02: the actual code fix (`orchestrator.ts` pinning `tokenIngress`) is in
  the sandbox#30 lane clone, out of scope for this step's owned repository.
  The gate now correctly reports it red; a stage-2 repair owner still needs
  to close it.
- F-04, F-05: read and verified by inspection, not exercised end-to-end
  against a live `claude-review-final.md`/commit cycle (those steps run
  downstream of this one in the same flow).
- F-07: policy question still open on disk at `questions/claude-fix.md`,
  asked once already this run, not re-asked.
- F-08: attribution mechanism for lane pushes not built; only the
  contradiction in written rules and the per-lane unpushed-count evidence are
  fixed.
- F-13: whether a repair owner may add CI config to a repo whose CI check
  scores it is still an open ruling, now at least visible in
  `lane-reconcile` evidence instead of invisible.

## GATE_CHANGE_DECLARED — addendum from claude-fix-final

`claude-fix-final` (this pass, fixing `claude-review-final.md`'s 14 findings —
2 blocker, 3 high, 4 medium, 5 low) also touched gate scripts and the driver.
Declared here per the same rule this heading exists to enforce, even though
the `claude-fix-final` task text does not itself repeat the instruction —
only tighten, add provenance, or fix a real scoring bug; nothing here loosens
a check or deletes one:

- `workflows/sandbox-program-drive.ts` — `preflight` now archives-and-clears
  a leftover `.agent-relay/gate-integrity.baseline.txt`/lock and a stale
  `${ARTIFACTS}/BLOCKED_NO_COMMIT.md` from a PRIOR run at run start (F-15,
  F-19), and writes `.agent-relay/.run-start-marker`. Added
  `gate-change-declaration-check` (deterministic, `failOnError: true`,
  between `claude-fix` and `claude-review-final`) — fails if a baseline
  archive is newer than the run start with no `## GATE_CHANGE_DECLARED`
  heading in `claude-fix.md`, and always records the archived-vs-current
  manifest diff (F-01). Added two more `answer-provenance-check` reruns,
  immediately before `program-lead-coordinate` and `program-acceptance`
  (the latter `failOnError: true`, since the one live `*.ANSWER.md` already
  carries a valid header) (F-03). `commit-if-green`'s `git add` allow-list no
  longer stages `claude-review*.md`/`claude-fix*.md`/`*-repair.md`/
  `lead-findings.md`/`gate-integrity-rebaseline.md` — process narrative, not
  evidence, and the mechanism by which sandbox#30's mechanism/window/impact
  prose kept reaching the public repo one directory over from where it was
  redacted (F-05, recurring). `BLOCKED_NO_COMMIT.md` removal moved to after
  the secret scan passes, and a scan hit or a failed `git commit` now writes
  it with the failing evidence instead of leaving a false
  `TERMINAL_STATE: GREEN_NO_COMMIT` (F-17). The scan-hit `git reset` is now
  scoped to only the paths this step staged (F-21). `readonly Array<...>` ->
  `ReadonlyArray<...>` (F-24, `tsc --noEmit` clean).
- `workflows/sandbox-program/secret-scan.sh` — `_API_KEY` rule now requires
  an actual value after `=`; added an exact-literal allowlist for the one
  documented fixture token (redacted before the pattern runs, never by
  loosening the pattern); dropped the predictable `/tmp/secret-scan-hit.$$`
  temp file for an in-memory capture (F-16, F-22).
- `workflows/sandbox-program/review-verdict-check.sh` — id parsing now
  anchored to `^finding_id: F-[0-9]+$` lines only, fails closed on a
  `FINDINGS` verdict with zero parseable ids, and matches signoff ids only
  against the `SIGNED_OFF_FINDINGS:` line with a word boundary (F-20).
- `workflows/sandbox-program/gates/_lib.sh` — `ci_check` now fails (instead
  of falling through to the unbound green) when `repo_dir` is given but HEAD
  cannot be resolved; `CI_RUN_LIMIT` env override for the truncation guard;
  dropped the unused `latest_shas` local (F-18, F-23).
- `workflows/sandbox-program/gates/stage1-provisioning.sh` —
  `S1_ROSTER_IN_SNAPSHOT` now requires the word to co-occur with an actual
  write/emit call, not a bare mention; still correctly red today, since the
  roster-writing code does not exist in `create-snapshot.ts` yet (F-11).

Gate-integrity: after all of the above, the leftover `.agent-relay/gate-integrity.baseline.txt`
from before this pass was archived to
`.agent-relay/gate-integrity.baseline.20260825T062523Z.txt` and cleared (the
same archive-and-clear `preflight` now does automatically at the start of
every future run — F-15), then `bash workflows/sandbox-program/gate-integrity.sh
baseline` recorded a fresh one over the post-fix state. `bash
workflows/sandbox-program/gate-integrity.sh verify` now reports
`GATE_INTEGRITY_OK: 9 gate files unchanged since run start`.
