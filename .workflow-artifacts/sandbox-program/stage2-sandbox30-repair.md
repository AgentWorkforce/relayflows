# Stage 2 (sandbox#30) repair log

## Red check
`S2_CI exit=1` — "no workflow runs on AgentWorkforce/sandbox@fix/sandbox-30-initial-sync-script-mode-0824 — empty is NOT a pass"

All 7 other checks (mode 0600 under umask 022, source/test assertions, typecheck,
full test suite) were already green going into this repair. The mount-script.ts
fix itself (commit 3520955, "create the detached initial-sync script mode 0600")
was already correct and complete.

## Root cause
PR #39 (`fix/sandbox-30-initial-sync-script-mode-0824`) was opened against base
branch `fix/mount-layout-contract-0823`, not `main`. `.github/workflows/ci.yml`
only triggers on `push`/`pull_request` targeting `main`, so no CI workflow had
ever run for this branch — structurally, not from a flaky run.

The base branch itself was stale: its tip commit ("align late-bound path
validation") duplicated content already merged straight to `main` as PR #34,
and `main` had since gained three more mount commits (#36, #37, #38) that this
branch's ancestry never saw. All prior merged PRs in this repo (#31, #33, #34)
target `main` directly — the non-main base here was a stacking artifact, not
intentional design.

## Fix
1. `git rebase origin/main` in the clone — git's patch-id detection skipped the
   duplicate "align late-bound path validation" commit automatically; one real
   conflict (an import-list merge conflict in `src/mount-script.test.ts` between
   this branch's new `statSync` import and unrelated upstream churn) resolved by
   keeping both.
2. Re-ran the full local check set post-rebase: `umask 022` + `node --test`
   (33/33 pass), `npm run typecheck` (clean), `npm test` (770 pass / 9 skipped,
   0 fail).
3. `git push --force-with-lease` to update the PR branch, then
   `gh pr edit 39 --base main` to retarget the PR. Base-branch edits alone don't
   fire the `pull_request` trigger (only opened/synchronize/reopened do by
   default), so an amend + force-push supplied the needed synchronize event.
4. CI ("Build & Test") is now running on the branch for the first time
   (confirmed via `gh run list`).

## Commands run (from the clone `/Users/khaliqgant/Projects/AgentWorkforce/sandbox-sec30-0824`)
```
git rebase origin/main
git add src/mount-script.test.ts && git rebase --continue
umask 022 && node --test --import tsx src/mount-script.test.ts
npm run typecheck
npm test
git push --force-with-lease origin fix/sandbox-30-initial-sync-script-mode-0824
gh pr edit 39 --repo AgentWorkforce/sandbox --base main
git commit --amend --no-edit
git push --force-with-lease origin fix/sandbox-30-initial-sync-script-mode-0824
```

## Result
Gate rerun from `/Users/khaliqgant/Projects/AgentWorkforce/relayflows`:
`bash workflows/sandbox-program/gates/stage2-sandbox30.sh` → `STAGE2_SANDBOX30_OK`,
8/8 checks green, `S2_CI exit=0` ("all 1 runs green per workflow on
AgentWorkforce/sandbox@fix/sandbox-30-initial-sync-script-mode-0824").
PR #39 now targets `main` and is otherwise untouched pending Khaliq's merge.

## No scope creep
- No changes to `relay#1570` (secrets-in-argv) or any other stage's clone.
- No merge performed; PR still open, awaiting Khaliq's merge gate.
- No credential rotation performed or recommended here — none needed for a fix
  that never let the token reach disk in the first place.

## Reconfirmation (2026-08-25T04:03:52Z)
Live rerun of `bash workflows/sandbox-program/gates/stage2-sandbox30.sh` from
`/Users/khaliqgant/Projects/AgentWorkforce/relayflows`, no changes needed:
`STAGE2_SANDBOX30_OK`, 8/8 checks exit=0, including
`S2_CI exit=0  # all 3 runs green per workflow on AgentWorkforce/sandbox@fix/sandbox-30-initial-sync-script-mode-0824`.
NOTHING_TO_REPAIR at this pass — prior repair above already holds.
