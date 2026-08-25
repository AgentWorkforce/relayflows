REVIEW_VERDICT: FINDINGS

# claude-review-final — sandbox-program drive flow, post-fix state

Reviewer: claude-review-final (read the files from scratch; reran the gates and
scripts named below; did not rely on `claude-review.md` or `claude-fix.md` for
any verdict, only to identify which prior ids recur)
Date: 2026-08-25
Scope: `workflows/sandbox-program-drive.ts`, `workflows/sandbox-program/gate-integrity.sh`,
`workflows/sandbox-program/{answer-provenance-check,review-verdict-check,secret-scan}.sh`,
`workflows/sandbox-program/gates/*.sh`, all artifacts under
`.workflow-artifacts/sandbox-program/`, `.agent-relay/`, and the four lane clones.

## Summary

14 findings: 2 blocker, 3 high, 4 medium, 5 low.

The fix pass genuinely closed most of what it claimed. Verified working:
`gate-integrity verify` detects a swapped baseline (`GATE_INTEGRITY_OK` after a
legitimate reset, and the lock/baseline sha match on disk); `run_check_tap`
correctly parses real `node --test` TAP output (9 `# SKIP` lines in the stage-2
log, all matched by the allow-pattern — the mechanism is real, not assumed); the
stage-3 `heading_section_check` rewrite passes against the actual 751-line doc
(reran the gate: 15 checks, 0 failed) rather than on bare word matches; the
`ci_check` HEAD binding works live (`S2_CI ... matching HEAD ad7fc6f7…`);
`review-verdict-check.sh` correctly rejects prose (`NOT NO_ISSUES_FOUND` no
longer passes); stage 1, 2 and 4 are each honestly red for a stated reason.
All 12 shell scripts pass `bash -n`.

What did not survive review is the **run-level plumbing**: the two blockers below
each independently prevent the flow from completing, and were introduced by this
fix pass. Neither was caught because both fixes were verified in isolation
against the current on-disk state rather than against the next run.

---

finding_id: F-15
severity: blocker
file: workflows/sandbox-program/gate-integrity.sh:118-125; workflows/sandbox-program-drive.ts:351-357
issue: The F-01 fix makes the flow unable to start a second time. `baseline` now exits 1 whenever `$BASELINE` exists, but `$BASELINE` is `.agent-relay/gate-integrity.baseline.txt` — a **gitignored, host-persistent** path that nothing in the flow deletes at run start (`preflight` only creates directories). The `gate-integrity-baseline` step is `failOnError: true` by deliberate design, so the next `relayflows run` dies at step 2, before any repair owner, with no artifact and no terminal state. The guard is scoped "per run" but has no notion of a run: `manifest > "$BASELINE"` was the only thing that made run N+1 work. `claude-review.md`'s own `fix_required` (d) — "bind the baseline to the runId; verify fails if the baseline's runId is not the current run's" — is the part that was skipped, and it is exactly the part that would have made refuse-to-overwrite safe.
fix_required: Bind the baseline to the run identity rather than to file existence. Write the runId (or the run's start timestamp) as line 1 of `$BASELINE` and into `$LOCK`; `baseline` overwrites freely when the recorded runId differs from the current one, and refuses only when it matches — that is the actual "re-baselining a live run" case the guard is for. Archive on every overwrite, as it already does. Failing that, have `preflight` archive-and-clear `$BASELINE`/`$LOCK` at run start, before `gate-integrity-baseline` runs.
test_required: With `.agent-relay/gate-integrity.baseline.txt` present from a prior run, `bash workflows/sandbox-program/gate-integrity.sh baseline` must exit 0 and archive the prior manifest; a second `baseline` inside the *same* run must still exit 1.
status: OPEN
evidence: Live, this working tree — `bash workflows/sandbox-program/gate-integrity.sh baseline` → `GATE_INTEGRITY_ERROR: baseline already exists at .agent-relay/gate-integrity.baseline.txt`, `EXIT=1`. `.agent-relay/gate-integrity.baseline.txt` is dated 2026-08-25 07:41 and `.gitignore:13` is `**/.agent-relay/`. `drive.ts:355` is `failOnError: true`.

---

finding_id: F-16
severity: blocker
file: workflows/sandbox-program/secret-scan.sh:20; workflows/sandbox-program-drive.ts:1193-1206
issue: The new pre-commit secret scan false-positives on the flow's own review artifact, making the commit path unreachable on any green run. `commit-if-green` stages `claude-review.md` via the allow-list (`-name '*.md'`), and that file necessarily discusses credential shapes: it contains `relay_pa_thisisasecrettoken_do_not_leak` (matches `relay_pa_[A-Za-z0-9_]+`) and two `DAYTONA_API_KEY=`-style strings (match `[A-Z_]*_API_KEY[[:space:]]*=`). The scan therefore exits 1, the step runs `git reset`, prints `COMMIT_BLOCKED`, and exits 0 — every time. This is structural, not incidental: a security-review artifact enumerating the patterns it searched for will always trip a grep for those patterns. The `[A-Z_]*_API_KEY[[:space:]]*=` rule is the weakest of the set — `[A-Z_]*` matches the empty string, so it fires on any `_API_KEY =` in prose, docs, or an env-var example.
fix_required: (a) Exclude the review/fix narrative artifacts from the scanned set, or scan only the added lines of the staged diff rather than whole files. (b) Require a value after the key patterns — e.g. `_API_KEY[[:space:]]*=[[:space:]]*["'\'']?[A-Za-z0-9_\-]{8,}` — so a bare mention is not a hit. (c) Keep an explicit, commented allow-list for known fixture tokens (`relay_pa_thisisasecrettoken_do_not_leak`) instead of relying on the scan never seeing them.
test_required: Stage exactly the allow-list set from a green run and assert `bash workflows/sandbox-program/secret-scan.sh` exits 0; then add a file containing a real-shaped `ghp_` token and assert it exits 1.
status: OPEN
evidence: `find .workflow-artifacts/sandbox-program -type f \( -name '*.md' -o -name '*-evidence.txt' -o -name '*.json' \) ! -name '*.log' | xargs grep -EnI "<PATTERN>"` returns 2 hits in `claude-review.md` (lines 86, 199). Per-subpattern counts on that file: `relay_pa_…` = 1, `[A-Z_]*_API_KEY…=` = 2, all others 0.

---

finding_id: F-17
severity: high
file: workflows/sandbox-program-drive.ts:1188, 1198-1204, 1244-1252
issue: The `COMMIT_BLOCKED` path leaves the flow in a state the terminal-state step reports as a green. The green branch does `rm -f ${ARTIFACTS}/BLOCKED_NO_COMMIT.md` **before** the secret scan; if the scan then fails, the step resets the index, prints `COMMIT_BLOCKED` and exits 0 — with the blocked artifact already deleted and no commit created. `verify-terminal-state` then finds no `BLOCKED_NO_COMMIT.md` and no matching commit subject, falls through to its last branch, and prints `TERMINAL_STATE: GREEN_NO_COMMIT (acceptance green, nothing new to stage)`. That sentence is false on this path: there *was* something to stage, and it was withheld because it tripped a security gate. A flow whose entire purpose is to stop dishonest greens signs off on one here. The same fall-through also mislabels any other non-commit outcome (e.g. `COMMIT_FAILED`).
fix_required: Move `rm -f BLOCKED_NO_COMMIT.md` to *after* the secret scan passes and immediately before `git commit`. On a secret-scan hit, write `BLOCKED_NO_COMMIT.md` with the scan output as the failing evidence. Make `verify-terminal-state`'s third branch a hard fail (or a distinct `TERMINAL_STATE: INDETERMINATE`) rather than a green-sounding message, so an unclassified end state can never read as success.
test_required: Force a secret-scan hit on a green run and assert the terminal state is `BLOCKED_NO_COMMIT`, with `BLOCKED_NO_COMMIT.md` present and containing the scan output.
status: OPEN
evidence: `drive.ts:1188` (`rm -f`) precedes `drive.ts:1199` (scan) and `drive.ts:1202` (`git reset`; `exit 0`). `drive.ts:1250` is the unconditional `echo "TERMINAL_STATE: GREEN_NO_COMMIT (acceptance green, nothing new to stage)"; exit 0`.

---

finding_id: F-05
severity: high
file: .workflow-artifacts/sandbox-program/claude-review.md:86,90 (staged by workflows/sandbox-program-drive.ts:1190-1191)
issue: RECURS. The fix correctly stripped the vulnerability mechanism from `drive.ts:14`, `drive.ts:789-791` and `gates/stage2-sandbox30.sh:2-4`, replacing it with "id only; see internal tracking". But `commit-if-green`'s allow-list stages every `*.md` under the artifacts dir, and `claude-review.md` — which the flow writes on every run — **quotes the removed sentence verbatim**: "The generated initial-sync script is world-readable and embeds mount credentials: a live credential exposure on every sandbox that runs it, open since 2026-08-23". `AgentWorkforce/relayflows` is PUBLIC (re-verified: `gh repo view --json visibility` → `PUBLIC`). So the sanitization is undone by the commit step: the same mechanism, window and affected component would be published in the same repo, one directory over. `secret-scan.sh` cannot catch this — it looks for credential *shapes*, not prose exploit paths.
fix_required: Either exclude the review/fix narrative artifacts from the committed allow-list (they are process records, not evidence — the `*-evidence.txt` files are the evidence), or add a deterministic prose check to `secret-scan.sh` for the sandbox#30 mechanism strings (`world-readable`, `embeds mount credentials`, `live credential exposure`) across the staged set, scored by exit code like the rest.
test_required: `grep -riE 'world-readable|embeds mount credentials|live credential exposure' <staged set>` must return no hits, asserted by exit code before commit.
status: OPEN
evidence: `grep -rniE "world-readable|embeds mount credentials|live credential exposure|open since 2026-08-23" workflows/ .workflow-artifacts/sandbox-program/*.md` → hits at `claude-review.md:86` and `:90` (and `lead-findings.md:93`), none remaining in `workflows/`. `claude-review.md` appears in the simulated allow-list output.

---

finding_id: F-01
severity: high
file: workflows/sandbox-program-drive.ts:1073-1078; workflows/sandbox-program/gate-integrity.sh:118-132
issue: RECURS in a new form. The tamper guard was hardened, and then the driver handed the bypass to the agent it guards against. `claude-fix`'s task text now instructs: "run `RESET_BASELINE=1 bash workflows/sandbox-program/gate-integrity.sh baseline` yourself AFTER all your fixes are in". A reset rewrites both `$BASELINE` and `$LOCK`, so every downstream `verify` — including `gate-integrity-verify-commit`, the flow's one hard-fail — passes unconditionally against whatever state the fixer left. The stated mitigation is the `## GATE_CHANGE_DECLARED` heading in `claude-fix.md`, but **nothing checks it**: no step asserts that a `.agent-relay/gate-integrity.baseline.*.txt` archive implies a declaration, and no step diffs the archived manifest against the new one to show what the reset absorbed. The honesty of the declaration is currently the only control, which is the same posture F-01 was raised to end. (This pass's fixer did declare it — `claude-fix.md:12` — so the process worked here on trust, not on verification.)
fix_required: Add a deterministic step after `claude-fix`/`claude-fix-final` that (a) fails if any `.agent-relay/gate-integrity.baseline.*.txt` archive is newer than the run start while `claude-fix.md` has no `## GATE_CHANGE_DECLARED` heading, and (b) emits the archived-vs-current manifest diff into evidence, so the exact files a reset absorbed are on the record and every one must be named in the declaration.
test_required: Perform a `RESET_BASELINE=1` baseline with a `claude-fix.md` that lacks the heading; the new check must exit 1 and name the archive.
status: OPEN
evidence: `.agent-relay/gate-integrity.baseline.20260825T054121Z.txt` exists (a reset did occur this run); `gate-integrity.sh verify` → `GATE_INTEGRITY_OK` regardless; `grep -rn "GATE_CHANGE_DECLARED" workflows/` returns only the prompt text in `drive.ts`, no verifier.

---

finding_id: F-18
severity: medium
file: workflows/sandbox-program/gates/_lib.sh:139-142, 180-197
issue: The F-06 HEAD binding fails open. `head_sha` is set only when `[ -n "$repo_dir" ] && [ -d "$repo_dir" ]` and `git rev-parse HEAD` succeeds; on any other outcome it stays empty and the function silently falls through to the pre-fix `record "$name" 0 "all $count runs green per workflow"` — green, with no indication in the evidence line that the HEAD check was skipped. A lane clone that is missing, is a plain directory, or has a detached/unborn HEAD therefore scores exactly as it did before the fix, and the evidence file cannot distinguish "HEAD-verified green" from "HEAD check silently unavailable". This contradicts `_lib.sh`'s own header discipline: "A check that could not run is a FAIL, not a skip." All four call sites now pass a repo-dir, so the degraded path is reachable at every one of them.
fix_required: When `repo_dir` is non-empty but `head_sha` cannot be resolved, `record "$name" 1` with a note naming the reason, rather than falling through to the unbound green.
test_required: Call `ci_check NAME slug branch /tmp/not-a-git-repo` against a branch with green runs and assert the recorded exit is 1 with a "could not resolve HEAD" note.
status: OPEN
evidence: `_lib.sh:141` (`|| head_sha=""`), `_lib.sh:180` (`if [ -n "$head_sha" ]`), `_lib.sh:197` (unconditional green fall-through).

---

finding_id: F-19
severity: medium
file: workflows/sandbox-program/review-verdict-check.sh:33-36
issue: Extracting the review verdict into one script was right, but the extraction changed the semantics: the blocked-artifact test moved from *last* to *first*. In the prior inline gate the order was `NO_ISSUES_FOUND` → signoff → blocked, so a clean review won over a leftover blocked artifact; now a present `BLOCKED_NO_COMMIT.md` vetoes even `REVIEW_VERDICT: CLEAN`. Because nothing clears that file at run start (`preflight` does no cleanup) and it is not gitignored, a `BLOCKED_NO_COMMIT.md` written by any previous run permanently pins every future run red. It is also self-perpetuating: the only `rm -f` is inside `commit-if-green`'s green branch, which cannot be entered while the file exists. The script's stated rationale — don't let a self-written signoff shadow a block — justifies ordering blocked ahead of *signoff*, not ahead of *CLEAN*.
fix_required: Have `preflight` archive-and-remove a stale `BLOCKED_NO_COMMIT.md` at run start (it is a per-run terminal record, not history), and/or check `REVIEW_VERDICT: CLEAN` before the blocked branch while keeping blocked ahead of the signoff branch.
test_required: With a stale `BLOCKED_NO_COMMIT.md` on disk and a `claude-review-final.md` whose line 1 is `REVIEW_VERDICT: CLEAN`, the flow must reach the commit path.
status: OPEN
evidence: `review-verdict-check.sh:33-36` precedes the verdict read at `:39`. `.workflow-artifacts/sandbox-program/BLOCKED_NO_COMMIT.md` is present, dated 06:32, from a prior run.

---

finding_id: F-20
severity: medium
file: workflows/sandbox-program/review-verdict-check.sh:66-72; workflows/sandbox-program-drive.ts:1044-1050, 1102-1109
issue: The signoff completeness check depends on a literal output shape the driver never specifies. It enumerates ids with `grep -oE 'finding_id: F-[0-9]+'`, but the prompt asks the reviewer for "finding_id / severity / file / issue / …" — a slash-separated field list that a reviewer could reasonably render as `F-01 | blocker | …` or `**F-01** — blocker`. In any of those shapes the id set is empty, the `MISSING` loop body never runs, and the script prints `REVIEW_GATE_OK: FINDINGS, all signed off` for a signoff naming nothing — the vacuous pass F-04 was raised to close, reintroduced one layer down. Two weaker points in the same block: `grep -q "$fid" "$SIGNOFF"` matches the id *anywhere* in the file, so "F-03 is NOT fixed" counts as signed off; and a bare `F-1` prefix-matches `F-10`.
fix_required: State the exact required line shape (`finding_id: F-NN`) in both reviewer prompts, and have the script fail closed when the verdict is `FINDINGS` but zero ids parse. Match ids only on the `SIGNED_OFF_FINDINGS:` line and with word boundaries (`grep -qE "\bF-0*${n}\b"` against `head -1`).
test_required: A `claude-review-final.md` with `REVIEW_VERDICT: FINDINGS` and no parseable `finding_id:` lines must exit 1; a signoff line listing `F-01` must not satisfy a review containing `F-01` and `F-02`.
status: OPEN
evidence: `review-verdict-check.sh:66`. The current `claude-review.md` happens to use `finding_id: F-NN` (14 matches), so the hole is latent rather than active today.

---

finding_id: F-03
severity: medium
file: workflows/sandbox-program-drive.ts:359-373; workflows/sandbox-program/answer-provenance-check.sh
issue: RECURS, partially fixed. The `RULED_BY:` header requirement and its checker are correct and pass live. But the step is scheduled `dependsOn: ['gate-integrity-baseline']` — the top of the flow, before any repair owner has run — so it can only ever validate `*.ANSWER.md` files inherited from previous runs. The attack it documents is an agent writing an `ANSWER.md` *during* the run and a later step acting on it; that file does not exist when the check runs, and the check never runs again. It is additionally `failOnError: false` with no consumer of its output, which the driver comment declares as deliberate. The net enforcement today is the prompt text telling agents to check the header themselves — i.e. the same trust model as before.
fix_required: Run `answer-provenance-check.sh` again immediately before each step that reads `questions/`, at minimum before `program-lead-coordinate` and `program-acceptance`, and promote the last one to `failOnError: true` once the currently-live `ANSWER.md` files carry headers (the only one on disk, `program-lead-coordinate.ANSWER.md`, already does).
test_required: Write an `*.ANSWER.md` without a header partway through a run; a later provenance step must exit 1 and name the file.
status: OPEN
evidence: `drive.ts:369` (`dependsOn: ['gate-integrity-baseline']`), `drive.ts:371` (`failOnError: false`). Live run of the script: `ANSWER_PROVENANCE_OK exit=0 # 1 ANSWER.md file(s) checked`.

---

finding_id: F-11
severity: low
file: workflows/sandbox-program/gates/stage1-provisioning.sh:52
issue: RECURS, incompletely fixed. `S1_GH_IN_LIVE_SNAPSHOT` and `S1_RELAYFILE_MOUNT_IN_SNAPSHOT` were correctly re-anchored to the actual install/verification invocations, and stage 3 and stage 4 were rewritten properly. `S1_ROSTER_IN_SNAPSHOT` was left as bare `'roster|ROSTER'`, which passes on the word appearing in any comment or string in `create-snapshot.ts` and proves nothing structural — the same defect, in the same file, two lines below a fix for it. It is red today, so there is no false green now; the check simply cannot be trusted the day it turns green.
fix_required: Anchor it to the roster's actual install/write path in `create-snapshot.ts`, matching the treatment the other two received.
test_required: The pattern must not match a file whose only occurrence of "roster" is a comment.
status: OPEN
evidence: `stage1-provisioning.sh:52`; `S1_ROSTER_IN_SNAPSHOT exit=1 # pattern: roster|ROSTER` in `stage1-provisioning-evidence.txt`.

---

finding_id: F-21
severity: low
file: workflows/sandbox-program-drive.ts:1202
issue: `git reset` on the secret-scan-hit path is unscoped — it unstages the entire index, including anything a human had staged before the flow ran. The flow otherwise takes care to stage only declared paths (`preflight`'s drift check exists for exactly this reason); the cleanup should be equally scoped.
fix_required: `git restore --staged <the paths this step added>`, or capture `git diff --cached --name-only` before staging and reset only the delta.
test_required: Stage an unrelated file, force a secret-scan hit, and assert that file is still staged afterwards.
status: OPEN
evidence: `drive.ts:1202`.

---

finding_id: F-22
severity: low
file: workflows/sandbox-program/secret-scan.sh:33-39
issue: The scan writes to `/tmp/secret-scan-hit.$$`, a predictable path in a world-writable directory, and reads it back. `$$` is guessable and the file is not created with `mktemp`, so a pre-created symlink at that path would redirect the write. Every other temp file in this codebase uses `mktemp` (`_lib.sh:221`, `gate-integrity.sh:200`, `drive.ts:1207`). Low impact — a local-only scan on a developer box — but it is the one place the codebase's own convention is broken.
fix_required: Use `mktemp`, or capture the grep output into a shell variable (the outputs are small) and drop the temp file entirely.
test_required: n/a — convention fix.
status: OPEN
evidence: `secret-scan.sh:33`, `:36`, `:39`.

---

finding_id: F-23
severity: low
file: workflows/sandbox-program/gates/_lib.sh:134-137, 153
issue: Two small ones in `ci_check`. (a) The truncation guard fails the check whenever `gh run list` returns exactly 100 rows. Fail-closed is the right instinct, but there is no escape hatch: a branch that legitimately accumulates 100+ runs makes the gate permanently red with no way to raise the limit, and the note reads as "possible truncation" rather than "this branch is too busy for a 100-row window". Raising `limit` or paginating would keep the guard honest without the dead end. (b) `latest_shas` is declared in the `local failing skipped latest_shas` line and never used — leftover from an earlier draft of the HEAD fix.
fix_required: (a) Make the limit overridable (`CI_RUN_LIMIT`) or paginate, keeping the truncation record. (b) Drop `latest_shas`.
test_required: n/a — mechanical.
status: OPEN
evidence: `_lib.sh:134-137`, `_lib.sh:153`.

---

finding_id: F-24
severity: low
file: workflows/sandbox-program-drive.ts:675
issue: PRE-EXISTING, not introduced by this fix pass (committed in `379dfcd`). `companions?: readonly Array<{ repo: string; purpose: string }>` is invalid TypeScript — `readonly` is permitted only on array/tuple *literal* types, not on `Array<T>`. `npx tsc --noEmit --skipLibCheck --esModuleInterop` reports `error TS1354`. The flow is unaffected at runtime because `tsx` erases types without checking, but the file will not typecheck if it is ever added to the workspace's `npm run typecheck`.
fix_required: `readonly { repo: string; purpose: string }[]` or `ReadonlyArray<{ repo: string; purpose: string }>`.
test_required: `npx tsc --noEmit --skipLibCheck --esModuleInterop workflows/sandbox-program-drive.ts` returns no errors.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts(675,20): error TS1354`.

---

## Prior findings confirmed fixed (re-verified independently, not taken on report)

- **F-02** — `S2_TEST_ASSERTS_TOKEN_ABSENT` is gone, replaced by three checks that
  trace B3 to the shipping call path. `S2_ORCHESTRATOR_PINS_TOKEN_FREE_INGRESS exit=1`
  is the honest state and is declared as expected-red in the gate comment. Correct:
  the gate now tells the truth instead of passing on the word "token".
- **F-04** — `grep -q NO_ISSUES_FOUND` is gone from both scoring paths, replaced by a
  single exact line-1 token match in `review-verdict-check.sh`, called by both
  `final-review-pass-gate` and `commit-if-green`. The current `claude-review.md`,
  whose verdict line reads "**NOT NO_ISSUES_FOUND. 14 findings…**", would now be
  correctly rejected. (Residual hole in the id enumeration only — F-20.)
- **F-06** — HEAD binding implemented and working live: `S2_CI exit=0 # … matching
  HEAD ad7fc6f7e0f6bbf5ef2e0d9210c858796d7ed612`. (Fails open when unavailable — F-18.)
- **F-07** — the contradiction is resolved: gate edits are now explicitly permitted,
  scoped, and required to be declared. (The declaration is unverified — F-01.)
- **F-08** — A7/B5/D4 push ownership is stated in the contract text, and
  `RECON_*_UNPUSHED` now records the fact per lane (stage 3 shows `1 unpushed
  commit(s)`, which was previously unrecoverable from evidence).
- **F-09** — `check_probe_provenance` implemented; correctly red today
  (`S1_PROBE_PROVENANCE exit=1 # missing provenance header`) against the
  `PENDING:` placeholder probe. The BSD/GNU `date` fallback is right for macOS.
- **F-10** — `run_check_tap` verified against real output, not assumed: the stage-2
  log contains 9 per-test `# SKIP` annotations, all matching the allow-pattern, and
  the summary `# skipped N` line is correctly excluded from matching.
- **F-12** — `RECON_*_VISIBILITY` derives visibility at runtime per lane; live
  results (`cloud` PRIVATE, `sandbox` PUBLIC, `sandbox-router` PRIVATE) match
  independent `gh repo view`. The stale claim is corrected in both the driver text
  and the stage-3 gate header.
- **F-13** — `RECON_*_UNTRACKED_CI` implemented; correctly surfaces `?? .github/` on
  the stage-4 lane.
- **F-14** — `LANES.stage3.branch` now `docs/longrun-provider-reconciliation-0824`,
  matching the lane clone's actual branch.

## Note on stale evidence

`program-acceptance-evidence.txt` (05:06) and `stage3-longrun-reconcile-evidence.txt`
(05:06) predate the gate edits (07:26–07:40) and still show the old bare-grep
patterns. They are not findings, but they are not evidence for the current gates
either. I reran stage 3 into an isolated `ARTIFACTS_ROOT` to check the new
`heading_section_check` for real rather than trusting the stale file; it passes
(15 checks, 0 failed). Stages 1, 2 and 4 could not be rerun without mutating the
lane clones, so their evidence files (07:40–07:41) were read as-is — those are
post-edit and current.
