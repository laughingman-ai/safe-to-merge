#!/usr/bin/env bash
# Fresh-context review. A new Claude Code process, with no memory of the session that wrote
# the change, reviews the PR at its exact head commit and posts the result as the
# `review/fresh-context` commit status on that SHA. A new push means a new SHA with no
# status, so the rules on main block the merge until the new head is reviewed.
#
# Usage: scripts/review.sh <pr-number>
# Needs: gh (authenticated), claude (signed in), jq.
set -euo pipefail

pr="${1:?usage: scripts/review.sh <pr-number>}"
context="review/fresh-context"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
sha="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"
base="$(gh pr view "$pr" --json baseRefName -q .baseRefName)"

status() { # state description
  gh api -X POST "repos/$repo/statuses/$sha" -f state="$1" -f context="$context" \
    -f description="$2" >/dev/null
}

work="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$work/tree" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git fetch -q origin "$base" "pull/$pr/head"
git worktree add -q --detach "$work/tree" "$sha"

status pending "Fresh-context review running on ${sha:0:7}"
if ! review="$("$here/run-reviewer.sh" "$work/tree" "origin/$base" "$sha")"; then
  status error "Review didn't run or returned no verdict; see the log"
  exit 1
fi
verdict="$(jq -r .verdict <<<"$review")"
important="$(jq '[.findings[] | select(.severity == "important")] | length' <<<"$review")"

# The status is only meaningful for the commit that was reviewed.
now="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"
if [ "$now" != "$sha" ]; then
  status error "Head moved to ${now:0:7} during review; review ${now:0:7} instead"
  exit 1
fi

{
  printf '### Fresh-context review of %s: %s\n\n' "${sha:0:7}" "$verdict"
  jq -r '.summary' <<<"$review"
  printf '\n'
  jq -r '.findings[] | "- **\(.severity)** `\(.file)\(if .line then ":\(.line)" else "" end)`: \(.issue)"' <<<"$review"
} >"$work/comment.md"
gh pr comment "$pr" --body-file "$work/comment.md" >/dev/null

if [ "$verdict" = "pass" ]; then
  status success "Passed with no important findings (${sha:0:7})"
else
  status failure "$important important finding(s) on ${sha:0:7}; see the PR comment"
fi
cat "$work/comment.md"
