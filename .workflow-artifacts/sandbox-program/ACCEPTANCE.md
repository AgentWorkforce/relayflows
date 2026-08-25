SANDBOX PROGRAM ACCEPTANCE CONTRACT

Stage 1 — provisioning (the n=2 fault, highest value in the program)
  A1  mount | grep -i relayfile is non-empty on a FRESH box
  A2  gh --version exits 0 on a fresh box
  A3  gh auth status exits 0 on a fresh box
  A4  roster present on a fresh box
  A5  the workspace is the live mounted tree, NOT a /tmp clone
  A6  the live snapshot builder installs gh, mounts Relayfile, writes the roster
  A7  CI green per workflow on the lane branch, read with gh run list --branch

Stage 2 — sandbox#30 (credential exposure, outranks feature work)
  B1  the detached initial-sync script is mode exactly 0600
  B2  ... proven under a 022 umask, not inherited from a lucky umask
  B3  the fixture token is absent from the generated content
  B4  repo typecheck and full test suite green
  B5  CI green per workflow on the lane branch

Stage 3 — long-running provider reconciliation
  C1  one document that supersedes sandbox-router#16 and #17
  C2  four axes: indefinite run, idle cost, restart survival, our stack
  C3  every claim labelled OBSERVED / DOCUMENTED / INFERRED
  C4  an explicit DAYTONA_CAP_RULING on the disputed session cap
  C5  a crossover point for idle-heavy sessions, not a single number
  C6  a RECOMMENDATION, and an UNKNOWN list rather than inference
  C7  public-repo hygiene: no raw tokens

Stage 4 — capability routing (gated behind stage 1)
  D1  sandbox-router typecheck and tests green
  D2  selection is by capability, not by hardcoded provider
  D3  cloud actually consumes it — a real call site, not a compiled module
  D4  sandbox-router build green on the lane clone

PASS  = every gate exit code zero. Then, and only then, commit-if-green commits.
BLOCKED = any gate still red after repair. Writes BLOCKED_NO_COMMIT.md with the
          failing evidence and exits successfully. A handled blocked state is a
          result; a crashed run is not.
Never merge, never push. Khaliq owns every merge gate.
