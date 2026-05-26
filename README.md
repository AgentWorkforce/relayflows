# relayflows

Workflow engine and CLI for Agent Relay.

## Packages

- `packages/core` — workflow types, runner, builder, executors. Published as `@relayflows/core`.
- `packages/cli` — `relayflows` command-line interface. Published as `@relayflows/cli`.

## Layout

- `workflows/` — production workflow definitions
- `examples/` — example workflow YAMLs and TypeScript builders
- `tests/` — workflow YAMLs used by integration tests and broker integration tests
- `docs/` — published docs (CLI usage, workflow reference)

## Relationship to relay

relayflows consumes the broker exclusively through `@agent-relay/sdk`. It does not invoke the broker binary directly. If a needed capability isn't exposed by the SDK, that gap is closed by adding to the SDK in the `relay` repo, not by reaching into broker internals here.

## Development

```bash
npm install
npm run typecheck
npm run test
```
