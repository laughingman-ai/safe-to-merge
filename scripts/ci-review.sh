#!/usr/bin/env bash
# The review job in CI (.github/workflows/review.yml). Runs from the base branch's checkout
# (trusted/), reviews the PR head (pr/), comments the findings, and exits non-zero on a
# failing verdict, which fails the required `review/fresh-context` check.
#
# Env: PR_NUMBER, GITHUB_REPOSITORY, GH_TOKEN (comments), ANTHROPIC_API_KEY (the reviewer).
set -euo pipefail

: "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "::error::The ANTHROPIC_API_KEY repository secret isn't set, so the review can't run. The owner adds it: see docs/AGENT_IDENTITY.md, 'CI reviewer key'."
  exit 1
fi

workspace="${GITHUB_WORKSPACE:-$PWD}"
trusted="$workspace/trusted"
note=""
if [ ! -f "$trusted/scripts/run-reviewer.sh" ]; then
  # Only possible for the PR that introduces the reviewer: the base branch has none yet.
  trusted="$workspace/pr"
  note="_Bootstrap run: the base branch has no reviewer yet, so the reviewer files came from this PR._"
fi

diff="$(mktemp)"
gh pr diff "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" >"$diff"
review="$("$trusted/scripts/run-reviewer.sh" "$workspace/pr" "$diff" "$trusted")"
verdict="$(jq -r .verdict <<<"$review")"
sha="$(git -C "$workspace/pr" rev-parse HEAD)"

{
  printf '### Fresh-context review of %s: %s\n\n' "${sha:0:7}" "$verdict"
  jq -r '.summary' <<<"$review"
  printf '\n'
  jq -r '.findings[] | "- **\(.severity)** `\(.file)\(if .line then ":\(.line)" else "" end)`: \(.issue)"' <<<"$review"
  [ -n "$note" ] && printf '\n%s\n' "$note"
} >"$diff.comment"
gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body-file "$diff.comment" >/dev/null
cat "$diff.comment"
[ "$verdict" = "pass" ]
