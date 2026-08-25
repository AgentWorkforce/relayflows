# ANSWER — repair-program-acceptance

**PROVENANCE: written by the workflow repair pass
(`repair-program-acceptance-repair-1`), 2026-08-25. NOT chief, NOT Khaliq.**

Nothing in this file is a new ruling. Every item below is a pointer to a
decision that was ALREADY on disk before this file existed, with the path to
the original. It exists because the previous attempt at this step had already
finished its work, printed `OWNER_DECISION: COMPLETE`, and then sat in an
agent-relay call waiting on a chief who is offline — until the 25-minute step
timeout killed it with no artifact. Do not ask any of these again.

If a question below is marked UNANSWERED, it is still unanswered. Record it,
do not invent an answer, and do not block on it.

---

## Q1 — Preview skipped on `fix/snapshot-gh-cli` (S1_CI)

**ANSWERED, by this step's own prior investigation.** Recorded in
`questions/repair-program-acceptance.md`, section "Q1 — investigated and RULED
by the program owner".

`deploy-preview` in `preview.yml` is gated repo-wide to `workflow_dispatch`
("TEMPORARY (2026-05-14) … during the cloud-web migration push"). It skips
identically on every branch in the repo. The skip is correct for this change,
and it is not a path filter.

**Action:** record it. `S1_CI` stays red and is reported red. Do NOT edit
`ci_check` or `stage1-provisioning.sh` to add a ruling channel — that is
weakening a gate to erase a red, which chief's standing ruling forbids
(`questions/program-lead-coordinate.ANSWER.md`).

**Residual, UNANSWERED:** whether `ci_check` should grow a ruling channel for
correct skips is a gate-design question, i.e. chief's. It does not block this
step and it is not a repair. Note it in the signoff; do not re-ask it.

## Q2 — fresh-box probe (S1_PROBE_*)

**UNANSWERED and correctly external.** Needs a live Daytona credential and
spend approval, both Khaliq-owned. Already escalated once as a HUMAN_QUESTION
and already appended to `BLOCKED_NO_COMMIT.md`.

**Action:** carry it into the signoff as blocked-on-external-approval with the
existing evidence. Do NOT re-escalate, do NOT re-DM, do NOT wait. Ask-ONCE has
been satisfied.

## Q3 — `S1_ROSTER_IN_SNAPSHOT`

**UNANSWERED by chief.** But this step's own record already establishes it is
moot for stage colour: `S1_PROBE_*` holds stage 1 red regardless of how Q3 is
resolved.

**Action:** record as open, attributed to the stage-1 lane. Do NOT add the
token `roster` to a comment to flip the grep — the question file names that
correctly as manufacturing a green.

## Stage 4 — capability routing

**ANSWERED by chief, standing ruling.** Full text in
`questions/program-lead-coordinate.ANSWER.md`:

> Stage 4 returns to BLOCKED, and that is the correct state. … Capability
> routing is **unbuilt**, not broken. A repair owner cannot build an unbuilt
> feature, so this blocks once, records the reason, and stops — it does not
> enter a repair loop.

**Action:** stage 4 does NOT get assigned to a repair owner and does NOT get
re-asked. `S4_CLOUD_CONSUMES_ROUTER exit=1` and `S4_ROUTER_CI exit=1` are
carried into the signoff as BLOCKED_MISSING with chief's ruling cited. The gate
stays exactly as it is.

---

## Therefore

`program-acceptance` cannot go green on this pass, and that is the correct and
expected outcome — not a failure of this step. Write
`program-acceptance-signoff.md` with first line:

    PROGRAM_ACCEPTANCE: RED_WITH_BLOCKERS

listing all four `ACCEPT_*` lines verbatim and the disposition above for each
red. Then print `OWNER_DECISION: COMPLETE` and make no further tool calls.
