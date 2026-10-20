# safe-to-merge

A small TypeScript library (business-day due dates for invoices) wrapped in the gates that
decide when an agent's work is done. Node 22.18+, no build step: Node runs the `.ts` files
directly.

## Commands

| Command          | What it does                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `npm run verify` | lint, typecheck, unit tests, hook tests, test-lock check. Ends `VERIFY PASSED` when healthy. |
| `npm test`       | unit tests only                                                                              |
| `npm run format` | format everything (edits are formatted automatically)                                        |

## Fixing a bug

1. Branch `fix/<short-name>` from `main`.
2. Write a test that fails because of the bug. Run it and see it fail. Commit it on its own.
   From then on the test files on this branch are locked: the fix has to make that test pass.
3. Change the code under `src/` until `npm run verify` passes.
4. Commit, push the branch, and open a PR that says `Fixes #<issue>`.
5. Stop. A fresh-context review and a human decide whether it merges. Never merge.

## Rules the hooks enforce

You'll be blocked if you try any of these, so don't: pushing to `main` or force pushing,
merging a PR, editing tests after the reproduction is committed, editing the gates
(`.claude/`, `hooks/`, `.github/`, `scripts/verify.mjs`, `scripts/check-test-lock.mjs`),
writing `.env` files or credentials, or finishing while `npm run verify` fails.
