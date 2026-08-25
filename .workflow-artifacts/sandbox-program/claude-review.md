# claude-review — sandbox-program drive flow

Reviewer: claude-reviewer (fresh eyes, read the files, reran nothing from a summary)
Date: 2026-08-25
Scope reviewed:
- `workflows/sandbox-program-drive.ts` (working tree, incl. uncommitted diff)
- `workflows/sandbox-program/gate-integrity.sh`
- `workflows/sandbox-program/gates/{_lib,lane-reconcile,program-acceptance,stage1-provisioning,stage2-sandbox30,stage3-longrun-reconcile,stage4-capability-routing}.sh`
- All gate evidence + artifacts under `.workflow-artifacts/sandbox-program/`
- The four lane clones and `~/Projects/AgentWorkforce/cloud`
- `.agent-relay/gate-integrity.baseline.txt` and `.pre-repair-0825`

## Verdict

**NOT NO_ISSUES_FOUND. 14 findings: 2 blocker, 3 high, 5 medium, 4 low.**

Direct answers to the four questions asked:

1. **Is anything scored by absence of an error rather than by exit code?**
   Not inside `gates/*.sh` — `_lib.sh` is disciplined and correct. But **yes in
   the driver**: `final-review-pass-gate` and `commit-if-green` score the review
   by `grep -q NO_ISSUES_FOUND` on a reviewer's *prose*, and alternatively by
   the existence of a file the *fixer itself* writes (F-04).
2. **Is any exit code read through a pipe?** No. Every scored command uses
   `cmd >> "$LOG" 2>&1 || rc=$?`. Verified by grep across all gate scripts.
3. **Is CI read with `--branch`, and is empty a FAIL?** Yes to both, correctly —
   `_lib.sh:113`, and `count -eq 0` → `record 1`. Confirmed live:
   `S4_ROUTER_CI exit=1 # no workflow runs … empty is NOT a pass` with a 3-byte
   `[]` JSON on disk. **But** the runs are never tied to the lane's HEAD (F-06).
4. **Can any gate go green while the real-world effect is absent?** **Yes, and
   one currently is.** Stage 2 reports `checks: 8 / failed: 0` while contract
   item **B3 is unmet on the shipping code path** (F-02). Separately the
   integrity guard itself reports a false `UNCHANGED` (F-01).

---

finding_id: F-01
severity: blocker
file: workflows/sandbox-program/gate-integrity.sh:100-110 (`baseline` case); .agent-relay/gate-integrity.baseline.txt
issue: The tamper guard is defeatable by simply re-running it, and it was in fact defeated in this run. `manifest > "$BASELINE"` overwrites an existing baseline unconditionally — there is no refuse-if-exists, no run-id binding, and the baseline file is not itself in the hashed manifest. `.agent-relay/` is gitignored (`.gitignore:13`), so a re-baseline leaves no VCS trace. The guard's own text says "restore with: git checkout -- <path> (never by re-baselining)" and it cannot enforce that. Concretely: `.agent-relay/gate-integrity.baseline.txt` has mtime `2026-08-25 06:50 CEST (04:50Z)`, its driver hash was changed from `0b7533a3…` to `393e03bb…` by `repair-program-acceptance-repair-1` (per `gate-integrity-rebaseline.md`), and `gate-integrity-evidence.txt` at `05:06:06Z` — 16 minutes later — reports `GATE_INTEGRITY_UNCHANGED exit=0`. That evidence line is false with respect to the run-start baseline. The actor here was honest (it declared the amendment, preserved `.pre-repair-0825`, and the driver edit is a hardening one); a dishonest one leaves nothing behind at all. `gate-integrity-verify`, `-verify-final` and `-verify-commit` are all `failOnError: true` and all three are neutralised by the same one-line move.
fix_required: (a) In `baseline`, refuse to overwrite an existing baseline unless an explicit `RESET_BASELINE=1` is set, and always append rather than replace, keeping every prior manifest. (b) Include the baseline file's own sha256 in the run's step output and in `gate-integrity-evidence.txt` at baseline time, so `verify` can detect a baseline swapped between the two. (c) Move the baseline out of a gitignored directory, or write a second copy to a location the flow does not tell agents to write. (d) Bind the baseline to the runId; `verify` fails if the baseline's runId is not the current run's. (e) Have `verify` diff the *driver* against `git HEAD` as well, so a driver edit is visible even when the baseline agrees with it.
test_required: A negative test that (1) takes a baseline, (2) edits `gates/stage4-capability-routing.sh`, (3) re-runs `gate-integrity.sh baseline`, (4) runs `verify`, and asserts `verify` exits **1**. Today it exits 0.
status: OPEN
evidence: `stat` mtime 2026-08-25 06:50 on `.agent-relay/gate-integrity.baseline.txt`; `diff .agent-relay/gate-integrity.baseline.txt.pre-repair-0825 .agent-relay/gate-integrity.baseline.txt` → one changed line, `workflows/sandbox-program-drive.ts`; `.workflow-artifacts/sandbox-program/gate-integrity-evidence.txt` line 5: `GATE_INTEGRITY_UNCHANGED exit=0  # 9 files` at `2026-08-25T05:06:06Z`; `.workflow-artifacts/sandbox-program/gate-integrity-rebaseline.md`.

---

finding_id: F-02
severity: blocker
file: workflows/sandbox-program/gates/stage2-sandbox30.sh:33 (`S2_TEST_ASSERTS_TOKEN_ABSENT`)
issue: Stage 2 is the only stage reporting `failed: 0`, and that green includes a contract item that is **false on the code path that actually ships**. Contract B3 is "the fixture token is absent from the generated content". The gate scores it with `grep_check … 'token|credential|secret'` against `src/mount-script.test.ts` — i.e. by the word "token" appearing anywhere in a 1300-line test file. The real assertions say the opposite of B3 on the default path: `src/mount-script.test.ts:918-923` asserts `readFileSync(scriptPath,'utf8').includes(TOKEN)` is **true** ("expected the default ingress to put the credential in the script"). Token-absence is proven only under `tokenIngress: "creds-file"` (`src/mount-script.test.ts:924-966`), which is opt-in: `tokenIngress?: "argv"|"env"|"creds-file"` is optional with no default (`src/mount-script.ts:84`), and the sole production caller — `src/orchestrator.ts:219`, `buildRelayfileMountInitialSyncBackgroundShell({...config, idleTimeoutSeconds}, initialSyncRun)` — never sets it. `git grep tokenIngress -- src` outside tests returns only `mount-script.ts`'s own definition. So on a real sandbox today the credential literal is still written into the generated script; only its mode changed. B1/B2/B4 are genuinely and well proven (real `statSync(…).mode & 0o777 === 0o600` under an explicit `umask 022`, plus a runtime refuse-to-launch regression test) — B3 is not.
fix_required: Replace the grep with a real assertion. Either (a) add `absent_check S2_TOKEN_ABSENT_FROM_GENERATED <generated-script-fixture> '<fixture-token>'` driven by a test that renders the script under the **production** option set, or (b) make the gate assert that the production call site pins a token-free ingress (`grep_check S2_ORCHESTRATOR_PINS_INGRESS src/orchestrator.ts 'tokenIngress'`), or (c) escalate to chief that B3 as written is unmet and stage 2 should be red, not green. Do not satisfy this by adding the word "token" anywhere.
test_required: A test that builds the launcher with exactly the options `orchestrator.ts` passes and asserts the on-disk generated script does **not** contain `TOKEN`. It must fail on today's code.
status: OPEN
evidence: `.workflow-artifacts/sandbox-program/stage2-sandbox30-evidence.txt`: `S2_TEST_ASSERTS_TOKEN_ABSENT exit=0  # pattern: token|credential|secret` … `checks: 8 / failed: 0`; `sandbox-sec30-0824/src/mount-script.test.ts:918`; `sandbox-sec30-0824/src/mount-script.ts:84`; `sandbox-sec30-0824/src/orchestrator.ts:216-225`.

---

finding_id: F-03
severity: high
file: workflows/sandbox-program-drive.ts:159-166 (REPAIR_RULES step 2); .workflow-artifacts/sandbox-program/questions/repair-program-acceptance.ANSWER.md
issue: The `*.ANSWER.md` channel has no authorship control. The driver tells every repair owner: "READ `questions/<step-name>.ANSWER.md` … If your question is already answered there, that IS the reply — act on it and ask no one. **Chief's rulings are standing and they bind steps other than the one that asked.**" Nothing verifies that an `ANSWER.md` came from chief. Any agent can write one, into the same directory it is instructed to write its questions to, and every later step will treat it as a binding standing ruling. This already happened: `questions/repair-program-acceptance.ANSWER.md` is self-labelled `**PROVENANCE: written by the workflow repair pass (repair-program-acceptance-repair-1). NOT chief, NOT Khaliq.**` That instance is honest and only re-points at genuine prior rulings — but it is structurally the same move as editing a gate, one level up: an agent authoring the authority that then excuses its reds. `chief`'s own file (`program-lead-coordinate.ANSWER.md`) carries no signature that distinguishes it from the self-written one.
fix_required: Split the directories: questions written by agents go to `questions/`, answers are read from a separate `rulings/` path that no repair-owner prompt grants write access to. Require every answer file to begin with a `RULED_BY: chief|khaliq` line plus a checksum or countersignature, and have a deterministic step reject/quarantine any `ANSWER.md` whose author cannot be established. Agent-authored notes belong in `<step>-repair.md`, never in an `ANSWER.md`.
test_required: A deterministic check that fails when an `ANSWER.md` lacks a valid `RULED_BY:` header, wired ahead of the steps that consume rulings.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts:160-163`; `.workflow-artifacts/sandbox-program/questions/repair-program-acceptance.ANSWER.md:1-8`.

---

finding_id: F-04
severity: high
file: workflows/sandbox-program-drive.ts:1078-1080 and 1117
issue: The review gate is scored by string presence, not by exit code, and can be self-certified by the agent it judges. Two paths:
  (a) `grep -q "NO_ISSUES_FOUND" ${ARTIFACTS}/claude-review-final.md` → `REVIEW_GATE_OK; exit 0`. The literal token `NO_ISSUES_FOUND` appears in the reviewer's own task text and in this very document. A final review that says "this is **not** NO_ISSUES_FOUND, see 6 blockers" passes the gate. Substring match on prose is exactly the "scored by absence of an error" defect the flow's own header forbids.
  (b) `test -f ${ARTIFACTS}/claude-signoff.md && { echo REVIEW_GATE_OK; exit 0; }` is evaluated **before** the `BLOCKED_NO_COMMIT.md` branch, and `claude-signoff.md` is written by `claude-fix-final` — the fixer certifying its own work. `claude-fix-final`'s own `verification` is `test -s claude-signoff.md || test -s BLOCKED_NO_COMMIT.md`, so `touch`ing the signoff satisfies the step *and* opens the commit gate. `commit-if-green:1117` uses the same disjunction for `REVIEW_RC`.
fix_required: Score the review on a structured verdict the reviewer must emit, not a substring — e.g. require line 1 of `claude-review-final.md` to be exactly `REVIEW_VERDICT: CLEAN` or `REVIEW_VERDICT: FINDINGS`, matched with `head -1 … | grep -qx`. Remove the `claude-signoff.md` bypass entirely, or require it to cite the specific finding ids from `claude-review-final.md` and have a deterministic step verify every id is accounted for. Order the `BLOCKED_NO_COMMIT.md` branch before any OK branch.
test_required: A fixture `claude-review-final.md` containing findings *and* the string `NO_ISSUES_FOUND` in prose; assert `final-review-pass-gate` exits non-zero. It exits 0 today.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts:1078`, `:1079`, `:1117`, `:1065`.

---

finding_id: F-05
severity: high
file: workflows/sandbox-program-drive.ts:1122 (`commit-if-green` `git add`); workflows/sandbox-program-drive.ts:14,757-758; workflows/sandbox-program/gates/stage2-sandbox30.sh:2-3
issue: `AgentWorkforce/relayflows` is **PUBLIC** (verified via `gh repo view`), and the flow's own rule is "sandbox, sandbox-router and relayflows are PUBLIC repos: no customer names, no credentials, no exploit paths in any file, commit, issue or comment." Already-committed files in this public repo describe an unrotated live credential exposure in operational detail: `sandbox-program-drive.ts:757` — "The generated initial-sync script is world-readable and embeds mount credentials: a live credential exposure on every sandbox that runs it, open since 2026-08-23" — plus the same in `gates/stage2-sandbox30.sh:2-3`. Per F-02 the credential is still written into that script today, so this is a live exploit path, publicly described, naming the affected component and the window. Separately, `commit-if-green` runs `git add … ${ARTIFACTS}`, and `.workflow-artifacts/` is **not** gitignored — only `.agent-relay/` is (`.gitignore:13`). On a green run that stages all 28 currently-untracked artifact files into the public repo, including `chief-restart.log` (51 KB), four run logs, `stage2-sandbox30.log` (196 KB), internal chief rulings, internal DM message id `217836465907306496`, and internal branch/lane names. I found **no raw credential** in any of them (scanned for `gh[pousr]_`, `sk-`, `xox[baprs]-`, `AKIA`, `-----BEGIN`, `relay_pa_`, `dtn_`, `DAYTONA_API_KEY=`, and customer-style names — all clean), so this is an exposure-surface finding, not a leak-in-progress.
fix_required: (a) Rewrite the vulnerability descriptions in `sandbox-program-drive.ts` and `gates/stage2-sandbox30.sh` to reference `sandbox#30` by id only, with no mechanism, window, or impact statement, until Khaliq confirms rotation and disclosure. (b) Narrow the `git add` to an explicit allow-list of artifact files (`ACCEPTANCE.md`, `*-evidence.txt`, `BLOCKED_NO_COMMIT.md`, `RUN-REPORT.md`) and add `.workflow-artifacts/**/*.log` to `.gitignore`. (c) Add a deterministic pre-commit secret/PII scan over exactly the staged set, scored by exit code, ahead of `git commit`.
test_required: A gate that runs the secret scan over `git diff --cached --name-only` and fails on any hit; plus an assertion that no `*.log` is ever staged.
status: OPEN
evidence: `gh repo view AgentWorkforce/relayflows --json visibility` → `PUBLIC`; `git grep -nEi 'world-readable|credential exposure' -- workflows/` → 4 committed hits; `git ls-files .workflow-artifacts/ | wc -l` → 2 tracked vs 28 untracked; `grep -n 'workflow-artifacts' .gitignore` → no match.

---

finding_id: F-06
severity: medium
file: workflows/sandbox-program/gates/_lib.sh:107-160 (`ci_check`)
issue: `ci_check` requests `headSha` in the `--json` field list, writes it to the artifact, and then never uses it. It takes the latest run per workflow name by `createdAt` and scores its conclusion, with no assertion that the run corresponds to the lane clone's HEAD or to the remote branch tip. A lane that commits locally and does not push — or pushes and is read before CI starts — scores green off a stale run for an older commit. That is precisely the "real-world effect absent" class the contract is meant to close, and stage 3's clone is in that state right now (local HEAD `52f05d7` is unpushed; `origin/docs/longrun-provider-reconciliation-0824` is at `226230b`) — it escapes only because stage 3 has no CI check. Also: `--limit 100` can truncate on a busy branch, silently dropping a workflow name from `group_by`, and a workflow that has *never* run on the branch is invisible to `group_by` rather than red.
fix_required: Capture `HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)` and pass it to `ci_check`; fail unless the scored run's `headSha` equals it, with a distinct note for "runs exist but none for HEAD". Fail when `length == limit` (possible truncation) instead of scoring a truncated page. Take an expected-workflow-name list per repo and fail on any name absent from the result set.
test_required: A fixture CI JSON whose only green run is for a non-HEAD sha; assert `ci_check` records exit=1.
status: OPEN
evidence: `_lib.sh:114` requests `headSha`, no later reference to it; `.workflow-artifacts/sandbox-program/stage1-provisioning-S1_CI-ci.json` (4 runs, all `5e7cf0a2`, matching HEAD today by coincidence, not by assertion); `git -C sandbox-router-longrun-0824 log --oneline @{u}..HEAD` → 1 unpushed commit.

---

finding_id: F-07
severity: medium
file: workflows/sandbox-program-drive.ts:1035-1041 (`claude-fix`) and 1051-1055 (`claude-fix-final`), vs 1097-1103 (`gate-integrity-verify-commit`)
issue: The flow instructs an agent to do the exact thing that voids the run. `claude-fix`'s task says "Fix every valid finding and add or update the proof each one needs — **a gate assertion**, a test, or a recorded command"; `claude-fix-final` says "fix them, add or update the proofs, and rerun the affected gates". Both run after `gate-integrity-verify-final`, and `gate-integrity-verify-commit` (`failOnError: true`) sits immediately downstream. So a fixer that follows its instructions hard-fails the run — and the only way to make its own fix survive is to re-baseline (F-01), which is what an agent already did once tonight. This is the loop that produced the two false greens the guard was written for.
fix_required: State the rule in `claude-fix`/`claude-fix-final` explicitly: findings about a gate are written up as `GATE_CHANGE_REQUESTED` in the fix artifact for a human/chief to apply between runs, never edited in place. Route gate-fix findings to a separate, out-of-band step that runs before `gate-integrity-baseline` on the next run. Remove "a gate assertion" from the list of things a fixer may add.
test_required: n/a — prompt/DAG correction. Confirm by dry-run that no agent step downstream of `gate-integrity-baseline` is told it may edit `gates/` or the driver.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts:1036-1037`, `:1052-1053`, `:1097-1103`; `.workflow-artifacts/sandbox-program/gate-integrity-rebaseline.md`.

---

finding_id: F-08
severity: medium
file: workflows/sandbox-program-drive.ts:172 (REPAIR_RULES) vs .workflow-artifacts/sandbox-program/ACCEPTANCE.md A7/B5/D4
issue: The contract and the rules contradict each other. Every repair owner is told "Never merge and never push", while A7, B5 and D4 require `gh run list --branch` to show green CI **per workflow on the lane branch** — which only exists after a push. A repair owner that fixes code therefore cannot ever turn its CI check green without breaking a standing rule; `S1_CI` and `S4_ROUTER_CI` are unsatisfiable-by-construction for the agent that owns them. Relatedly, the flow records nothing that would let you tell whether a push happened: `origin/fix/sandbox-30-initial-sync-script-mode-0824` moved to `ad7fc6f` at `2026-08-25 04:19 CEST (02:19Z)`, inside this run's window, and the artifacts contain no per-step git provenance that would attribute it to the live lane agent (`sbx-sec30-0824`, outside this flow) rather than to `fix-sec30`. I could not resolve the attribution from what is on disk. See also F-13.
fix_required: Have chief rule explicitly on who pushes lane branches. Either carve out "a repair owner may `git push` its own lane branch, never `main`, never `--force`" in REPAIR_RULES, or move A7/B5/D4 to "CI green on the branch as last pushed by the lane, and the lane is responsible for pushing". Add to `lane-reconcile` a deterministic record of `HEAD`, `@{u}`, and `git log @{u}..HEAD` per lane at run start and again at acceptance, so any push during the run is visible in evidence.
test_required: `lane-reconcile` evidence must carry `RECON_<lane>_UNPUSHED exit=N` per lane at both timestamps.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts:172`; `ACCEPTANCE.md` A7/B5/D4; `git -C sandbox-sec30-0824 for-each-ref refs/remotes/origin/fix/sandbox-30-initial-sync-script-mode-0824` → `2026-08-25 04:19:03 +0200`.

---

finding_id: F-09
severity: medium
file: workflows/sandbox-program/gates/stage1-provisioning.sh:47-58
issue: A1–A5 — the highest-value gates in the program — are scored by grepping a plain-text file that lives in `.workflow-artifacts/sandbox-program/`, the one directory every repair owner is explicitly told to write to. `S1_PROBE_MOUNT` passes on the literal string `mount_relayfile exit=0` appearing anywhere in `stage1-freshbox-probe.txt`. There is no signature, no host identity, no sandbox id, no timestamp binding, and no link to a provisioning run. Today the file is honest — `PENDING: awaiting fresh-box run from sbx-provisioning-0824` with all five checks `exit=1`, which is exactly the right behaviour and the repair owner deserves credit for it — but the entire stage-1 acceptance is one `echo` away from green with no box ever provisioned, and the prompt that would tempt an agent there (`fix-provisioning`) has write access to that path.
fix_required: Require the probe transcript to carry a provenance header the gate checks: sandbox id, provider, image/snapshot digest, ISO timestamp, and the `mount` output verbatim. Have the gate reject a transcript older than the run start or whose snapshot digest does not match `infra/sandbox-snapshot.ts`. Better: have the probe write into a path no agent prompt names, produced by a deterministic step that shells into the box.
test_required: A test that a hand-written probe with no provenance header is rejected (`S1_PROBE_PRESENT exit=1`).
status: OPEN
evidence: `stage1-provisioning.sh:48-58`; `.workflow-artifacts/sandbox-program/stage1-freshbox-probe.txt` (7 lines, no provenance); `workflows/sandbox-program-drive.ts:557-570` instructs an agent to author that exact file.

---

finding_id: F-10
severity: medium
file: workflows/sandbox-program/gates/_lib.sh:60-70 (`run_check`) vs :129-145 (`ci_check`)
issue: The two scoring paths apply opposite discipline to a skipped test. `ci_check` deliberately refuses a skipped workflow — "skipped is neither pass nor fail; an owner must rule whether the skip is correct" — and that is the right call, correctly held for `S1_CI` this run. `run_check` has no equivalent: `npm test` exits 0 whether 784 tests ran or 9 of them were env-gated out. Stage 2's `S2_FULL_TESTS exit=0` (contract B4, "full test suite green") was recorded with `# skipped 9` in the log, including three live-provider tests that self-report `# SKIP DAYTONA_API_KEY is not set` — the same class of "the job that mattered was skipped" that `ci_check` exists to catch. The sandbox#30 tests themselves all ran and passed, so B4 is not currently wrong; the asymmetry is.
fix_required: Add `run_check_tap` (or a post-hoc parse of the gate log) that fails when the TAP `# skipped` count is non-zero unless the skips are on a declared allow-list, mirroring `ci_check`'s three-outcome model.
test_required: Assert `S2_FULL_TESTS` records a distinct `NOT-RUN` state when `# skipped > 0` and no allow-list entry covers it.
status: OPEN
evidence: `.workflow-artifacts/sandbox-program/stage2-sandbox30.log:5846` `# skipped 9`; `:1728` `# SKIP DAYTONA_API_KEY is not set`; `stage2-sandbox30-evidence.txt` `S2_FULL_TESTS exit=0`.

---

finding_id: F-11
severity: low
file: workflows/sandbox-program/gates/stage1-provisioning.sh:42; stage3-longrun-reconcile.sh:26-45; stage4-capability-routing.sh:45-47
issue: Several `grep_check` patterns are loose enough to pass on an unrelated match or a comment. `S1_GH_IN_LIVE_SNAPSHOT` uses `'gh|github-cli|githubcli'` — bare `gh` matches inside `high`, `through`, `light`, `weight`; it happens to be safe in `create-snapshot.ts` today (all 10 matches are the standalone token `gh`, verified) but the pattern proves nothing structural, and it would pass on a comment reading "TODO: install gh". `S1_RELAYFILE_MOUNT_IN_SNAPSHOT` matches the word `relayfile` anywhere, including the file's own doc-comment on line 5. `S3_AXIS_*`, `S3_CROSSOVER` (`'crossover|breakeven|59\.8'`) and `S3_RECOMMENDATION` pass on a single mention — C5 asks for "a crossover point … not a single number" and the gate cannot tell the difference. `S4_ROUTING_BY_CAPABILITY` greps `capabilit` in `routing.ts`; it is genuinely satisfied today (`src/routing.ts:65-120` implements real per-capability eligibility with `requiredCapabilities`/`forbiddenCapabilities`/`gpuTypes`/`isolation`/`egressClasses`, and there are zero hardcoded provider names in the file), but the check would pass equally on a file that only mentions the word.
fix_required: Anchor the patterns to the construct, not the word: for gh, match the actual install invocation (e.g. `apt-get install[^\n]*\bgh\b` / `addLocalFile[^\n]*gh`); for the doc axes, require a labelled section heading (`^#+ .*[Cc]rossover`) plus at least one `[OBSERVED]`/`[DOCUMENTED]` tag in that section; for D2, assert the exported symbol, not a substring.
test_required: For each tightened pattern, a negative fixture that contains the bare word in a comment and must not pass.
status: OPEN
evidence: `stage1-provisioning.sh:42`; `cloud-provisioning-0824/scripts/create-snapshot.ts:5`; `stage3-longrun-reconcile.sh:37`; `sandbox-router/src/routing.ts:65-120`.

---

finding_id: F-12
severity: low
file: workflows/sandbox-program-drive.ts:172 (REPAIR_RULES); workflows/sandbox-program/gates/stage3-longrun-reconcile.sh:13-14
issue: A standing rule rests on a wrong premise. REPAIR_RULES states "sandbox, sandbox-router and relayflows are PUBLIC repos" and `stage3-longrun-reconcile.sh` builds its hygiene reasoning on the same claim. Verified: `AgentWorkforce/sandbox` PUBLIC, `AgentWorkforce/relayflows` PUBLIC, **`AgentWorkforce/sandbox-router` PRIVATE**, `AgentWorkforce/cloud` PRIVATE. The practical effect is benign (the rule is over-strict for sandbox-router, and the stage-3 doc — `docs/PRIVATE-longrun-provider-reconciliation-2026-08-24.md`, self-labelled "Not for publication, not for a customer-facing page" — is safe where it sits). But the roster of public repos is exactly the sort of fact a repair owner will act on without rechecking, and being wrong in the *other* direction later would be a real leak. Also: `stage3-longrun-reconcile.sh:14` says the gate "refuses content that would leak … the PRIVATE- economics material pasted into a public doc" and implements no such check — only the raw-token regex `S3_NO_RAW_TOKENS`. A comment that claims a check that does not exist is worse than no comment.
fix_required: Correct the repo list, and derive it at runtime (`gh repo view --json visibility`) rather than hardcoding it in a prompt. Either implement the PRIVATE-material check the stage-3 comment promises, or delete the claim from the comment.
test_required: A deterministic preflight check that records each in-scope repo's visibility by exit code into evidence.
status: OPEN
evidence: `gh repo view AgentWorkforce/sandbox-router --json visibility` → `PRIVATE`; `workflows/sandbox-program-drive.ts:172`; `gates/stage3-longrun-reconcile.sh:13-14`.

---

finding_id: F-13
severity: low
file: /Users/khaliqgant/Projects/AgentWorkforce/sandbox-router/.github/workflows/ci.yml (untracked)
issue: A `.github/workflows/ci.yml` (name `CI`, running typecheck/test/build on `push: branches: "**"`) exists untracked in the stage-4 lane clone, mtime `2026-08-25 01:28`, inside this run's window. `S4_ROUTER_CI` is the check that reads `gh run list` for that repo, and it is currently red for exactly the reason that there is no pipeline (`no workflow runs on AgentWorkforce/sandbox-router@agent/process-manifest-0820 — empty is NOT a pass`, with a 3-byte `[]` on disk). Authoring the CI pipeline for the repo whose CI you are being scored on is not the same as editing the gate — CI config is legitimately "code, tests or config" — but it is adjacent enough to be worth a ruling, and it has changed nothing: the file is uncommitted and unpushed, so `S4_ROUTER_CI` correctly stayed red. Note `sandbox-router`'s own tracked HEAD is `839182b` from 2026-08-20 and nothing in this run touched it, consistent with chief's ruling that stage 4 is unbuilt and blocked.
fix_required: Get a ruling on whether a repair owner may add a CI workflow to a repo whose CI check it is judged by. If yes, require it to be committed and disclosed in the `-repair.md` artifact; if no, revert it. Either way, have `lane-reconcile` record untracked files under `.github/` per lane as their own check rather than leaving them invisible (`lane-reconcile.sh` scopes stage 4 to `src docs` only, so this file appears in no evidence file).
test_required: `lane-reconcile` emits `RECON_<lane>_UNTRACKED_CI exit=N` per lane.
status: OPEN
evidence: `ls -la sandbox-router/.github/workflows/ci.yml` → `2026-08-25 01:28`; `stage4-capability-routing-evidence.txt`: `S4_ROUTER_CI exit=1  # no workflow runs …`; `lane-reconcile.sh:52-53` scopes stage 4 to `src docs`.

---

finding_id: F-14
severity: low
file: workflows/sandbox-program-drive.ts:99 (`LANES.stage3.branch`)
issue: `LANES.stage3` declares `branch: 'main'`, but the stage-3 lane clone is on `docs/longrun-provider-reconciliation-0824` (HEAD `52f05d7`). The value is interpolated into `program-lead-coordinate`'s prompt as the lane's branch, so the coordinating agent is handed a wrong fact about the lane it is reconciling. It is harmless today only because stage 3 has no `ci_check` and `lane-reconcile` diffs against `origin/main` rather than against `LANES.stage3.branch`; the moment stage 3 grows a CI check it reads the wrong branch.
fix_required: Set `branch: 'docs/longrun-provider-reconciliation-0824'`, or derive each lane's branch from `git -C <repo> rev-parse --abbrev-ref HEAD` at reconcile time and fail when it disagrees with the declared value.
test_required: `lane-reconcile` records `RECON_<lane>_BRANCH_MATCHES_DECLARED exit=N`.
status: OPEN
evidence: `workflows/sandbox-program-drive.ts:99`; `lane-reconcile-evidence.txt` `## lane: STAGE3_LONGRUN` → `branch: docs/longrun-provider-reconciliation-0824`.

---

## Things checked and found sound (recorded so they are not re-litigated)

- **`_lib.sh` exit-code discipline is correct.** Every scored command is `cmd >> "$LOG" 2>&1 || rc=$?`; no `$?` is read after a pipe anywhere in `gates/*.sh` or `gate-integrity.sh`. A missing workdir, a missing file and a failed `gh` call are all FAIL, not skip. `program-acceptance.sh` scores each stage by `bash … || rc=$?`.
- **`ci_check` uses `--branch`, never `--commit`, and empty is a FAIL.** Demonstrated live by `S4_ROUTER_CI exit=1` on a 3-byte `[]`. The three-way success/skipped/failing split is right, and it correctly held `S1_CI` red on a `Preview` skip rather than waving it through.
- **B1/B2 are genuinely proven.** `src/mount-script.test.ts:882-923` launches the real launcher under an explicit `umask 022`, reads the mode back off disk twice (`stat` exit code + `statSync`), and `:1047-1072` is a real negative regression test that mutates the launcher back to `umask 022` and asserts it refuses to launch. 784 tests, 0 failures.
- **Stage 3's document is substantively good.** 751 lines, per-claim `[OBSERVED]`/`[DOCUMENTED]`/`[INFERRED]` labels, an explicit `DAYTONA_CAP_RULING`, a crossover stated as a function (§3.2 "stated as a function rather than a number") not a single number, a §10 UNKNOWN list, §9 supersession rulings on `#16`/`#17`, and a sources table with verification timestamps. No credentials.
- **No credential, customer name, or key found anywhere in scope.** Scanned all lane diffs, the stage-3 doc, and all 45 artifact files for `gh[pousr]_`, `sk-`, `xox[baprs]-`, `AKIA`, `-----BEGIN`, `relay_pa_`, `dtn_`, `*_API_KEY=`, and common placeholder customer names. Clean. `relay_pa_thisisasecrettoken_do_not_leak` is an obvious test fixture.
- **No repair owner wrote outside its lane, merged, or force-pushed.** Stage 1 → `scripts/`,`tests/`; stage 2 → `src/`; stage 3 → `docs/`; stage 4 → untouched. The `.claude/settings*.json` files untracked in three lane clones and in relayflows are CLI-generated permission stubs, not lane writes. The `cloud` working-tree drift (`.agents/skills/*`, `.claude/skills/*`, `package-lock.json`, `prpm.lock`) all has mtime `2026-08-24 23:30`, which predates this run's preflight and its lane clones (23:31), so it is not attributable to this flow. No merge occurred in any lane. Pushes to lane branches did occur — see F-08 for why attribution is not recoverable from the evidence.
- **Stage 4 is honestly blocked, and that is the correct state.** `git grep -nE "sandbox-router|@agent-relay/sandbox-router|selectByCapability|routeByCapability"` in `cloud` returns exit=1, zero matches — `stage4-cloud-consumer.txt` is 0 bytes. The reverted gate, the restored `S4_ROUTER_CI`, and the removal of the stage-4 repair owner are all correct responses to chief's ruling, and `verify-stage4-capability-routing` re-derives the evidence rather than quoting the prior run's file.
