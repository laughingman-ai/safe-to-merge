#!/usr/bin/env bash
# Run the fresh-context reviewer on a checkout and print its structured verdict as JSON.
# Usage: scripts/run-reviewer.sh <checkout-dir> <base-ref> <head-ref>
# Used by scripts/review.sh (for PRs) and demo/record-review.sh (for the replay).
set -euo pipefail

dir="${1:?checkout dir}" base="${2:?base ref}" head="${3:?head ref}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
model="${REVIEW_MODEL:-sonnet}"
prompt="$(mktemp)"
trap 'rm -f "$prompt"' EXIT

{
  cat "$here/review-prompt.md"
  printf '\n\n## Diff (%s...%s)\n\n```diff\n' "$base" "$head"
  git -C "$dir" diff "$base...$head"
  printf '```\n'
} >"$prompt"

# --safe-mode: no hooks, CLAUDE.md, skills, or plugins from this machine. --strict-mcp-config
# with no config: no MCP servers. Read-only tools. The reviewer sees the repo and the diff.
(cd "$dir" && claude -p --safe-mode --strict-mcp-config --disable-slash-commands \
  --no-session-persistence --model "$model" --tools "Read,Grep,Glob" \
  --output-format json --json-schema "$(cat "$here/review-schema.json")" <"$prompt") |
  jq -ce '.structured_output // error("the reviewer returned no verdict")'
