# safe-to-merge

A small TypeScript library (business-day due dates for invoices) wrapped in the gates that
decide when an agent's work is done. Node 22.18+, no build step: Node runs the `.ts` files
directly.

## Commands

| Command                   | What it does                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `node scripts/verify.mjs` | lint, typecheck, unit tests, hook tests, test-lock check. Ends `VERIFY PASSED` when healthy. |
| `npm test`                | unit tests only                                                                              |
| `npm run format`          | format everything (edits are formatted automatically)                                        |

## Fixing a bug

1. Branch `fix/<short-name>` from `main`.
2. Write a test that fails because of the bug. Run it and see it fail. Commit it on its own.
   From then on the test files on this branch are locked: the fix has to make that test
   pass. Don't reset, rebase, or amend past that commit.
3. Change the code under `src/` until `node scripts/verify.mjs` passes.
4. Commit, push the branch, and open a PR that says `Fixes #<issue>`.
5. Stop. CI's verify and fresh-context review, and a human, decide whether it merges.
   Never merge, approve, or post statuses.

## Rules

The hooks block the common forms of these, and CI and the rules on `main` catch the rest.
Don't try them:

- pushing to `main`, force pushing, or deleting branches
- merging or approving a PR, posting commit statuses or checks, or changing repo settings
- editing tests after the reproduction is committed, or rewriting history to unlock them
- changing the gates: `.claude/`, `.git/`, `.github/`, `hooks/`, `node_modules/`,
  `package.json` and the other config files, `scripts/`, `KNOWN_BUGS.md`
- writing `.env` or `.envrc` files, or putting a credential in a file or a command
- finishing while `node scripts/verify.mjs` fails
- piping into a shell or interpreter, `source`, or using `$`, backticks, `~`, or `{a,b}` in a
  command that writes files (use literal paths and single quotes)
- printing the environment or tokens (`printenv`, `env`, `gh auth token`)
