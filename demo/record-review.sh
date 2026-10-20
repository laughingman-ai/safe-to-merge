#!/usr/bin/env bash
# Record the fresh-context review that the replay shows. Runs the real reviewer
# (scripts/run-reviewer.sh) on the replay's fix branch, with this checkout as the trusted
# side, and saves its verdict to demo/fixtures/review.json. Run `npm run replay` first.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$repo/.demo-run/work"
[ -d "$work" ] || { echo "Run npm run replay first." >&2; exit 1; }

diff="$(mktemp)"
trap 'rm -f "$diff"' EXIT
git -C "$work" diff main...fix/weekend-due-date >"$diff"
"$repo/scripts/run-reviewer.sh" "$work" "$diff" "$repo" | jq . >"$repo/demo/fixtures/review.json"
cat "$repo/demo/fixtures/review.json"
