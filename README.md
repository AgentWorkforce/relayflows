<img src="./repo-banner.png" alt="relayflows">
<a href="https://www.npmjs.com/package/@relayflows/core"><img alt="npm" src="https://img.shields.io/npm/v/@relayflows/core"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
<br/><br/>

Workflow engine and CLI for Agent Relay. Orchestrate multi-agent workflows using YAML, TypeScript, or Python. Define agents, wire up dependencies, and let the runner handle execution, retries, and verification.

## Quick Start

### CLI

```bash
# Run a YAML workflow
relayflows run workflow.yaml

# Run a TypeScript workflow
relayflows run workflow.ts

# Run a Python workflow
relayflows run workflow.py

# Run a specific named workflow from a file
relayflows run workflow.yaml --workflow deploy
```

### TypeScript

```typescript
import { workflow } from "@relayflows/core";

const result = await workflow("ship-feature")
  .pattern("dag")
  .agent("planner", { cli: "claude", role: "Plans implementation" })
  .agent("developer", { cli: "codex", role: "Writes code" })
  .agent("reviewer", { cli: "claude", role: "Reviews code" })
  .step("plan", {
    agent: "planner",
    task: "Create implementation plan for user authentication",
  })
  .step("implement", {
    agent: "developer",
    task: "Implement the plan",
    dependsOn: ["plan"],
  })
  .step("review", {
    agent: "reviewer",
    task: "Review the implementation",
    dependsOn: ["implement"],
  })
  .run();

console.log(result.status); // "completed" | "failed" | "cancelled" | "needs_human"
```

### Python

```python
from agent_relay import workflow

result = (
    workflow("ship-feature")
    .pattern("dag")
    .agent("planner", cli="claude", role="Plans implementation")
    .agent("developer", cli="codex", role="Writes code")
    .agent("reviewer", cli="claude", role="Reviews code")
    .step("plan", agent="planner", task="Create implementation plan for user auth")
    .step("implement", agent="developer", task="Implement the plan", depends_on=["plan"])
    .step("review", agent="reviewer", task="Review the implementation", depends_on=["implement"])
    .run()
)
```

## Consumer-Facing Apps + AI SDK Communicate Flows

A good production split is:

1. **AI SDK app** handles the user conversation and streaming UI
2. **Communicate / `onRelay()`** lets that point-person coordinate with specialists over Relay
3. **Workflows / `runWorkflow()`** take over when a request needs multi-step execution, verification, or handoffs

```typescript
import { streamText, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Relay } from '@agent-relay/sdk/communicate';
import { onRelay } from '@agent-relay/sdk/communicate/adapters/ai-sdk';
import { runWorkflow } from '@relayflows/core';

export async function POST(req: Request) {
  const { prompt, escalate, repo } = await req.json();

  const relay = new Relay('AppLead');
  const relaySession = onRelay({
    name: 'AppLead',
    instructions: 'You are the customer-facing lead. Keep the user updated and delegate implementation via Relay when needed.',
  }, relay);

  const model = wrapLanguageModel({
    model: openai('gpt-4o-mini'),
    middleware: relaySession.middleware,
  });

  if (escalate) {
    const workflow = await runWorkflow('workflows/feature-dev.yaml', {
      vars: { task: prompt, repo },
    });

    return Response.json({ status: workflow.status, runId: workflow.runId });
  }

  return streamText({
    model,
    tools: relaySession.tools,
    system: 'Answer directly when possible; coordinate internally when the task needs specialists.',
    prompt,
  }).toUIMessageStreamResponse({
    onFinish() {
      relaySession.cleanup();
      void relay.close();
    },
  });
}
```

That pattern keeps the user experience snappy while still letting longer Relay workflows run with proper ownership, retries, and verification.

## YAML Format

Workflows are defined as `relay.yaml` files:

```yaml
version: "1.0"
name: my-workflow
description: "Optional description"

swarm:
  pattern: dag            # Execution pattern (see Patterns below)
  maxConcurrency: 3       # Max agents running in parallel
  timeoutMs: 3600000      # Global timeout (1 hour)
  channel: my-channel     # Relay channel for agent communication

agents:
  - name: backend
    cli: claude            # claude | codex | gemini | aider | goose | opencode | droid
    role: "Backend engineer"
    constraints:
      model: opus
      timeoutMs: 600000
      retries: 2

  - name: tester
    cli: codex
    role: "Test engineer"
    interactive: false     # Non-interactive: runs as subprocess, no PTY/messaging

  # A persona replaces cli + role. Its harness, model, standing instructions,
  # installed skills, MCP servers, and harness settings come from the spec.
  # Persona agents are interactive-only: do not set cli, preset, or
  # constraints.model, and do not use interactive: false.
  - name: integrations
    persona: nango-integrations

workflows:
  - name: build-and-test
    onError: retry         # fail | skip | retry
    steps:
      - name: build-api
        agent: backend
        task: "Build the REST API endpoints for user management"
        verification:
          type: file_exists
          value: "src/api/users.ts"
        retries: 1

      - name: write-tests
        agent: tester
        task: "Write integration tests for: {{steps.build-api.output}}"
        dependsOn: [build-api]

      - name: run-tests
        agent: tester
        task: "Run the test suite and report results"
        dependsOn: [write-tests]
        verification:
          type: exit_code
          value: "0"

errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
  repairAgent: tester
  repairRetries: 2
  onExhaustion: needs-human
  notifyChannel: my-channel
```

### Template Variables

Use `{{variable}}` for user-provided values and `{{steps.STEP_NAME.output}}` for previous step outputs:

```yaml
steps:
  - name: plan
    agent: planner
    task: "Plan implementation for: {{task}}"     # User variable

  - name: implement
    agent: developer
    dependsOn: [plan]
    task: "Implement: {{steps.plan.output}}"      # Previous step output
```

User variables are passed via the CLI or programmatically:

```typescript
await runWorkflow("workflow.yaml", {
  vars: { task: "Add OAuth2 support" },
});
```

### Blocking Slack Questions

Workflows can pause on a Slack question by adding a Slack integration step with
`action: askQuestion`. The step posts a question, waits for the first human reply
in the message thread, exposes that answer through `{{steps.<name>.output}}`, and
can inject it into a running agent when `injectToAgent` is set.

```yaml
workflows:
  - name: default
    steps:
      - name: ask-human
        type: integration
        integration: slack
        action: askQuestion
        params:
          channel: "#engineering"
          text: "The implementer is blocked on migration strategy. Which path should it take?"
          waitTimeoutMs: "3600000"
          injectToAgent: "backend-runtime-name"
          injectTemplate: "HUMAN_ANSWER: {{answer.text}}"
          output: '{"format":"text","path":"answer.text"}'

      - name: continue-with-answer
        agent: backend
        dependsOn: [ask-human]
        task: "Continue using this human guidance: {{steps.ask-human.output}}"
```

`askQuestion` can use the local Slack API runtime, or Relayfile-backed Slack
writebacks when the workflow already has a Relayfile Slack integration.

Interactive agent steps can also opt into marker-driven assistance. With
`humanAssistance.slack` enabled, an agent can print a line beginning with
`HUMAN_QUESTION:`. The runner posts that question to Slack, blocks while waiting
for a human reply, then injects `HUMAN_ANSWER: ...` back into that same agent
session. If `integrations.relayfile` is present, Relayflows automatically uses
the existing Relayfile/Pear Slack connection; no Slack bot token, Relayfile
workspace id, or Relayfile token is required in the workflow.

Runnable TypeScript proof: `examples/typescript/slack-human-assistance-e2e.ts`.

```yaml
swarm:
  pattern: dag
  humanAssistance:
    slack:
      channel: proj-cloud
      timeoutMs: 3600000

integrations:
  relayfile: {}

workflows:
  - name: default
    steps:
      - name: implement
        agent: backend
        task: "Proceed, but ask for human guidance if the migration strategy is ambiguous."
```

### Relayfile Event Subscriptions

Relayflows can subscribe to Relayfile integration events and inject matching
events into active agents. Workflow-level subscriptions live under
`integrations.subscriptions`; agent-level subscriptions use Workforce-style
`agents[].watch` or Relayflows-style `agents[].subscriptions`.

```yaml
integrations:
  relayfile: {}
  subscriptions:
    - name: pr-feedback
      provider: github
      path: /github/repos/acme/web/pulls/42/**
      events: [created, updated]
      agents: [pr-babysitter]

agents:
  - name: pr-babysitter
    cli: codex
    watch:
      - paths: [/github/repos/acme/web/pulls/42/reviews/**]
        events: [created, updated]

workflows:
  - name: default
    steps:
      - name: babysit-pr
        agent: pr-babysitter
        task: |
          Stay active and wait for INTEGRATION_EVENT messages about PR feedback.
          Read the Relayfile path from the event, address comments until no open
          feedback remains, then notify the user in Slack.
```

### Verification Checks

Each step can include a verification check. Verification is one input to the runner's **completion decision pipeline** — when verification passes, the step completes even without a sentinel marker.

| Type | Description |
|------|-------------|
| `exit_code` | Agent must exit with the specified code (preferred for code-editing steps) |
| `file_exists` | A file must exist at the specified path after the step |
| `output_contains` | Step output must contain the specified string (optional accelerator) |
| `custom` | No-op in the runner; handled by external callers |

```yaml
# Preferred — deterministic verification
verification:
  type: exit_code
  value: "0"
  description: "Process exited successfully"

# Also valid — output_contains as an optional accelerator
verification:
  type: output_contains
  value: "IMPLEMENTATION_COMPLETE"
  description: "Agent confirms completion (optional fast-path)"
```

### Completion Decision Pipeline

The runner uses a multi-signal pipeline to decide step completion:

1. **Deterministic verification** — if a verification check passes, the step completes immediately (`completed_verified`)
2. **Owner decision** — the step owner can issue `OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL` (`completed_by_owner_decision`)
3. **Evidence-based completion** — channel messages, file artifacts, and exit codes are collected as evidence (`completed_by_evidence`)
4. **Marker fast-path** — `STEP_COMPLETE:<step-name>` still works as an accelerator but is never required

| Completion State | Meaning |
|---|---|
| `completed_verified` | Deterministic verification passed |
| `completed_by_owner_decision` | Owner approved the step |
| `completed_by_evidence` | Evidence-based completion |
| `retry_requested_by_owner` | Owner requested retry |
| `failed_verification` | Verification explicitly failed |
| `failed_owner_decision` | Owner rejected the step |
| `failed_no_evidence` | No verification, no owner decision, no evidence |

**Review parsing is tolerant:** The runner accepts semantically equivalent outputs like "Approved", "Complete", "LGTM" — not just exact `REVIEW_DECISION: APPROVE` strings.

## Swarm Patterns

The `swarm.pattern` field controls how agents are coordinated:

### Core Patterns

| Pattern | Description |
|---------|-------------|
| `dag` | Directed acyclic graph — steps run based on dependency edges (default) |
| `fan-out` | All agents run in parallel |
| `pipeline` | Sequential chaining of steps |
| `hub-spoke` | Central hub coordinates spoke agents |
| `consensus` | Agents vote on decisions |
| `mesh` | Full communication graph between agents |
| `handoff` | Sequential handoff between agents |
| `cascade` | Waterfall with phase gates |
| `debate` | Agents propose and counter-argue |
| `hierarchical` | Multi-level reporting structure |

### Data Processing Patterns

| Pattern | Description |
|---------|-------------|
| `map-reduce` | Split work into chunks (mappers), process in parallel, aggregate results (reducers) |
| `scatter-gather` | Fan out requests to workers, collect and synthesize responses |

### Supervision & Quality Patterns

| Pattern | Description |
|---------|-------------|
| `supervisor` | Monitor agent monitors workers, restarts on failure, manages health |
| `reflection` | Agent produces output, critic reviews and provides feedback for iteration |
| `verifier` | Producer agents submit work to verifier agents for validation |

### Adversarial & Validation Patterns

| Pattern | Description |
|---------|-------------|
| `red-team` | Attacker agents probe for weaknesses, defender agents respond |
| `auction` | Auctioneer broadcasts tasks, agents bid based on capability/cost |

### Resilience Patterns

| Pattern | Description |
|---------|-------------|
| `escalation` | Start with fast/cheap agents, escalate to more capable on failure |
| `saga` | Distributed transactions with compensating actions on failure |
| `circuit-breaker` | Primary agent with fallback chain, fail fast and recover |

### Collaborative Patterns

| Pattern | Description |
|---------|-------------|
| `blackboard` | Shared workspace where agents contribute incrementally to a solution |
| `swarm` | Emergent behavior from simple agent rules (neighbor communication) |

### Auto-Selection by Role

When `swarm.pattern` is omitted, the coordinator auto-selects based on agent roles. Patterns are checked in priority order below (first match wins):

| Priority | Pattern | Required Roles/Config |
|----------|---------|----------------------|
| 1 | `dag` | Steps with `dependsOn` |
| 2 | `consensus` | Uses `coordination.consensusStrategy` config |
| 3 | `map-reduce` | `mapper` + `reducer` |
| 4 | `red-team` | (`attacker` OR `red-team`) + (`defender` OR `blue-team`) |
| 5 | `reflection` | `critic` |
| 6 | `escalation` | `tier-1`, `tier-2`, etc. |
| 7 | `auction` | `auctioneer` |
| 8 | `saga` | `saga-orchestrator` OR `compensate-handler` |
| 9 | `circuit-breaker` | `fallback`, `backup`, OR `primary` |
| 10 | `blackboard` | `blackboard` OR `shared-workspace` |
| 11 | `swarm` | `hive-mind` OR `swarm-agent` |
| 12 | `verifier` | `verifier` |
| 13 | `supervisor` | `supervisor` |
| 14 | `hierarchical` | `lead` (with 4+ agents) |
| 15 | `hub-spoke` | `hub` OR `coordinator` |
| 16 | `pipeline` | Unique agents per step, 3+ steps |
| 17 | `fan-out` | Default fallback |

## Error Handling

### Step-Level

```yaml
steps:
  - name: risky-step
    agent: worker
    task: "Do something that might fail"
    retries: 3          # Retry up to 3 times on failure
    timeoutMs: 300000   # 5 minute timeout
```

### Workflow-Level

The `onError` field on a workflow controls what happens when a step fails:

| Value | Behavior |
|-------|----------|
| `fail` / `fail-fast` | Stop immediately, skip downstream steps |
| `skip` / `continue` | Skip downstream dependents, continue independent steps |
| `retry` | Retry the step; deterministic gates ask a workflow agent to repair before each retry when an agent is available |

### Global

```yaml
errorHandling:
  strategy: retry
  maxRetries: 2
  retryDelayMs: 5000
  repairAgent: tester
  repairRetries: 2
  notifyChannel: alerts
```

Retry-mode workflows are repair-aware by default. Deterministic step failures, verification gate failures, and malformed agent artifacts are treated as repairable work before terminal failure. The runner chooses `errorHandling.repairAgent` when set, otherwise it uses the step's owning/upstream agent when possible, then falls back to the best available workflow agent. The selected agent gets the failed command or agent output, working directory, exit information, and captured evidence, then the failed gate or step is retried. Use `repairRetries: 0`, `strategy: fail-fast`, or `strategy: continue` when a workflow intentionally should not invoke repair agents. Set `onExhaustion: needs-human` to end an exhausted repairable run as `needs_human` instead of `failed`.

## Built-in Templates

Six pre-built workflow templates are included:

| Template | Pattern | Description |
|----------|---------|-------------|
| `feature-dev` | hub-spoke | Plan, implement, review, and finalize a feature |
| `bug-fix` | hub-spoke | Investigate, patch, validate, and document a bug fix |
| `code-review` | fan-out | Parallel multi-reviewer assessment with consolidated findings |
| `security-audit` | pipeline | Scan, triage, remediate, and verify security issues |
| `refactor` | hierarchical | Analyze, plan, execute, and validate a refactor |
| `documentation` | handoff | Research, draft, review, and publish documentation |

### Using Templates

```typescript
import { TemplateRegistry, WorkflowRunner } from "@relayflows/core";

const registry = new TemplateRegistry();

// List available templates
const templates = await registry.listTemplates();

// Load and run a template
const config = await registry.loadTemplate("feature-dev");
const runner = new WorkflowRunner();
const result = await runner.execute(config, undefined, {
  task: "Add WebSocket support to the API",
});

// Install a custom template from a URL
await registry.installExternalTemplate(
  "https://example.com/my-template.yaml",
  "my-template"
);
```

## TypeScript Builder API

The builder constructs a `RelayYamlConfig` object and can run it, export it as YAML, or return the raw config.

```typescript
import { workflow } from "@relayflows/core";

// Build and run
const result = await workflow("my-workflow")
  .pattern("dag")
  .maxConcurrency(3)
  .timeout(60 * 60 * 1000)
  .channel("my-channel")
  .agent("backend", {
    cli: "claude",
    role: "Backend engineer",
    model: "opus",
    retries: 2,
  })
  .agent("frontend", {
    cli: "codex",
    role: "Frontend engineer",
    interactive: false,       // Non-interactive subprocess mode
  })
  .step("api", {
    agent: "backend",
    task: "Build REST API",
    verification: { type: "output_contains", value: "API_READY" },
  })
  .step("ui", {
    agent: "frontend",
    task: "Build the UI",
    dependsOn: ["api"],
  })
  .onError("retry", { maxRetries: 2, retryDelayMs: 5000 })
  .run();

// Or export to YAML
const yaml = workflow("my-workflow")
  .pattern("dag")
  .agent("worker", { cli: "claude" })
  .step("task1", { agent: "worker", task: "Do something" })
  .toYaml();

// Or get the raw config object
const config = workflow("my-workflow")
  .pattern("dag")
  .agent("worker", { cli: "claude" })
  .step("task1", { agent: "worker", task: "Do something" })
  .toConfig();
```

## Python Builder API

The Python builder ships with `@agent-relay/sdk-py`:

```bash
pip install agent-relay
```

```python
from agent_relay import workflow, run_yaml

# Build and run
result = (
    workflow("my-workflow")
    .pattern("dag")
    .max_concurrency(3)
    .timeout(3600000)
    .agent("backend", cli="claude", role="Backend engineer")
    .agent("frontend", cli="codex", role="Frontend engineer")
    .step("api", agent="backend", task="Build REST API")
    .step("ui", agent="frontend", task="Build the UI", depends_on=["api"])
    .on_error("retry", max_retries=2, retry_delay_ms=5000)
    .run()
)

# Run an existing YAML file
result = run_yaml("workflows/my-workflow.yaml")

# Export to YAML string
yaml_str = (
    workflow("my-workflow")
    .pattern("dag")
    .agent("worker", cli="claude")
    .step("task1", agent="worker", task="Do something")
    .to_yaml()
)

# Get the raw config dict
config = (
    workflow("my-workflow")
    .pattern("dag")
    .agent("worker", cli="claude")
    .step("task1", agent="worker", task="Do something")
    .to_config()
)
```

## Programmatic API

For full control, use the `WorkflowRunner` directly:

```typescript
import { WorkflowRunner } from "@relayflows/core";

const runner = new WorkflowRunner({
  cwd: "/path/to/project",       // Working directory (default: process.cwd())
  relay: { port: 3000 },         // AgentRelay options (optional)
});

// Listen to events (broker:event fires frequently — filter it out for cleaner output)
runner.on((event) => {
  if (event.type === 'broker:event') return;
  console.log(event.type, event);
});

// Parse and execute
const config = await runner.parseYamlFile("workflow.yaml");
const run = await runner.execute(config, "workflow-name", {
  task: "Build the feature",
});

// Pause / resume / abort
runner.pause();
runner.unpause();
runner.abort();

// Resume a failed run
const resumed = await runner.resume(run.id);
```

### Zero-Config Convenience Function

```typescript
import { runWorkflow } from "@relayflows/core";

const result = await runWorkflow("workflow.yaml", {
  workflow: "deploy",
  vars: { environment: "staging" },
  onEvent: (event) => {
    if (event.type !== 'broker:event') console.log(event.type);
  },
});
```

## Coordination

### Barriers

Synchronization points that wait for specific steps to complete:

```yaml
coordination:
  barriers:
    - name: all-reviews-done
      waitFor: [review-arch, review-security, review-correctness]
      timeoutMs: 900000
  consensusStrategy: majority    # majority | unanimous | quorum
```

### Shared State

Agents can share state during execution:

```yaml
state:
  backend: memory    # memory | redis | database
  ttlMs: 86400000
  namespace: my-workflow
```

## Supported Agent CLIs

| CLI | Description |
|-----|-------------|
| `claude` | Claude Code (Anthropic) |
| `codex` | Codex CLI (OpenAI) |
| `gemini` | Gemini CLI (Google) |
| `aider` | Aider coding assistant |
| `goose` | Goose AI assistant |
| `opencode` | OpenCode CLI |
| `droid` | Droid CLI |

## Non-Interactive Agents

By default, agents run in interactive PTY mode with full relay messaging. For workers that just need to execute a task and return output — common in fan-out, map-reduce, and pipeline patterns — set `interactive: false` to run them as lightweight subprocesses.

### YAML

```yaml
agents:
  - name: lead
    cli: claude
    role: "Coordinates work"
    # interactive: true (default) — full PTY, relay messaging, /exit detection

  - name: worker
    cli: codex
    role: "Executes tasks"
    interactive: false    # Runs "codex exec <task>", captures stdout
```

### TypeScript

```typescript
workflow("fan-out-analysis")
  .pattern("fan-out")
  .agent("lead", { cli: "claude", role: "Coordinator" })
  .agent("worker-1", { cli: "codex", interactive: false, role: "Analyst" })
  .agent("worker-2", { cli: "codex", interactive: false, role: "Analyst" })
  .step("analyze-1", { agent: "worker-1", task: "Analyze module A" })
  .step("analyze-2", { agent: "worker-2", task: "Analyze module B" })
  .step("synthesize", {
    agent: "lead",
    task: "Combine: {{steps.analyze-1.output}} + {{steps.analyze-2.output}}",
    dependsOn: ["analyze-1", "analyze-2"],
  })
  .run();
```

### How It Works

| Aspect | Interactive (default) | Non-Interactive |
|--------|----------------------|-----------------|
| Execution | Full PTY with stdin/stdout | `child_process.spawn()` with piped stdio |
| CLI invocation | Standard interactive session | One-shot mode (`claude -p`, `codex exec`, etc.) |
| Relay messaging | Can send/receive messages | No messaging — excluded from topology edges |
| Self-termination | Must output `/exit` | Process exits naturally when done |
| Output capture | PTY output buffer | stdout capture |
| Overhead | Higher (PTY, echo verification, SIGWINCH) | Lower (simple subprocess) |

### Non-Interactive CLI Commands

| CLI | Command | Notes |
|-----|---------|-------|
| `claude` | `claude -p "<task>"` | Print mode, exits after response |
| `codex` | `codex exec "<task>"` | One-shot execution |
| `gemini` | `gemini -p "<task>"` | Prompt mode |
| `opencode` | `opencode --prompt "<task>"` | One-shot prompt |
| `droid` | `droid exec "<task>"` | One-shot execution |
| `aider` | `aider --message "<task>" --yes-always --no-git` | Auto-approve, skip git |
| `goose` | `goose run --text "<task>" --no-session` | Text mode, no session file |

### When to Use

- Fan-out workers that process a task and return results
- Map-reduce mappers that don't need mid-task communication
- Pipeline stages that transform input to output
- Any agent that doesn't need turn-by-turn relay messaging

### When NOT to Use

- Lead/coordinator agents that communicate with others
- Agents in debate, consensus, or reflection patterns
- Agents that need to receive messages during execution

## Agent Slash Commands

Agents running inside a workflow can output slash commands to signal the broker. These are detected in the agent's PTY output at the broker level — the agent simply prints the command on its own line.

### `/exit`

Signals that the agent has completed its current step and is ready to be released.

```
/exit
```

The workflow runner waits for each agent to `/exit` after delivering a step task. When the broker detects `/exit` in the agent's output (exact line match after ANSI stripping), it:

1. Emits an `agent_exit` frame with `reason: "agent_requested"`
2. Triggers graceful PTY shutdown

If an agent does not `/exit` within the step's `timeoutMs`, the runner treats the step as timed out. As a safety net, steps with `file_exists` verification will still pass if the expected file is present despite the timeout.

**Best practice:** Instruct agents to output `/exit` when done in your step task descriptions:

```yaml
steps:
  - name: build-api
    agent: backend
    task: |
      Build the REST API endpoints for user management.
      When finished, output /exit.
```

## Idle Agent Detection and Nudging

Interactive agents sometimes finish their task but forget to `/exit`, sitting idle and blocking downstream steps. The runner can detect idle agents and take action automatically.

### Configuration

Add `idleNudge` to your swarm config:

```yaml
swarm:
  pattern: hub-spoke
  idleNudge:
    nudgeAfterMs: 120000      # 2 min before first nudge (default)
    escalateAfterMs: 120000   # 2 min after nudge before force-release (default)
    maxNudges: 1              # Nudges before escalation (default)
```

All built-in templates include idle nudging with these defaults.

### How It Works

1. **Detection**: The broker tracks agent output timestamps and emits `agent_idle` events when an agent goes silent for the configured threshold
2. **Nudge**: For hub patterns (hub-spoke, fan-out, hierarchical, etc.), the runner tells the hub agent to check on the idle agent. For non-hub patterns, a system message is injected directly into the agent's PTY
3. **Escalation**: If the agent remains idle after `maxNudges` attempts, the runner force-releases it and captures whatever output was produced
4. **No config**: When `idleNudge` is omitted, the runner uses simple `waitForExit` (backward compatible)

### Events

The runner emits two new events for idle nudging:

| Event | Description |
|-------|-------------|
| `step:nudged` | Fired when a nudge message is sent to an idle agent |
| `step:force-released` | Fired when an agent is force-released after exhausting nudges |

## Automatic Step Owner and Review

For interactive agent steps, the runner uses a point-person-led completion model:

1. **Elects a step owner** (prefers lead/coordinator-style agents, falls back to the step agent)
2. **Runs a completion decision pipeline** — checks deterministic verification first, then owner judgment, then evidence
3. **Owner can issue structured decisions** via `OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION` with optional `REASON: <text>`
4. **Review parsing is tolerant** — accepts "Approved", "Complete", "LGTM", not just exact `REVIEW_DECISION: APPROVE`
5. **Markers are optional accelerators** — `STEP_COMPLETE:<step-name>` still works as a fast-path but is never required
6. Stores primary output plus review output in the step artifact

**Evidence-based completion:** The runner collects channel messages, file artifacts, process exit codes, and coordination signals (e.g., WORKER_DONE posted in channel) as completion evidence. When sufficient evidence exists, the step completes without requiring any sentinel marker.

Deterministic and worktree steps are unchanged and do not require owner/review delegation.

## Sandbox Execution

By default the runner spawns steps as local child processes. To run them in
isolated sandboxes instead, select a provider — the runner still owns command
construction, env, cwd, timeout, and the whole DAG/retry/verification pipeline;
the provider only supplies "where the command runs".

```bash
# Off by default. Unset the flag to get local child processes back.
export RELAYFLOWS_SANDBOX_PROVIDER=daytona
export DAYTONA_API_KEY=...
export RELAYFLOWS_SANDBOX_HOME_DIR=/home/daytona   # image-specific, required
export RELAYFLOWS_SANDBOX_SNAPSHOT=my-snapshot     # optional
```

Or in code:

```typescript
import { WorkflowRunner } from "@relayflows/core";

const runner = new WorkflowRunner({
  sandbox: { provider: "daytona", homeDir: "/home/daytona" },
});
```

| Provider | What it gives you |
| --- | --- |
| `none` (default) | No sandbox. Local child processes, exactly as before. |
| `daytona` | Real remote sandboxes via `@agent-relay/sandbox`. Needs the optional peer `@daytonaio/sdk`. |
| `local-process` | Real local processes in a private per-step directory with its own `HOME`. Isolates the filesystem root, not the machine — good for development and CI, not a security boundary. |

**Reversibility.** `provider: "none"` (or an unset `RELAYFLOWS_SANDBOX_PROVIDER`)
produces no backend at all, so nothing about the default path changes. An
explicit `executor` or `processBackend` still wins over sandbox config, so a
host that injects its own backend today keeps it.

**Custom providers.** Register a runtime under any name, or hand one in
directly. This is the seam a host uses to plug in a runtime that does not live
in this repo:

```typescript
import { registerSandboxProvider, WorkflowRunner } from "@relayflows/core";

registerSandboxProvider("my-runtime", (config) => new MyRuntime(config));
// ...or skip the registry entirely:
new WorkflowRunner({ sandbox: { runtime: myRuntime } });
```

A runtime needs five methods — `launch`, `exec`, `uploadFile`, `getHomeDir`,
`destroy` — matching `@agent-relay/sandbox`'s `WorkflowRuntime`.

## Schema Validation

A JSON Schema is available at `packages/core/src/schema.json` for editor autocompletion and validation of `relay.yaml` files.

## Development

```bash
npm install
npm run typecheck
npm run test
```

## Requirements

- Node.js 22+
- `@relayflows/cli` installed (`npm install -g @relayflows/cli`)
- For Python: Python 3.10+ with `pip install agent-relay`
- For TypeScript workflow files: `tsx` or `ts-node` installed

## License

Apache-2.0 — Copyright 2025 Agent Workforce Incorporated
