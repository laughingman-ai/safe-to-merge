# Review history

The fresh-context reviewer (`scripts/run-reviewer.sh`) reviewed the pull request that added
it. That pull request was in an earlier private copy of this repository, so its review
comments aren't on GitHub here. They're quoted below word for word, with commit IDs changed
to the matching commits in this repository's history. "PR #2" in them means that earlier pull
request, not #2 here.

The first two reviews ran locally and the owner posted them. The third ran in GitHub Actions.
Line numbers in the quotes are the reviewer's own and are sometimes a little off: review 1's
`hooks/guard-bash.mjs:112` is `checkPush`, which starts at line 124 in `a1837a3`.

The 2026-10-20 merge commits in `git log` ("Merge pull request #2", "#3", "#4") are from that
earlier repository, so their PR numbers point there. The 2026-11-18 ones with the same
numbers are this repository's own PRs.

## 1. Fail, on [`a1837a3`](https://github.com/laughingman-ai/safe-to-merge/commit/a1837a3)

> **Fresh-context review of a1837a3: fail**
>
> Adds the whole safe-to-merge demo: a small business-day invoice library, Claude Code hooks (push guard, test lock, gate protection, secrets guard, format, verify gate), CI, a fresh-context review script, and a replay. The shipped `src/business-days.ts` still has the weekend due-date bug that the demo is built around.
>
> - **important** `src/business-days.ts:46`: `addBusinessDays` checks whether the day it is leaving is a business day, not the day it lands on. `addBusinessDays("2026-10-01", 2)` returns `"2026-10-03"` (a Saturday), and `addBusinessDays("2026-10-02", 1)` returns Saturday too. Any Net-N invoice whose due date falls just before a weekend gets a weekend due date. `dueDate` and `isOverdue` in `src/invoice.ts` inherit this. The loop should step forward first, then count the new day only if it is a business day.
> - **important** `test/business-days.test.ts:1`: The suite has no test for the weekend landing case: there is no Thu+2 or Fri+1 test. The existing tests (`Fri + 3 = Wed`, `Mon + 2` with a holiday) all pass despite the bug, so `npm run verify` reports `VERIFY PASSED` on code with a known defect. The test the replay adds (`a due date never lands on a weekend (#1)`) isn't in this PR.
> - **minor** `hooks/guard-bash.mjs:112`: `checkPush` only compares refspec targets to `main`/`master` by name. `git push origin HEAD` run while on main gives target `HEAD`, which isn't flagged, so it pushes main. A refspec `HEAD:refs/heads/main` is handled, but plain `HEAD` isn't. The README states the guard is best-effort and the rules on main are the backstop.

The first finding is the bug the demo keeps on purpose. The reviewer had no way to know that,
so [`94892f3`](https://github.com/laughingman-ai/safe-to-merge/commit/94892f3) added [KNOWN_BUGS.md](../KNOWN_BUGS.md), which the reviewer reads from
`main`. It's a gate, so an agent can't add its own bugs to the list. The same commit made the
push guard resolve `HEAD` and `@` to the current branch, with tests for both cases.

## 2. Pass, on [`94892f3`](https://github.com/laughingman-ai/safe-to-merge/commit/94892f3)

> **Fresh-context review of 94892f3: pass**
>
> This adds the whole demo repo: a small business-day invoice library, hooks for push, merge, test-lock, gate-protection, secrets, format and verify, the verify, test-lock and review scripts, CI, and a replay demo. I found no new bugs, weakened tests, credentials or loosened gates. The `addBusinessDays` bug is the one listed in KNOWN_BUGS.md.
>
> - **minor** `hooks/guard-bash.mjs:122`: checkPush treats every non-dash argument as an operand. An option that takes a separate value, such as `git push --repo X origin main` or `-o opt`, shifts the operands, so the remote is misread. Pushing to main in that form could slip past the guard. CI and the rules on main are the backstop, and the README states this limit.

Fixed in [`08e5956`](https://github.com/laughingman-ai/safe-to-merge/commit/08e5956): the push guard skips the values of `--repo`, `-o`, `--push-option`,
`--receive-pack`, and `--exec`. `hooks/test/guard-bash.test.mjs` covers
`git push --repo origin origin main`.

Review 2 passed, but the repo wasn't done. Four more rounds of review followed, by
separate fresh-context agents that reviewed the whole repository rather than by this
reviewer. They found the bigger gaps: checks a token could forge, ways to merge, holes in
the test lock, and ways to delete the gates. Each round's fixes are in one commit, named in
its message:
[`08e5956`](https://github.com/laughingman-ai/safe-to-merge/commit/08e5956), [`5c2f79a`](https://github.com/laughingman-ai/safe-to-merge/commit/5c2f79a), [`642956e`](https://github.com/laughingman-ai/safe-to-merge/commit/642956e), and [`3d92fef`](https://github.com/laughingman-ai/safe-to-merge/commit/3d92fef).

## 3. Pass, in GitHub Actions, on [`3d92fef`](https://github.com/laughingman-ai/safe-to-merge/commit/3d92fef)

> **Fresh-context review of 3d92fef: pass**
>
> The PR adds the whole repo: the invoice and business-day library, the Claude Code hooks, verify and test-lock scripts, CI workflows including the fresh-context reviewer, the replay demo and the docs. The listed bug #1 is left in `src/business-days.ts` with no test covering it, as intended. I read through the diff and found nothing important. I did not run any code or check the pinned bootstrap hashes.
>
> - **minor** `demo/fixtures/review.json:9`: The recorded review cites `test/business-days.test.ts:30` for a test that the replay adds, but the file in this PR has no such test and is only 39 lines long. The fixture is a recording of the replay's fix branch, not of this branch, which is slightly confusing. It also isn't regenerated automatically.
> - **minor** `.github/workflows/review.yml:57`: The bootstrap step is pinned to SHA-256 hashes of files in this same PR. Any later edit to those scripts, before the bootstrap is removed, makes the PR #2 review fail until the hashes are updated by hand.
>
> _Bootstrap review: main had no reviewer yet, so this PR's reviewer files ran, after matching the pinned hashes in review.yml._

The bootstrap step was removed in [`31b5684`](https://github.com/laughingman-ai/safe-to-merge/commit/31b5684). The recorded fixture is still a recording of
the replay's fix branch; `demo/record-review.sh` regenerates it.
