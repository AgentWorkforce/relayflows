# BLOCKED_NO_COMMIT

timestamp: 2026-08-25T06:29:36Z
acceptance exit=1
review exit=0

## Failing evidence

```
gate: program-acceptance
timestamp: 2026-08-25T06:29:17Z
host_cwd: /Users/khaliqgant/Projects/AgentWorkforce/relayflows
aw_root: /Users/khaliqgant/Projects/AgentWorkforce
---
ACCEPT_STAGE1_PROVISIONING exit=1
ACCEPT_STAGE2_SANDBOX30 exit=1
ACCEPT_STAGE3_LONGRUN_RECONCILE exit=0
ACCEPT_STAGE4_CAPABILITY_ROUTING exit=1
---
checks: 4
failed: 3

log: /Users/khaliqgant/Projects/AgentWorkforce/relayflows/.workflow-artifacts/sandbox-program/program-acceptance.log
PROGRAM_ACCEPTANCE_RED: 3 of 4 checks failed
```

No commit was created. Resume with:
  RESUME_RUN_ID=<runId> relayflows run workflows/sandbox-program-drive.ts
