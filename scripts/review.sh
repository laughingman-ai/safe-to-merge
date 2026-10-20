#!/usr/bin/env bash
# Fresh-context review of a PR, run locally. A new Claude Code process, with no memory of the
# session that wrote the change, reviews the PR at its exact head commit using the review
# instructions from the base branch.
#
# This is a preview. It prints the verdict (and comments it with --comment) but posts no
# status: the required `review/fresh-context` check comes only from CI
# (.github/workflows/review.yml), so it can't be forged with a personal token.
#
# Usage: scripts/review.sh <pr-number> [--comment]
# Needs: gh (authenticated), claude (signed in), jq.
set -euo pipefail

pr="${1:?usage: scripts/review.sh <pr-number> [--comment]}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sha="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"
base="$(gh pr view "$pr" --json baseRefName -q .baseRefName)"

work="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$work/pr" >/dev/null 2>&1 || true
  git worktree remove --force "$work/trusted" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git fetch -q origin "$base" "pull/$pr/head"
git worktree add -q --detach "$work/pr" "$sha"
git worktree add -q --detach "$work/trusted" "origin/$base"
gh pr diff "$pr" >"$work/diff.patch"

trusted="$work/trusted"
if [ ! -f "$trusted/scripts/run-reviewer.sh" ]; then
  echo "note: $base has no reviewer yet (bootstrap); using this PR's reviewer files" >&2
  trusted="$work/pr"
fi
review="$("$trusted/scripts/run-reviewer.sh" "$work/pr" "$work/diff.patch" "$trusted")"

{
  printf '### Fresh-context review of %s: %s\n\n' "${sha:0:7}" "$(jq -r .verdict <<<"$review")"
  jq -r '.summary' <<<"$review"
  printf '\n'
  jq -r '.findings[] | "- **\(.severity)** `\(.file)\(if .line then ":\(.line)" else "" end)`: \(.issue)"' <<<"$review"
  printf '\n_Local preview. The required check is the review job in CI._\n'
} >"$work/comment.md"
[ "${2:-}" = "--comment" ] && gh pr comment "$pr" --body-file "$work/comment.md" >/dev/null
cat "$work/comment.md"
[ "$(jq -r .verdict <<<"$review")" = "pass" ]
