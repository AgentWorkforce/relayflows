#!/usr/bin/env bash
# Full program acceptance — reruns all four stage gates and scores each by its
# own exit code. This is the command `commit-if-green` reruns; the commit
# happens only when every one of these is zero.
set -uo pipefail
GATE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./_lib.sh
source "$GATE_DIR/_lib.sh"
gate_init "program-acceptance"

for stage in stage1-provisioning stage2-sandbox30 stage3-longrun-reconcile stage4-capability-routing; do
  rc=0
  {
    echo ""
    echo "=== rerunning $stage ==="
  } >> "$LOG"
  bash "$GATE_DIR/$stage.sh" >> "$LOG" 2>&1 || rc=$?
  # Uppercase the stage name for the record without bash 4 syntax.
  label=$(printf '%s' "$stage" | tr '[:lower:]-' '[:upper:]_')
  record "ACCEPT_$label" "$rc"
done

gate_finish
