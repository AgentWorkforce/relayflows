# Question — repair-program-acceptance

Date: 2026-08-25
Asked by: repair-program-acceptance (program acceptance owner)
Asked of: chief (DM queued; chief is OFFLINE — `list_agents` returns 0 online agents)

## Evidence that prompted the questions

```text
ACCEPT_STAGE1_PROVISIONING exit=1
S1_ROSTER_IN_SNAPSHOT exit=1  # pattern: roster|ROSTER
S1_PROBE_MOUNT exit=1  # pattern: mount_relayfile exit=0
S1_PROBE_GH_VERSION exit=1  # pattern: gh_version exit=0
S1_PROBE_GH_AUTH exit=1  # pattern: gh_auth_status exit=0
S1_PROBE_ROSTER exit=1  # pattern: roster_present exit=0
S1_PROBE_WORKSPACE_IS_MOUNT exit=1  # pattern: workspace_is_mount exit=0
S1_CI exit=1  # NOT-RUN workflows on AgentWorkforce/cloud@fix/snapshot-gh-cli: Preview
```

## Q1 — Preview skipped on the lane branch

Verbatim: "`ci_check` records a skipped workflow as red with the note `an owner
must rule whether the skip is correct for this change`, but the gate exposes no
channel for that ruling. `fix/snapshot-gh-cli` is a scripts/tests-only change,
so a path-filtered `Preview` deploy skipping is the correct behaviour. Do you
want the ruling expressed as a checked-in ruling artifact the gate reads, or
does S1_CI stay red until Preview is forced to run on this branch?"

## Q2 — fresh-box probe

Verbatim: "S1_PROBE_* needs a transcript from a real freshly provisioned
sandbox. Provisioning one costs Daytona spend and needs live credentials, and
the box under test is the same broken subject the stage is fixing. Who is
authorised to burn a fresh box for this probe, and is that spend pre-approved?"

## Status

Chief unreachable — `list_agents` reports 2411 registered agents and ZERO
online. DM queued anyway: message id `217836465907306496`, delivery
`queued_unconfirmed`. Asked once; not repeated.

### Q1 — investigated and RULED by the program owner

The premise in the question was wrong and the real answer is stronger. The
`Preview` skip is not a path filter declining a scripts-only change:
`scripts/**` IS in `preview.yml`'s `paths:` list and the branch touches
`scripts/create-snapshot.ts`, so the branch matches. Preview skips because
`deploy-preview` is gated repo-wide to `workflow_dispatch`:

```yaml
  deploy-preview:
    # TEMPORARY (2026-05-14): preview deploys are workflow_dispatch-only during
    # the cloud-web migration push. The `preview` label path is disabled.
```

It would skip identically on every branch in the repo. RULING: the skip is
correct for this change. The residual half of Q1 still stands for chief —
whether `ci_check` should grow a ruling channel — and the gate was NOT modified
to create one, because that would weaken a gate to erase a red.

### Q2 — no local answer, escalated

Needs a Daytona credential and spend approval, both Khaliq-owned. Recorded in
BLOCKED_NO_COMMIT.md and raised as HUMAN_QUESTION.

---

# Q3 — S1_ROSTER_IN_SNAPSHOT (asked 2026-08-25, second run of this step)

## Evidence that prompted it

```text
S1_ROSTER_IN_SNAPSHOT exit=1  # pattern: roster|ROSTER
$ grep -c 'roster' cloud-provisioning-0824/scripts/create-snapshot.ts
0
$ git -C cloud-provisioning-0824 grep -nE 'roster' -- deploy
# exit 1, zero matches
$ git -C cloud-provisioning-0824 grep -ilE 'roster' -- .
packages/web/app/api/v1/fleet/agents/route.ts
packages/web/app/api/v1/fleet/nodes/route.ts
dev-stack/fleet-node-bootstrap/fleet-node-liveness.mjs
...
```

## Question, verbatim

"Contract A6 requires the live snapshot builder to install gh, mount Relayfile,
AND write the roster. The first two are mirrored into
`scripts/create-snapshot.ts`; the third has no referent. Every roster in this
codebase is a fleet-API runtime object read from `agent-relay fleet nodes --all`
or served from `packages/web/app/api/v1/fleet/*` — nothing writes a roster file
into a snapshot image, and `deploy/daytona` has no roster path at all. The box
already reaches the roster at runtime through the baked
`relay-sandbox-entrypoint` Path B enrollment.

So: is A6's 'writes the roster' (a) a real missing build item, in which case
where does a roster live on a box and in what format, or (b) already satisfied
by entrypoint enrollment, in which case A6 is measuring the wrong artifact?

I did NOT resolve this myself. The only edit that would flip this grep without a
ruling is adding the token 'roster' to a comment in create-snapshot.ts, which is
manufacturing a green — the exact failure family you ruled on in
program-lead-coordinate.ANSWER.md."

## Status

DM sent to chief once. `chief` is NOT in the online roster (51 agents online;
`chief-watchdog` is, `chief` is not). Not repeated. This item is moot for the
stage colour either way: S1_PROBE_* keeps stage 1 red until a real fresh box
exists.
