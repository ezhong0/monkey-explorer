#!/usr/bin/env bash
# Smoke test: dispatch one mission, assert the JSON output's shape is what
# Claude would expect to consume. Catches Stagehand SDK shape drift on bumps.
#
# Run: scripts/smoke.sh [target-name] [mission]
#   defaults: target=staging-cookies, mission="review the homepage at /app"
#
# Asserts (one assertion per line; fails fast):
#   - mission ran (status terminal, sessionId present, finishedAt populated)
#   - per-mission verdict in the canonical enum
#   - review.summary non-empty
#   - review.tested / review.worked / review.issues / review.suggestions are arrays
#   - summary.by_verdict has all four keys
#
# Exits 0 on pass, non-zero on first failure. Prints the failing assertion
# and the offending JSON path.

set -euo pipefail

TARGET="${1:-staging-cookies}"
MISSION="${2:-review the homepage at /app}"

cd "$(dirname "$0")/.."

if ! command -v jq >/dev/null 2>&1; then
  echo "smoke: jq not installed; required" >&2
  exit 2
fi

echo "smoke: target=$TARGET mission=\"$MISSION\""
echo "smoke: running…"

JSON_OUT="$(npx tsx src/cli/main.ts --target "$TARGET" --json --non-interactive "$MISSION" 2>/dev/null)"

if [[ -z "$JSON_OUT" ]]; then
  echo "FAIL: monkey produced no JSON output" >&2
  exit 1
fi

# Each assertion: name + jq predicate. Predicate returns true to pass.
assert() {
  local name="$1"; shift
  local pred="$1"; shift
  if echo "$JSON_OUT" | jq -e "$pred" >/dev/null 2>&1; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name" >&2
    echo "    predicate: $pred" >&2
    echo "    json snippet:" >&2
    echo "$JSON_OUT" | jq '.' | head -20 >&2
    exit 1
  fi
}

assert "monkey_version present" \
  '.monkey_version | type == "string" and length > 0'

assert "missions array has 1 entry" \
  '.missions | type == "array" and length == 1'

M='.missions[0]'

assert "mission ran (sessionId present)" \
  "$M.sessionId | type == \"string\" and length > 0"

assert "mission ran (finishedAt is iso datetime)" \
  "$M.finishedAt | type == \"string\" and test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}T\")"

assert "verdict is in canonical enum" \
  "$M.verdict | . == \"works\" or . == \"broken\" or . == \"partial\" or . == \"unclear\""

assert "summary is non-empty string" \
  "$M.summary | type == \"string\" and length > 0"

assert "review.verdict matches mission.verdict" \
  "$M.review.verdict == $M.verdict"

assert "review.summary is non-empty" \
  "$M.review.summary | type == \"string\" and length > 0"

assert "review.tested is array" \
  "$M.review.tested | type == \"array\""

assert "review.worked is array" \
  "$M.review.worked | type == \"array\""

assert "review.issues is array" \
  "$M.review.issues | type == \"array\""

assert "review.suggestions is array" \
  "$M.review.suggestions | type == \"array\""

assert "summary.by_verdict has all four keys" \
  '.summary.by_verdict | (has("works") and has("broken") and has("partial") and has("unclear"))'

assert "summary.total matches missions length" \
  '.summary.total == (.missions | length)'

# Stagehand-shape-drift canary: if Stagehand renames `actions` → `steps` (etc),
# the trace builder silently produces empty action steps and verdict tends
# to come back 'unclear' for "no descriptions". Assert that EITHER:
#   (a) verdict is something other than unclear (the agent's actions made it
#       through to the trace), OR
#   (b) the diagnostic explains why ('rate_limited' / 'timed_out' /
#       'parse_failed' / 'errored').
# Failing this means the run produced an unclear verdict with NO diagnostic
# — a strong signal that trace-shape drifted.
assert "unclear-without-diagnostic canary (likely Stagehand drift if this fails)" \
  "($M.verdict != \"unclear\") or ($M.review.diagnostic | . != null)"

echo "smoke: all assertions passed"
