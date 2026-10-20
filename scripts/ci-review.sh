#!/usr/bin/env bash
# The review job in CI (.github/workflows/review.yml). Reviews the PR head (pr/) using the
# reviewer from the trusted checkout (TRUSTED_DIR, the base branch), comments the findings,
# and exits non-zero on a failing verdict, which fails the required `review/fresh-context`
# check.
#
# Env: PR_NUMBER, GITHUB_REPOSITORY, GH_TOKEN (comments), ANTHROPIC_API_KEY (the reviewer),
#      TRUSTED_DIR (default: $GITHUB_WORKSPACE/trusted), REVIEW_NOTE (optional comment footer).
set -euo pipefail

: "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}"
workspace="${GITHUB_WORKSPACE:-$PWD}"
trusted="${TRUSTED_DIR:-$workspace/trusted}"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "::error::The ANTHROPIC_API_KEY repository secret isn't set, so the review can't run. The owner adds it: see docs/AGENT_IDENTITY.md, 'CI reviewer key'."
  exit 1
fi
if [ ! -f "$trusted/scripts/run-reviewer.sh" ]; then
  echo "::error::The base branch has no reviewer (scripts/run-reviewer.sh), so this PR can't be reviewed."
  exit 1
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
  if [ -n "${REVIEW_NOTE:-}" ]; then printf '\n%s\n' "$REVIEW_NOTE"; fi
} >"$diff.comment"
gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --body-file "$diff.comment" >/dev/null
cat "$diff.comment"
[ "$verdict" = "pass" ]
