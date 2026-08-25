# claude-fix — stage1/3/4 + lane-reconcile findings

Scope: `gates/stage1-provisioning.sh`, `gates/stage3-longrun-reconcile.sh`,
`gates/stage4-capability-routing.sh`, `gates/lane-reconcile.sh` only.

## F-09 (medium) — fixed

`stage1-provisioning.sh`: added `check_probe_provenance()` / `S1_PROBE_PROVENANCE`.
Requires the fresh-box probe transcript to carry `sandbox_id:`, `provider:`,
`timestamp:` (ISO-8601, parseable, not before 2026-08-24), and `mount_output:`
header lines before any of the existing `*_exit=0` markers are trusted.

Verification:
```
$ ARTIFACTS_ROOT=<tmp> STAGE1_PROBE_EVIDENCE=<hand-authored bare "mount_relayfile exit=0", no header> \
  bash workflows/sandbox-program/gates/stage1-provisioning.sh
S1_PROBE_PROVENANCE exit=1  # missing provenance header...
S1_PROBE_MOUNT exit=0       # (old check alone would have passed)
overall gate exit=1         # correctly still red
```
```
$ ARTIFACTS_ROOT=<tmp> STAGE1_PROBE_EVIDENCE=<file with full provenance header> \
  bash workflows/sandbox-program/gates/stage1-provisioning.sh
S1_PROBE_PROVENANCE exit=0  # sandbox_id/provider/timestamp/mount_output present, timestamp parses
```
Real production probe (`.workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt`,
still honestly `PENDING`): `S1_PROBE_PROVENANCE exit=1` (no header) — outcome
unchanged, as required (stage 1 stays red for the same real reason).

Real gate rerun against production ARTIFACTS_ROOT:
`bash workflows/sandbox-program/gates/stage1-provisioning.sh` → exit=1,
`checks: 12 / failed: 8` (was 8 checks before; provenance check added one more
red, consistent with reality).

## F-11 (low) — fixed, stage1/stage3/stage4 parts

- `stage1-provisioning.sh:S1_GH_IN_LIVE_SNAPSHOT`: pattern tightened from bare
  `gh|github-cli|githubcli` to `apt-get install.*--no-install-recommends.*gh|command -v gh|gh --version`.
  Verified: still matches the real `create-snapshot.ts` (exit=0); a fixture
  containing only "high and light and weight" no longer matches.
- `stage1-provisioning.sh:S1_RELAYFILE_MOUNT_IN_SNAPSHOT`: tightened from bare
  `relayfile|Relayfile|RELAYFILE` to `/usr/local/bin/relayfile-mount` (the
  actual install path), so the file's own line-5 doc-comment no longer
  satisfies it. Verified against real file (exit=0) and a doc-comment-only
  fixture (correctly rejected).
- `stage3-longrun-reconcile.sh`: added `heading_section_check()` — requires a
  real markdown heading matching the axis/crossover/recommendation pattern AND
  an OBSERVED/DOCUMENTED/INFERRED label within N lines after it (40 for
  axes/recommendation, 60 for crossover — its evidence sits slightly further
  from the heading in the real doc). Replaces bare-word `grep_check` for
  `S3_AXIS_INDEFINITE/IDLE_COST/RESTART/OUR_STACK`, `S3_CROSSOVER`,
  `S3_RECOMMENDATION`. Verified real doc still passes all six (was previously
  passing on weaker patterns) and a synthetic fixture with only bare-word
  mentions (no headings/labels) correctly fails all three tested
  (`S3_AXIS_INDEFINITE`, `S3_CROSSOVER`, `S3_RECOMMENDATION`).
- `stage4-capability-routing.sh:S4_ROUTING_BY_CAPABILITY` /
  `S4_ROUTING_TEST_BY_CAPABILITY`: pattern tightened from bare `capabilit` to
  `requiredCapabilities|forbiddenCapabilities|provider\.capabilities` (the
  actual fields/lookups `routing.ts` uses). Verified against real
  `sandbox-router/src/routing.ts` and `routing.test.ts` (both exit=0) and a
  comment-only fixture (correctly rejected). Did NOT touch the
  `S4_CLOUD_CONSUMES_ROUTER` grep at line 60 or the CI check — those are
  chief's explicit, verbatim, "do not touch again" ruling (see the comment
  block directly above them) and are out of scope for F-11.

Full `stage1-provisioning.sh` and `stage3-longrun-reconcile.sh` gates were
rerun end-to-end (commands above / below). `stage4-capability-routing.sh`'s
changed lines were verified directly (both patterns re-run against the real
files with real and negative fixtures) rather than running the full gate,
since the rest of that gate runs `npm run typecheck/test/build` in the router
repo — expensive and untouched by this change; syntax-checked the whole file
(`bash -n`, passed).

## F-12 (low) — fixed

- `stage3-longrun-reconcile.sh` header comment corrected: no longer claims
  sandbox-router is PUBLIC (it is PRIVATE — the doc lives in the right repo).
  No longer falsely claims a cross-repo leak check exists; states plainly that
  `S3_NO_RAW_TOKENS` only checks raw-token-shaped strings in the doc itself.
- `lane-reconcile.sh`: added a runtime repo-visibility check per lane,
  `RECON_<label>_VISIBILITY`, derived via `git remote get-url origin` →
  `gh repo view <slug> --json visibility` — not hardcoded. Real run:
  `AgentWorkforce/cloud PRIVATE`, `AgentWorkforce/sandbox PUBLIC`,
  `AgentWorkforce/sandbox-router PRIVATE` (both stage3 and stage4 lanes point
  at it). Confirms the review's finding that the driver's REPAIR_RULES text
  ("sandbox, sandbox-router and relayflows are PUBLIC") is wrong about
  sandbox-router. (Driver text itself is the lead's file, not mine to edit.)

## F-13 (low) — fixed

- `lane-reconcile.sh`: added `RECON_<label>_UNTRACKED_CI`, informational
  (exit=0), recording any untracked/changed files under `.github/` per lane —
  previously invisible since stage 4's reconcile scope is `src docs` only.
  Real run caught the exact file the review flagged:
  `RECON_STAGE4_ROUTING_UNTRACKED_CI exit=0  # untracked/changed under .github/: ?? .github/`

## F-08 (medium) — lane-reconcile part fixed

- `lane-reconcile.sh`: added `RECON_<label>_UNPUSHED`, informational (exit=0),
  recording the upstream ref and unpushed-commit count per lane. Real run:
  `RECON_STAGE3_LONGRUN_UNPUSHED exit=0  # 1 unpushed commit(s) vs origin/docs/longrun-provider-reconciliation-0824`
  — matches the review's evidence (local HEAD `52f05d7` ahead of
  `origin/...@226230b`). All other lanes show 0 unpushed. This closes the gap
  the review identified (no per-step git provenance existed before); it does
  NOT rule on who is allowed to push a lane branch — that half of F-08 is a
  driver-text/REPAIR_RULES question for the lead/chief.

## Full lane-reconcile rerun

```
$ bash workflows/sandbox-program/gates/lane-reconcile.sh
exit=0
checks: 22
failed: 0
```
All four lanes now carry `_UNPUSHED`, `_UNTRACKED_CI`, and `_VISIBILITY`
evidence lines in addition to the pre-existing `_CLONE`/`_MATERIALIZED`.

## Not fixed / out of scope for this fork

- F-08's driver-text ambiguity (REPAIR_RULES "never push" vs A7/B5/D4 needing
  pushed CI) — needs a chief ruling, not a mechanical fix, and touches
  `workflows/sandbox-program-drive.ts` which is the lead's file.
- F-02, F-06, F-10 (gates/_lib.sh, gates/stage2-sandbox30.sh) — assigned to a
  parallel fork.
- F-01, F-03, F-04, F-05, F-07, F-14 (gate-integrity.sh, driver.ts) — assigned
  to the lead.
