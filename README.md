# safe-to-merge

AI coding agents stop when the work looks done. This repo is a small, working example of
the alternative: the system decides when the work is done, and the agent can't talk its way
past it.

The code is a tiny invoice library with a real bug in it: a due date can land on a
Saturday ([issue #1](demo/issue.md)). The interesting part is everything around the code.

## See it in 30 seconds

```sh
npm ci
npm run replay
```

The replay is one agent session, recorded as tool calls and fed to the same hooks Claude
Code runs. It shows the agent reproduce the bug, then try five shortcuts, and get stopped
each time:

```
2. The agent tries to make the test pass by changing what it expects
   BLOCKED  test/business-days.test.ts. Test files are locked on this branch: the failing test
            that reproduces the bug is already committed. Change the code under src/ until that
            test passes. Do not change the test.

6. It tries to finish with the test still red
   BLOCKED  Verify failed (npm run --silent verify), so this session can't end yet. Fix the
            failure below and finish again.
            ✖ a due date never lands on a weekend (#1)
            actual: '2026-10-03'
            expected: '2026-10-05'
```

Only then does it fix the code. The output is identical on every run. To try it with a
real agent, see [demo/LIVE.md](demo/LIVE.md).

## The gates

| Gate                 | Where                                                                          | What it stops                                                                          |
| -------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Push guard           | `hooks/guard-bash.mjs` (PreToolUse, Bash)                                      | pushes to `main`, force pushes, `gh pr merge`                                          |
| Test lock            | `hooks/guard-files.mjs`, `hooks/guard-bash.mjs`, `scripts/check-test-lock.mjs` | on a `fix/*` branch, changing tests after the failing reproduction is committed        |
| Protected gates      | `hooks/guard-files.mjs`, `hooks/guard-bash.mjs`, `.github/CODEOWNERS`          | an agent editing the hooks, settings, CI, or verify script                             |
| Secrets guard        | `hooks/guard-files.mjs`                                                        | `.env` files and credentials written into the repo                                     |
| Format on edit       | `hooks/format.mjs` (PostToolUse)                                               | formatting noise in review and lint failures                                           |
| Verify gate          | `hooks/verify-gate.mjs` (Stop)                                                 | ending a session while `npm run verify` fails                                          |
| Fresh-context review | `scripts/review.sh`                                                            | the agent that wrote the code approving it                                             |
| Rules on `main`      | GitHub rulesets                                                                | merging without green `verify`, a passing review on the exact head commit, and a human |

`npm run verify` is the single definition of done. CI runs it, and the Stop hook won't let a
session end while it fails. Every hook has tests in `hooks/test/`, and `verify` runs them.

## Why it's built this way

- **A rule in a prompt is a suggestion. A rule in a hook is a fact.** `CLAUDE.md` tells the
  agent what to do; the hooks make the important parts non-negotiable.
- **Tests come first and then stay put.** A bug fix starts with a test that fails. Once it's
  committed, the only way to green is to change the code.
- **The author never approves its own work.** The reviewer is a new process with no memory
  of the session, and its verdict is bound to one commit. A new push needs a new review.
- **Every layer has a backstop.** The hooks catch the ordinary attempts. CI catches anything
  done outside Claude Code. The rules on `main` and a human catch the rest.

## Limits, stated plainly

- The shell guard parses commands simply. It catches the normal ways to push, merge, or
  write a file, not every possible one. CI and the rules on `main` are the backstop.
- Claude Code ends a session after eight Stop-hook blocks in a row, so an agent that can't
  fix a failure stops and reports it instead of looping forever.
- The reviewer is a model. It's a second opinion with a structured verdict, not a proof.
  The human approval is the last gate.
- The replay's review verdict is recorded (`demo/fixtures/review.json`) from a real run of
  the reviewer on the replay's diff (`demo/record-review.sh`). Everything else in the replay
  runs live.

## Commands

| Command                  | What it does                                               |
| ------------------------ | ---------------------------------------------------------- |
| `npm run verify`         | lint, typecheck, unit tests, hook tests, test-lock check   |
| `npm run replay`         | the recorded agent session against the real gates          |
| `npm run review -- <pr>` | fresh-context review of a PR; posts `review/fresh-context` |

Requires Node 22.18 or later. The review needs `gh`, `jq`, and a signed-in `claude`.
