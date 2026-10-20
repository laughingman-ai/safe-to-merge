#!/usr/bin/env node
// @ts-check
// CI side of the test lock. On a fix/* branch, no commit after the reproduction commit may
// change a test file. The PreToolUse hooks stop an agent from trying; this catches anything
// that got past them, including changes made outside Claude Code.

import { execFileSync } from "node:child_process";

import { testLock } from "../hooks/lib.mjs";

const lock = testLock(process.cwd());
if (!lock.locked) {
  console.log("test lock: not a fix/* branch with a committed reproduction; nothing to check");
  process.exit(0);
}

const changed = execFileSync(
  "git",
  ["diff", "--name-only", lock.lockCommit, "HEAD", "--", "test", ":(glob)**/*.test.*"],
  { encoding: "utf8" },
).trim();

if (changed) {
  console.error(
    `test lock: test files changed after the reproduction commit ${lock.lockCommit.slice(0, 7)}:\n` +
      changed
        .split("\n")
        .map((f) => `  ${f}`)
        .join("\n") +
      "\nThe fix has to make the committed test pass, not change it.",
  );
  process.exit(1);
}
console.log(`test lock: tests unchanged since reproduction ${lock.lockCommit.slice(0, 7)}`);
