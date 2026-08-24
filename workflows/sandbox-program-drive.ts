/**
 * sandbox-program-drive.ts
 *
 * Runs the sandbox program end to end and repairs it as it goes.
 *
 * The program (chief/.briefs/sandbox-lead-0824-amendment.md): route any agent
 * onto the best-capable sandbox, from any of our surfaces, with its real files,
 * attachable, and able to run long. Four stages, in the order the amendment
 * sets:
 *
 *   1  Provisioning — the n=2 fault. A sandbox arrives with no Relayfile
 *      mount, no `gh`, and no roster, so lanes fall back to an HTTPS clone
 *      into /tmp that drops uncommitted work.
 *   2  sandbox#30 — world-readable initial-sync script embedding mount
 *      credentials.
 *   3  The long-running provider reconciliation.
 *   4  Capability routing in sandbox-router, consumed by cloud. Gated behind
 *      stage 1, because an empty box beats a good router.
 *
 * WHERE THIS RUNS
 *   Locally. The flow is the DRIVER and the sandbox is the SUBJECT. It does
 *   not have to run inside a sandbox, and a runtime that cannot reach a
 *   sandbox node changes nothing about this file — treating a broken subject
 *   as a precondition would stall the program behind the bug it exists to fix.
 *   No step tries to prove sandbox reachability.
 *
 * SHAPE — repair before failure
 *   Every meaningful gate is `run-*` (deterministic, captureOutput, no
 *   failOnError) → `fix-*` (agent reading the captured output) → `verify-*`
 *   (deterministic rerun) → and finally `commit-if-green`, which reruns the
 *   full acceptance command and commits only when every exit code is zero.
 *   When anything is still red it writes BLOCKED_NO_COMMIT with the failing
 *   evidence and exits successfully, so the run reports a handled blocked
 *   state rather than crashing. A red gate is work for the team, not a reason
 *   to stop.
 *
 * KEEPING GATES ON THE CRITICAL PATH
 *   The four lanes are live interactive agents in their own clones. No gate
 *   depends on a lane process: `lane-reconcile` is a deterministic read of
 *   what is on disk (git status --short, diff stats, required files), and it
 *   is what the gates hang off. A dropped PTY or a transport failure therefore
 *   cannot masquerade as "the product failed". `program-lead-coordinate` runs
 *   in parallel with the reconcile and is a dependency of nothing.
 *
 * VERIFICATION STANDARDS (each one was paid for)
 *   - Score by exit code, never by absence of error. `$?` after a pipe reads
 *     the last stage, so gate commands write to a log with `>>` and capture
 *     the real exit code. See gates/_lib.sh.
 *   - CI via `gh run list --branch`, never `--commit`. The commit filter has
 *     returned empty for commits with green workflows, and statusCheckRollup
 *     has hidden failing workflows. An empty result is a FAIL.
 *   - A job reporting success does not mean its steps ran, and merged is not
 *     released is not deployed. Gates assert the real-world effect: the mode
 *     under a 022 umask, the call site in cloud, the fresh-box probe's own
 *     exit codes.
 *
 * RESUMABLE, NOT RESTARTABLE
 *   This program will hit red gates constantly; that is the normal case here.
 *   Run state is written to .agent-relay/workflow-runs.jsonl.
 *
 *     Run:      relayflows run workflows/sandbox-program-drive.ts
 *     Dry run:  DRY_RUN=1 relayflows run workflows/sandbox-program-drive.ts
 *     Resume:   RESUME_RUN_ID=<runId> relayflows run workflows/sandbox-program-drive.ts
 *     Restart one gate: START_FROM=run-stage2-sandbox30 PREVIOUS_RUN_ID=<runId> \
 *                       relayflows run workflows/sandbox-program-drive.ts
 *
 * GATES THIS FLOW DOES NOT OWN
 *   It never merges and never pushes — Khaliq owns every merge gate. It
 *   commits only inside this repo (the flow, its gate scripts, its evidence),
 *   on a dedicated branch, and only on green.
 */

import path from 'node:path';
import {
  workflow,
  WorkflowRunner,
  JsonFileWorkflowDb,
  createDefaultEventLogger,
  formatDryRunReport,
  ClaudeModels,
  CodexModels,
  type RelayYamlConfig,
} from '@relayflows/core';

// ── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = process.cwd();
const GATES = path.join('workflows', 'sandbox-program', 'gates');
const ARTIFACTS = '.workflow-artifacts/sandbox-program';
const BRANCH = 'flow/sandbox-program-drive-0824';

/** Slack channel for HUMAN_QUESTION escalation. Resolved by the Relayfile
 *  Slack channel index at runtime — a name, never a bot token in the file. */
const SLACK_CHANNEL = process.env.SANDBOX_PROGRAM_SLACK_CHANNEL ?? 'proj-cloud';

const AW_ROOT = process.env.AW_ROOT ?? path.join(process.env.HOME ?? '~', 'Projects', 'AgentWorkforce');

/** The lanes this flow drives. It models them as stages and does not duplicate
 *  their work — each lane owns its clone; this flow owns the gate. */
const LANES = {
  stage1: { repo: `${AW_ROOT}/cloud-provisioning-0824`, branch: 'fix/snapshot-gh-cli', owner: 'sbx-provisioning-0824' },
  stage2: { repo: `${AW_ROOT}/sandbox-sec30-0824`, branch: 'fix/sandbox-30-initial-sync-script-mode-0824', owner: 'sbx-sec30-0824' },
  stage3: { repo: `${AW_ROOT}/sandbox-router-longrun-0824`, branch: 'main', owner: 'sbx-longrun-0824' },
  stage4: { repo: `${AW_ROOT}/sandbox-router`, branch: 'agent/process-manifest-0820', owner: 'sandbox-router lane' },
} as const;

const gate = (name: string) => `bash ${GATES}/${name}.sh`;

/** Boilerplate every repair owner gets. Keeps the escape hatch identical and
 *  keeps repair owners from wandering outside their lane. */
const REPAIR_RULES = `
Rules for every repair owner in this flow:
- Repair, do not report. A red check is your work item. Fix the source, test,
  config, or missing artifact, then rerun the SAME gate command locally until
  it is green or you hit a genuinely external blocker.
- Score by exit code. Never conclude "it passed" from the absence of an error
  string, and never read $? through a pipe.
- Stay in your lane's clone. Do not edit another stage's repository.
- Never merge and never push. Khaliq owns every merge gate.
- sandbox, sandbox-router and relayflows are PUBLIC repos: no customer names,
  no credentials, no exploit paths in any file, commit, issue or comment.
- If you are blocked on something only a human can decide — a missing
  credential, a product intent call, an unsafe action — print EXACTLY one line:
  HUMAN_QUESTION: <your concise question>
  then wait for the injected HUMAN_ANSWER and continue from it. Do not stall
  silently and do not invent an answer.
- If the blocker is external and no answer unblocks it, append the exact
  evidence to ${ARTIFACTS}/BLOCKED_NO_COMMIT.md and exit cleanly.
`.trim();

// ── Workflow ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wf = workflow('sandbox-program-drive')
    .description(
      'Drives the sandbox program end to end — provisioning mount/gh/roster, sandbox#30 script mode, ' +
        'the long-running provider reconciliation, and capability routing consumed by cloud — with a ' +
        'repair owner behind every gate. Runs locally; the flow is the driver and the sandbox is the subject.',
    )
    .pattern('dag')
    .channel('wf-sandbox-program')
    .maxConcurrency(4)
    .timeout(21_600_000) // 6h — this program hits red gates constantly
    .repairable({ maxRetries: 2, retryDelayMs: 10_000 });

  // ── Agents ─────────────────────────────────────────────────────────────────
  // One repair owner per stage, each scoped to one clone: one writer per repo
  // by placement, which is what keeps two lanes from corrupting a tree.

  wf.agent('program-lead', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    role: 'Sandbox program lead on #wf-sandbox-program. Coordinates the four repair owners, escalates to Khaliq, blocks nothing.',
    retries: 1,
  });
  wf.agent('fix-provisioning', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Stage 1 repair owner — sandbox provisioning: Relayfile mount, gh, roster, live mounted tree.',
    retries: 2,
  });
  wf.agent('fix-sec30', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    role: 'Stage 2 repair owner — sandbox#30 initial-sync script mode and credential containment.',
    retries: 2,
  });
  wf.agent('fix-longrun', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    role: 'Stage 3 repair owner — the long-running provider reconciliation document.',
    retries: 2,
  });
  wf.agent('fix-routing', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    role: 'Stage 4 repair owner — capability routing in sandbox-router and its call site in cloud.',
    retries: 2,
  });
  wf.agent('reconcile-repair', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    role: 'Reconcile repair owner — finishes missing lane artifacts and evidence before the stage gates run.',
    retries: 2,
  });
  wf.agent('claude-reviewer', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    preset: 'reviewer',
    role: 'Fresh-eyes reviewer. Reads the actual files, gate evidence, and diff from scratch.',
    retries: 1,
  });
  wf.agent('claude-fixer', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    role: 'Review-finding fixer. Repairs valid findings, adds proofs, reruns gates.',
    retries: 2,
  });

  // ── Phase 0: preflight ─────────────────────────────────────────────────────
  //
  // Resumable by construction: a re-run or a --start-from re-executes this, so
  // it tolerates the partial state a previous run left behind. It never uses
  // `git diff --quiet` as the clean-tree check — that fails on exactly the
  // files this flow is expected to rewrite. It is failOnError:false with a
  // repair owner, per the rule that even cheap preconditions write a blocked
  // artifact rather than crashing the run.

  wf.step('preflight', {
    type: 'deterministic',
    captureOutput: true,
    failOnError: false,
    command: [
      'set -uo pipefail',
      `mkdir -p ${ARTIFACTS}`,
      'BLOCKED=0',
      'git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "PREFLIGHT_BLOCKED: not a git repo"; exit 1; }',
      'CURRENT=$(git rev-parse --abbrev-ref HEAD)',
      'echo "branch_on_entry: $CURRENT"',
      // Work on a dedicated branch. Never on main, never a worktree — a
      // scheduled cleanup removes worktrees four times a day and has destroyed
      // nine-plus lanes' directories mid-task.
      `if [ "$CURRENT" != "${BRANCH}" ]; then git checkout -B "${BRANCH}" >/dev/null 2>&1 || BLOCKED=1; fi`,
      'echo "branch_now: $(git rev-parse --abbrev-ref HEAD)"',
      // Allowed dirty: the paths this flow itself writes. Anything else is
      // unexpected drift and blocks, because the commit step adds only
      // declared paths and would otherwise commit someone else's work.
      `ALLOWED='^(package-lock\\\\.json|workflows/sandbox-program-drive\\\\.ts|workflows/sandbox-program/|\\\\.workflow-artifacts/|\\\\.claude/)'`,
      `DIRTY=$(git status --short | awk '{print $2}' | grep -vE "$ALLOWED" || true)`,
      'if [ -n "$DIRTY" ]; then echo "PREFLIGHT_BLOCKED: unexpected drift:"; echo "$DIRTY"; BLOCKED=1; fi',
      'gh auth status >/dev/null 2>&1 || { echo "PREFLIGHT_BLOCKED: gh not authenticated — CI gates cannot be read"; BLOCKED=1; }',
      'command -v jq >/dev/null 2>&1 || { echo "PREFLIGHT_BLOCKED: jq missing — CI gates cannot be parsed"; BLOCKED=1; }',
      `for d in "${LANES.stage1.repo}" "${LANES.stage2.repo}" "${LANES.stage3.repo}" "${LANES.stage4.repo}"; do`,
      '  if [ -d "$d/.git" ]; then echo "lane_clone_ok: $d"; else echo "PREFLIGHT_BLOCKED: lane clone missing: $d"; BLOCKED=1; fi',
      'done',
      'if [ "$BLOCKED" -ne 0 ]; then echo "PREFLIGHT_BLOCKED"; exit 1; fi',
      'echo PREFLIGHT_OK',
    ].join('\n'),
  });

  wf.step('repair-preflight', {
    agent: 'reconcile-repair',
    dependsOn: ['preflight'],
    task: `Preflight for the sandbox-program flow ran in ${REPO_ROOT}.

Output:
{{steps.preflight.output}}

If it printed PREFLIGHT_OK, do nothing and say PREFLIGHT_ALREADY_OK.

If it printed PREFLIGHT_BLOCKED, fix what you safely can:
- unexpected tracked drift in this repo: inspect it, and either leave it alone
  and record it, or move it out of the way ONLY if it is clearly this flow's
  own leftover from a previous run.
- a missing lane clone: record it; do not clone over another lane's seat.
- gh or jq missing/unauthenticated: this is external. Print exactly one
  HUMAN_QUESTION line asking Khaliq to resolve it.
Rerun: bash -c 'cd ${REPO_ROOT} && git status --short'
Write what you did to ${ARTIFACTS}/preflight-repair.md.

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
  });

  // ── Phase 1: acceptance contract ───────────────────────────────────────────

  wf.step('acceptance-contract', {
    type: 'deterministic',
    dependsOn: ['preflight'],
    captureOutput: true,
    failOnError: false,
    command: [
      `cat > ${ARTIFACTS}/ACCEPTANCE.md <<'EOF'`,
      'SANDBOX PROGRAM ACCEPTANCE CONTRACT',
      '',
      'Stage 1 — provisioning (the n=2 fault, highest value in the program)',
      '  A1  mount | grep -i relayfile is non-empty on a FRESH box',
      '  A2  gh --version exits 0 on a fresh box',
      '  A3  gh auth status exits 0 on a fresh box',
      '  A4  roster present on a fresh box',
      '  A5  the workspace is the live mounted tree, NOT a /tmp clone',
      '  A6  the live snapshot builder installs gh, mounts Relayfile, writes the roster',
      '  A7  CI green per workflow on the lane branch, read with gh run list --branch',
      '',
      'Stage 2 — sandbox#30 (credential exposure, outranks feature work)',
      '  B1  the detached initial-sync script is mode exactly 0600',
      '  B2  ... proven under a 022 umask, not inherited from a lucky umask',
      '  B3  the fixture token is absent from the generated content',
      '  B4  repo typecheck and full test suite green',
      '  B5  CI green per workflow on the lane branch',
      '',
      'Stage 3 — long-running provider reconciliation',
      '  C1  one document that supersedes sandbox-router#16 and #17',
      '  C2  four axes: indefinite run, idle cost, restart survival, our stack',
      '  C3  every claim labelled OBSERVED / DOCUMENTED / INFERRED',
      '  C4  an explicit DAYTONA_CAP_RULING on the disputed session cap',
      '  C5  a crossover point for idle-heavy sessions, not a single number',
      '  C6  a RECOMMENDATION, and an UNKNOWN list rather than inference',
      '  C7  public-repo hygiene: no raw tokens',
      '',
      'Stage 4 — capability routing (gated behind stage 1)',
      '  D1  sandbox-router typecheck and tests green',
      '  D2  selection is by capability, not by hardcoded provider',
      '  D3  cloud actually consumes it — a real call site, not a compiled module',
      '  D4  CI green per workflow on the lane branch',
      '',
      'PASS  = every gate exit code zero. Then, and only then, commit-if-green commits.',
      'BLOCKED = any gate still red after repair. Writes BLOCKED_NO_COMMIT.md with the',
      '          failing evidence and exits successfully. A handled blocked state is a',
      '          result; a crashed run is not.',
      'Never merge, never push. Khaliq owns every merge gate.',
      'EOF',
      `cat ${ARTIFACTS}/ACCEPTANCE.md`,
    ].join('\n'),
  });

  // ── Phase 2: lane reconcile — the critical path ────────────────────────────

  wf.step('lane-reconcile', {
    type: 'deterministic',
    dependsOn: ['repair-preflight'],
    captureOutput: true,
    failOnError: false,
    command: gate('lane-reconcile'),
  });

  // The lead runs in PARALLEL with the reconcile repair and is a dependency of
  // nothing. If its PTY drops, the gates still run.
  wf.step('program-lead-coordinate', {
    agent: 'program-lead',
    dependsOn: ['lane-reconcile'],
    task: `You are the sandbox program lead on #wf-sandbox-program.

Acceptance contract:
{{steps.acceptance-contract.output}}

Reconcile of the four live lanes:
{{steps.lane-reconcile.output}}

The four lanes are LIVE agents in their own clones and they own the work:
  stage 1  ${LANES.stage1.owner}  ${LANES.stage1.repo}  (${LANES.stage1.branch})
  stage 2  ${LANES.stage2.owner}  ${LANES.stage2.repo}  (${LANES.stage2.branch})
  stage 3  ${LANES.stage3.owner}  ${LANES.stage3.repo}  (${LANES.stage3.branch})
  stage 4  ${LANES.stage4.owner}  ${LANES.stage4.repo}  (${LANES.stage4.branch})

Your job is coordination, not implementation. Do not write code and do not
duplicate a lane's work.
1. Post the reconcile summary to the channel and name which stages are red.
2. Watch the repair owners (fix-provisioning, fix-sec30, fix-longrun,
   fix-routing) and flag drift from the acceptance contract early.
3. Order of value is fixed: provisioning first, then sandbox#30, then the
   reconciliation, then routing. An empty box beats a good router.
4. When a decision needs Khaliq, print exactly one HUMAN_QUESTION line.
Exit when the repair owners have converged or you have escalated.

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
    retries: 1,
  });

  wf.step('repair-lane-reconcile', {
    agent: 'reconcile-repair',
    dependsOn: ['lane-reconcile'],
    task: `Deterministic reconcile of the four sandbox-program lanes.

Contract:
{{steps.acceptance-contract.output}}

Reconcile output:
{{steps.lane-reconcile.output}}

Every line reading "exit=1" is a work item. The two that are most likely red
and are this step's responsibility to close before the stage gates run:

- RECON_STAGE1_PROBE — the fresh-box provisioning probe transcript is missing.
  Create ${ARTIFACTS}/stage1-freshbox-probe.txt. It must record each check with
  its own exit code on its own line, in exactly this form:
      mount_relayfile exit=<n>
      gh_version exit=<n>
      gh_auth_status exit=<n>
      roster_present exit=<n>
      workspace_is_mount exit=<n>
  These have to come from a real fresh box. Coordinate with
  ${LANES.stage1.owner}, which owns that fault — do NOT provision a box
  yourself and do NOT fabricate the transcript. If no fresh-box run is
  available yet, write the file with the checks recorded as exit=1 and a
  "PENDING: awaiting fresh-box run from ${LANES.stage1.owner}" note, so the
  gate stays honestly red instead of silently absent.

- RECON_STAGE3_DOC — the reconciliation document does not exist yet. That is
  ${LANES.stage3.owner}'s deliverable, per
  chief/.briefs/sbx-longrun-reconcile-0824.md. Do not write the analysis
  yourself; record the gap.

Rerun the reconcile when you are done: ${gate('lane-reconcile')}
Write what you did to ${ARTIFACTS}/reconcile-repair.md.

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
  });

  wf.step('lane-reconcile-verify', {
    type: 'deterministic',
    dependsOn: ['repair-lane-reconcile'],
    captureOutput: true,
    failOnError: false,
    command: gate('lane-reconcile'),
  });

  // ── Phase 3: stage gates ───────────────────────────────────────────────────
  //
  // Stages 1–3 fan out from the same dependency and run in parallel; they
  // touch three different clones so there is no write-write conflict. Stage 4
  // waits on stage 1 — an empty box beats a good router.

  const stageGate = (
    key: string,
    agent: string,
    after: string[],
    lane: { repo: string; branch: string; owner: string },
    focus: string,
  ) => {
    wf.step(`run-${key}`, {
      type: 'deterministic',
      dependsOn: after,
      captureOutput: true,
      failOnError: false,
      command: gate(key),
    });
    wf.step(`fix-${key}`, {
      agent,
      dependsOn: [`run-${key}`],
      task: `${focus}

Your clone: ${lane.repo} (branch ${lane.branch})
Lane that owns this work: ${lane.owner}

Gate output — every "exit=1" line is a work item:
{{steps.run-${key}.output}}

Full evidence: ${ARTIFACTS}/${key}-evidence.txt
Full command log: ${ARTIFACTS}/${key}.log

If the gate is already green, say NOTHING_TO_REPAIR and stop.

Otherwise: fix each red check at its root, then rerun the SAME gate command
from ${REPO_ROOT}:
    ${gate(key)}
Keep iterating until the gate is green or a blocker is genuinely external.
Record what you changed and the commands you ran in ${ARTIFACTS}/${key}-repair.md.

${REPAIR_RULES}`,
      verification: { type: 'exit_code' },
    });
    wf.step(`verify-${key}`, {
      type: 'deterministic',
      dependsOn: [`fix-${key}`],
      captureOutput: true,
      failOnError: false,
      command: gate(key),
    });
  };

  stageGate(
    'stage1-provisioning',
    'fix-provisioning',
    ['lane-reconcile-verify'],
    LANES.stage1,
    `Stage 1 — sandbox provisioning. This is the top item in the program: a box that
arrives without the mount, the credential, and the roster makes everything
downstream worthless, and two live lanes are producing nothing right now
because of it.

The fault, with n=2: the sandbox has no Relayfile mount, no gh, and no roster,
so the lane falls back to an HTTPS clone into /tmp — which drops uncommitted
work. cloud keeps two image definitions and gh was only in the one that never
ships: deploy/daytona/Dockerfile is local Docker/smoke tooling, while
scripts/create-snapshot.ts builds the LIVE snapshot pinned in
infra/sandbox-snapshot.ts. The install has to be mirrored in create-snapshot.ts,
and the same applies to the Relayfile mount and the roster.

Do not stop at "the test asserts the string is in the file". The acceptance is
what a fresh box actually has.`,
  );

  stageGate(
    'stage2-sandbox30',
    'fix-sec30',
    ['lane-reconcile-verify'],
    LANES.stage2,
    `Stage 2 — sandbox#30. The generated initial-sync script is world-readable and
embeds mount credentials: a live credential exposure on every sandbox that runs
it, open since 2026-08-23.

Acceptance: mode exactly 0600, proven under a 022 umask (0600 that came from a
lucky umask is not a fix), the fixture token absent from the generated content,
and CI green per workflow.

This is adjacent to but NOT the same as relay#1570 (secrets in argv), which
Khaliq has deliberately sequenced behind the mount fixes. Do not merge the two
or you inherit that hold. Rotation, if any is needed, is Khaliq's call — a
credential is only contained once it has been presented and refused.`,
  );

  stageGate(
    'stage3-longrun-reconcile',
    'fix-longrun',
    ['lane-reconcile-verify'],
    LANES.stage3,
    `Stage 3 — the long-running provider reconciliation.
Brief: ~/Projects/AgentWorkforce/chief/.briefs/sbx-longrun-reconcile-0824.md

The deliverable is ONE document that supersedes sandbox-router#16 and #17, plus
a recommendation. sandbox-router#16 and #17 are held open ON PURPOSE as inputs;
they contradict each other. Do not merge either.

The house rule applies with full force: any performance or cost figure cites a
measurement or is labelled a design target. No round number stands unqualified
— we falsified a sub-200ms claim this month that was someone halving a
round-trip. An honest UNKNOWN is worth more than a confident guess.

Already measured, do not re-derive: the two authenticated Agent37 runs of
2026-08-23, and that cross-node attach to a Daytona sandbox works with no ssh
(it needs a real PTY via pty.fork(); script fails on non-tty stdin).
repo_mount_read_ms is UNKNOWN because of the stage 1 provisioning fault, not
because of an Agent37 property — do not score Agent37 down for it.

If the document does not exist, that is ${LANES.stage3.owner}'s deliverable.
Coordinate; do not write someone else's analysis, and never fabricate a
measurement to turn a gate green.`,
  );

  stageGate(
    'stage4-capability-routing',
    'fix-routing',
    ['verify-stage1-provisioning'],
    LANES.stage4,
    `Stage 4 — capability routing in sandbox-router, consumed by cloud. This is the
architectural centre: cloud is Daytona-bound today and must not be. Daytona
becomes one provider among several, and the router picks by CAPABILITY rather
than by hardcoded provider.

It depends on stage 1 deliberately. An empty box beats a good router.

The half that is easy to fake is "consumed by cloud". A router that compiles
and is imported nowhere has not shipped: the gate asserts a real call site in
cloud, not just a module in sandbox-router. Merged is not released is not
deployed — a green deploy shipped nothing as recently as cloud#3155 because the
classifier routed core changes to the web-only fast path.`,
  );

  // ── Phase 4: program acceptance ────────────────────────────────────────────

  wf.step('program-acceptance', {
    type: 'deterministic',
    dependsOn: [
      'verify-stage1-provisioning',
      'verify-stage2-sandbox30',
      'verify-stage3-longrun-reconcile',
      'verify-stage4-capability-routing',
    ],
    captureOutput: true,
    failOnError: false,
    command: gate('program-acceptance'),
  });

  wf.step('repair-program-acceptance', {
    agent: 'program-lead',
    dependsOn: ['program-acceptance'],
    task: `Full program acceptance across all four stages.

Contract:
{{steps.acceptance-contract.output}}

Acceptance output:
{{steps.program-acceptance.output}}

If every ACCEPT_* line is exit=0, record the green evidence in
${ARTIFACTS}/program-acceptance-signoff.md and stop.

Otherwise, assign each remaining red stage to its repair owner on
#wf-sandbox-program, in program order (provisioning, sandbox#30,
reconciliation, routing), and drive it until it is green or genuinely blocked.
Rerun: ${gate('program-acceptance')}

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
  });

  wf.step('program-acceptance-final', {
    type: 'deterministic',
    dependsOn: ['repair-program-acceptance'],
    captureOutput: true,
    failOnError: false,
    command: gate('program-acceptance'),
  });

  // ── Phase 5: fresh-eyes review (standard depth) ────────────────────────────
  //
  // Standard depth: review-claude → fix → final-review-claude → final-fix, with
  // the final review pass gated on the final fix. Codex is already carrying two
  // of the four repair owners, so the independent reviewer is Claude.

  wf.step('claude-review', {
    agent: 'claude-reviewer',
    dependsOn: ['program-acceptance-final'],
    task: `Fresh-eyes review of the sandbox-program drive flow and the state it has
produced. Read the actual files — do not rely on any summary.

Contract:
{{steps.acceptance-contract.output}}

Final acceptance evidence:
{{steps.program-acceptance-final.output}}

Review, from scratch:
1. ${REPO_ROOT}/workflows/sandbox-program-drive.ts and
   ${REPO_ROOT}/workflows/sandbox-program/gates/*.sh — do the gates actually
   prove what the contract claims? Specifically:
   - is anything scored by absence of an error rather than by exit code?
   - is any exit code read through a pipe?
   - is CI read with gh run list --branch (never --commit), and is an empty
     result treated as a FAIL rather than a pass?
   - can any gate go green while the real-world effect is absent?
2. The four lane clones' diffs, for changes made by this flow's repair owners.
3. Whether any repair owner wrote outside its lane, pushed, or merged.
4. Whether anything in a PUBLIC repo (sandbox, sandbox-router, relayflows)
   leaks a customer name, a credential, or an exploit path.

Write ${ARTIFACTS}/claude-review.md using this schema per finding:
  finding_id / severity (blocker|high|medium|low) / file / issue /
  fix_required / test_required / status / evidence
If there are no actionable issues, write NO_ISSUES_FOUND.`,
    verification: { type: 'exit_code' },
  });

  wf.step('claude-fix', {
    agent: 'claude-fixer',
    dependsOn: ['claude-review'],
    task: `Read ${ARTIFACTS}/claude-review.md.

Fix every valid finding and add or update the proof each one needs — a gate
assertion, a test, or a recorded command with its exit code. After each fix,
rerun the affected gate and re-read the changed file. Keep iterating until this
round has no remaining valid issues.

Write ${ARTIFACTS}/claude-fix.md with what changed and the commands run.
If the review says NO_ISSUES_FOUND, record that no fix was needed.

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
  });

  wf.step('claude-review-final', {
    agent: 'claude-reviewer',
    dependsOn: ['claude-fix'],
    task: `Review the post-fix state from scratch. Do NOT rely on the earlier review or
on the fixer's summary — read the files and rerun what you need to.

Write ${ARTIFACTS}/claude-review-final.md with findings, or NO_ISSUES_FOUND
only if there are no actionable issues left.`,
    verification: { type: 'exit_code' },
  });

  wf.step('claude-fix-final', {
    agent: 'claude-fixer',
    dependsOn: ['claude-review-final'],
    task: `If ${ARTIFACTS}/claude-review-final.md contains findings, fix them, add or
update the proofs, and rerun the affected gates until green.

If something cannot be fixed inside this flow, append the exact evidence to
${ARTIFACTS}/BLOCKED_NO_COMMIT.md — file, check name, exit code, and why it is
external — and do not commit.

If it says NO_ISSUES_FOUND, write ${ARTIFACTS}/claude-signoff.md.

${REPAIR_RULES}`,
    verification: { type: 'exit_code' },
  });

  wf.step('final-review-pass-gate', {
    type: 'deterministic',
    dependsOn: ['claude-fix-final'],
    captureOutput: true,
    failOnError: false,
    command: [
      'set -uo pipefail',
      `test -f ${ARTIFACTS}/claude-review-final.md || { echo "REVIEW_GATE_RED: no final review artifact"; exit 1; }`,
      `if grep -q "NO_ISSUES_FOUND" ${ARTIFACTS}/claude-review-final.md; then echo REVIEW_GATE_OK; exit 0; fi`,
      `test -f ${ARTIFACTS}/claude-signoff.md && { echo REVIEW_GATE_OK; exit 0; }`,
      `test -f ${ARTIFACTS}/BLOCKED_NO_COMMIT.md && { echo "REVIEW_GATE_BLOCKED: findings remain, blocked artifact present"; exit 1; }`,
      'echo "REVIEW_GATE_RED: final review has findings and neither signoff nor blocked artifact exists"',
      'exit 1',
    ].join('\n'),
  });

  // ── Phase 6: commit if green, blocked artifact otherwise ───────────────────
  //
  // The only step that writes history. It reruns the full acceptance command
  // and records each exit code; a commit happens only when every one is zero.
  // Anything still red becomes BLOCKED_NO_COMMIT with the failing evidence and
  // the step exits SUCCESSFULLY — the run reports a handled blocked state
  // rather than crashing. It commits only in this repo, only declared paths,
  // and it never pushes and never merges.

  wf.step('commit-if-green', {
    type: 'deterministic',
    dependsOn: ['final-review-pass-gate'],
    captureOutput: true,
    failOnError: false,
    command: [
      'set -uo pipefail',
      `mkdir -p ${ARTIFACTS}`,
      'ACCEPT_RC=0',
      `bash ${GATES}/program-acceptance.sh > ${ARTIFACTS}/commit-acceptance.txt 2>&1 || ACCEPT_RC=$?`,
      'REVIEW_RC=0',
      `bash -c 'test -f ${ARTIFACTS}/claude-review-final.md && ( grep -q NO_ISSUES_FOUND ${ARTIFACTS}/claude-review-final.md || test -f ${ARTIFACTS}/claude-signoff.md )' || REVIEW_RC=$?`,
      'echo "acceptance exit=$ACCEPT_RC"',
      'echo "review exit=$REVIEW_RC"',
      `cat ${ARTIFACTS}/commit-acceptance.txt`,
      'if [ "$ACCEPT_RC" -eq 0 ] && [ "$REVIEW_RC" -eq 0 ]; then',
      `  rm -f ${ARTIFACTS}/BLOCKED_NO_COMMIT.md`,
      `  git add workflows/sandbox-program-drive.ts workflows/sandbox-program ${ARTIFACTS} 2>/dev/null || true`,
      '  if git diff --cached --quiet; then echo "COMMIT_SKIPPED: nothing staged"; exit 0; fi',
      '  MSG=$(mktemp)',
      `  printf '%s\\n' 'feat(workflows): drive the sandbox program end to end' '' 'All four stage gates green: provisioning mount/gh/roster, sandbox#30 script' 'mode 0600 under a 022 umask, the long-running provider reconciliation, and' 'capability routing consumed by cloud. Evidence under ${ARTIFACTS}/.' '' 'Not pushed and not merged — Khaliq owns every merge gate.' > "$MSG"`,
      '  git commit -F "$MSG" >/dev/null 2>&1 && echo "COMMIT_OK: $(git log -1 --pretty=%h\\ %s)" || echo "COMMIT_FAILED"',
      '  rm -f "$MSG"',
      '  exit 0',
      'fi',
      // Still red — record it and exit 0. A handled blocked state is a result.
      `{`,
      `  echo "# BLOCKED_NO_COMMIT"`,
      `  echo ""`,
      `  echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
      `  echo "acceptance exit=$ACCEPT_RC"`,
      `  echo "review exit=$REVIEW_RC"`,
      `  echo ""`,
      `  echo "## Failing evidence"`,
      `  echo ""`,
      `  echo '\`\`\`'`,
      `  cat ${ARTIFACTS}/commit-acceptance.txt`,
      `  echo '\`\`\`'`,
      `  echo ""`,
      `  echo "No commit was created. Resume with:"`,
      `  echo "  RESUME_RUN_ID=<runId> relayflows run workflows/sandbox-program-drive.ts"`,
      `} > ${ARTIFACTS}/BLOCKED_NO_COMMIT.md`,
      `echo "BLOCKED_NO_COMMIT written to ${ARTIFACTS}/BLOCKED_NO_COMMIT.md"`,
      'exit 0',
    ].join('\n'),
  });

  // Final signoff: exactly one of the two terminal states must exist. This is
  // the one hard-fail in the flow, and commit-if-green cannot leave it unmet.
  wf.step('verify-terminal-state', {
    type: 'deterministic',
    dependsOn: ['commit-if-green'],
    captureOutput: true,
    failOnError: true,
    command: [
      'set -uo pipefail',
      `if [ -f ${ARTIFACTS}/BLOCKED_NO_COMMIT.md ]; then`,
      `  echo "TERMINAL_STATE: BLOCKED_NO_COMMIT"; head -20 ${ARTIFACTS}/BLOCKED_NO_COMMIT.md; exit 0`,
      'fi',
      'if git log -1 --pretty=%s | grep -q "^feat(workflows): drive the sandbox program"; then',
      '  echo "TERMINAL_STATE: COMMITTED $(git log -1 --pretty=%h)"; exit 0',
      'fi',
      'echo "TERMINAL_STATE: GREEN_NO_COMMIT (acceptance green, nothing new to stage)"',
      'exit 0',
    ].join('\n'),
  });

  // ── Config: Relayfile integration + Slack human assistance ─────────────────
  //
  // The builder does not surface these two, so they are set on the built
  // config — the pattern examples/typescript/slack-human-assistance-e2e.ts
  // uses. `relayfile: {}` means "use the existing local Relayfile connection":
  // no workspaceId, no Relayfile token, no Slack bot token in this file.

  const config: RelayYamlConfig = wf.toConfig();
  config.integrations = { relayfile: {} };

  // The reviewer runs one-shot (preset: 'reviewer'), and human assistance is
  // wired only into the interactive PTY path. Leaving Slack assistance on for
  // its steps would give a reviewer a gate it could answer itself — an
  // approval gate that fails open is worse than no gate — so it is switched
  // off explicitly for exactly those two steps. `.step()` does not carry this
  // field, so it is set on the built config.
  for (const step of config.workflows[0].steps) {
    if (step.name === 'claude-review' || step.name === 'claude-review-final') {
      step.humanAssistance = false;
    }
  }

  config.swarm.humanAssistance = {
    slack: {
      channel: SLACK_CHANNEL,
      timeoutMs: 3_600_000,
    },
  };

  // ── Execute ────────────────────────────────────────────────────────────────

  const runner = new WorkflowRunner({
    cwd: REPO_ROOT,
    db: new JsonFileWorkflowDb({ filePath: path.join(REPO_ROOT, '.agent-relay', 'workflow-runs.jsonl') }),
  });

  if (process.env.DRY_RUN) {
    console.log(formatDryRunReport(runner.dryRun(config)));
    return;
  }

  runner.on(createDefaultEventLogger('normal'));

  const resumeRunId = process.env.RESUME_RUN_ID;
  const startFrom = process.env.START_FROM;
  const previousRunId = process.env.PREVIOUS_RUN_ID;

  const result = resumeRunId
    ? await runner.resume(resumeRunId, undefined, config)
    : await runner.execute(config, undefined, undefined, startFrom ? { startFrom, previousRunId } : undefined);

  console.log(`\nsandbox-program-drive: ${result.status} (run ${result.id})`);
  console.log(`Resume with: RESUME_RUN_ID=${result.id} relayflows run workflows/sandbox-program-drive.ts`);

  // A blocked state is a handled result, not a crash: do not exit non-zero for
  // it. Only a genuine runtime failure of the flow itself is an error.
  if (result.status === 'failed') {
    throw new Error(`workflow run failed: ${result.error ?? 'unknown error'}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
