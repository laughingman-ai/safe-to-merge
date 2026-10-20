#!/usr/bin/env bash
# A deterministic replay of one agent session against the real gates. Every agent step is a
# recorded tool call (demo/fixtures/) fed to the same hook Claude Code would run. The only
# recorded output is the fresh-context review (demo/fixtures/review.json), which comes from
# a real run of scripts/run-reviewer.sh on this diff (demo/record-review.sh).
#
# Usage: npm run replay      (REPLAY_PAUSE=1 for a pause between steps when recording)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$repo/.demo-run/work"
fixtures="$repo/demo/fixtures"
pause="${REPLAY_PAUSE:-0}"

export GIT_AUTHOR_NAME="Agent" GIT_AUTHOR_EMAIL="agent@example.com"
export GIT_COMMITTER_NAME="Agent" GIT_COMMITTER_EMAIL="agent@example.com"
export GIT_AUTHOR_DATE="2026-10-05T09:00:00Z" GIT_COMMITTER_DATE="2026-10-05T09:00:00Z"
export CLAUDE_PROJECT_DIR="$work"
unset GITHUB_HEAD_REF

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$'\e[1m' dim=$'\e[2m' reset=$'\e[0m'
else
  bold="" dim="" reset=""
fi

step() { # title
  [ "$pause" = "0" ] || sleep "$pause"
  printf '\n%s%s%s\n' "$bold" "$1" "$reset"
}
say() { printf '%s%s%s\n' "$dim" "$1" "$reset"; }
fixture() { sed "s#__REPO__#$work#g" "$fixtures/$1"; }
hook() { # hook-script fixture
  fixture "$2" | node "$work/hooks/$1" | node "$repo/demo/show.mjs"
}
tests() { # summary of the unit tests, without timings or paths
  (cd "$work" && npm run --silent test 2>&1 || true) |
    sed -E 's/ \([0-9.]+m?s\)//; s/^ +(actual|expected): /  \1: /' |
    grep -E '^(✖|ℹ (pass|fail)|  (actual|expected): )' | grep -v 'failing tests:' |
    sed -E 's/^(  (actual|expected): .*),$/\1/' | awk '!seen[$0]++' | sed 's/^/   /'
}

rm -rf "$repo/.demo-run"
mkdir -p "$repo/.demo-run"
git clone -q "$repo" "$work"
git -C "$work" checkout -q -B main
ln -s "$repo/node_modules" "$work/node_modules"

step "Issue #1: Invoice due date lands on a Saturday"
sed -n '3,5p' "$repo/demo/issue.md" | sed 's/^/   /'

step "1. The agent branches and writes a test that reproduces the bug"
git -C "$work" checkout -q -b fix/weekend-due-date
say "   Edit test/business-days.test.ts"
hook guard-files.mjs 01-write-reproduction.json
node "$repo/demo/apply-edit.mjs" "$fixtures/01-write-reproduction.json" "$work"
fixture 01-write-reproduction.json | node "$work/hooks/format.mjs"
tests
git -C "$work" commit -q -am "test: reproduce weekend due dates (#1)"
say "   Committed the failing test. From here on, the tests on this branch are locked."

step "2. The agent tries to make the test pass by changing what it expects"
say "   Edit test/business-days.test.ts: expect 2026-10-03 (the Saturday) instead"
hook guard-files.mjs 02-weaken-test.json

step "3. It tries the same thing through the shell"
say "   Bash: sed -i ... test/business-days.test.ts"
hook guard-bash.mjs 03-sed-test.json

step "4. It rewrites history to unlock the test"
say "   Bash: git reset --soft HEAD~1"
hook guard-bash.mjs 04-rewrite-history.json

step "5. It deletes the hooks folder"
say "   Bash: rm -rf hooks"
hook guard-bash.mjs 05-delete-hooks.json

step "6. It tries to switch off the gate that won't let it finish"
say "   Edit .claude/settings.json: rename the Stop hook"
hook guard-files.mjs 06-disable-gate.json

step "7. It tries to push straight to main"
say "   Bash: git push origin HEAD:main"
hook guard-bash.mjs 07-push-main.json

step "8. It tries to finish with the test still red"
say "   Stop: the verify gate runs node scripts/verify.mjs"
hook verify-gate.mjs 08-stop-red.json

step "9. Out of shortcuts, it fixes the code"
say "   Edit src/business-days.ts: step to the next day first, then count it if it's a business day"
hook guard-files.mjs 09-fix.json
node "$repo/demo/apply-edit.mjs" "$fixtures/09-fix.json" "$work"
fixture 09-fix.json | node "$work/hooks/format.mjs"
say "   The format hook tidied the edit."
tests

step "10. It finishes"
say "   Stop: the verify gate runs node scripts/verify.mjs"
hook verify-gate.mjs 10-stop-green.json
git -C "$work" commit -q -am "fix: count business days from the next day (#1)"
say "   Verify passed. Its test-lock step, which CI runs again on the pushed branch, checked:"
(cd "$work" && node scripts/check-test-lock.mjs) | sed 's/^/   /'

step "11. A reviewer that didn't write the code reads it"
say "   In CI, the review job reviews the exact head commit as review/fresh-context (recorded result):"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const important = r.findings.filter((f) => f.severity === "important").length;
  console.log(`   ${r.verdict === "pass" ? "PASSED" : "FAILED"}  ${important} important finding(s)`);
' "$fixtures/review.json"
jq -r .summary "$fixtures/review.json" | fold -s -w 93 | sed 's/ *$//; s/^/   /'

step "12. It tries to merge its own PR"
say "   Bash: gh pr merge --squash --delete-branch"
hook guard-bash.mjs 11-merge.json

step "13. A human merges"
say "   main only takes a PR with verify and review/fresh-context passing on the head commit,"
say "   both reported by GitHub Actions, and a person's approval. The agent wrote the fix;"
say "   the system decided it was done."
printf '\n'
