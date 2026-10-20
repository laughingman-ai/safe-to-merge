#!/usr/bin/env node
// @ts-check
// CI side of the test lock, also run by verify. On a fix/* branch:
//   1. there must be a reproduction commit (the first commit touching tests),
//   2. the reproduction must fail at its own commit (it reproduces something), and
//   3. no later commit may change a test file.
// The PreToolUse hooks stop an agent from trying to get around this locally; this catches
// anything that got past them, including changes made outside Claude Code. Locally it reads
// local history; in CI it reads the pushed branch.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TEST_PATHSPEC, testLock } from "../hooks/lib.mjs";

const cwd = process.cwd();
const lock = testLock(cwd);

if (!lock.fixBranch) {
  console.log("test lock: not a fix/* branch; nothing to check");
  process.exit(0);
}
if (!lock.locked) {
  console.error(
    "test lock: this fix/* branch has no reproduction yet. Commit a test that fails because " +
      "of the bug before changing the code.",
  );
  process.exit(1);
}
const short = lock.lockCommit.slice(0, 7);

const changed = execFileSync(
  "git",
  ["diff", "--name-only", lock.lockCommit, "HEAD", "--", ...TEST_PATHSPEC],
  { cwd, encoding: "utf8" },
).trim();
if (changed) {
  console.error(
    `test lock: test files changed after the reproduction commit ${short}:\n` +
      changed
        .split("\n")
        .map((f) => `  ${f}`)
        .join("\n") +
      "\nThe fix has to make the committed test pass, not change it.",
  );
  process.exit(1);
}

// Run the tests as they were at the reproduction commit. They have to fail there.
const tree = mkdtempSync(path.join(tmpdir(), "safe-to-merge-lock-"));
let reproduces = false;
try {
  execFileSync("git", ["worktree", "add", "-q", "--detach", tree, lock.lockCommit], {
    cwd,
    stdio: "ignore",
  });
  const modules = path.join(cwd, "node_modules");
  if (existsSync(modules)) symlinkSync(modules, path.join(tree, "node_modules"));
  // A clean environment for the runner: NODE_TEST_CONTEXT from an outer `node --test` would
  // change how this one reports.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync("node", ["--test", "test/**/*.test.ts"], {
    cwd: tree,
    encoding: "utf8",
    env,
  });
  reproduces = run.status !== 0;
} finally {
  spawnSync("git", ["worktree", "remove", "--force", tree], { cwd, stdio: "ignore" });
  rmSync(tree, { recursive: true, force: true });
}

if (!reproduces) {
  console.error(
    `test lock: the tests pass at the reproduction commit ${short}, so it doesn't reproduce ` +
      "anything. The first test commit on a fix/* branch must fail because of the bug.",
  );
  process.exit(1);
}
console.log(`test lock: the reproduction fails at ${short} and the tests are unchanged since`);
