// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { env, git, HOOKS, makeRepo } from "./helpers.mjs";

const SCRIPT = path.join(HOOKS, "..", "scripts", "check-test-lock.mjs");
const check = (/** @type {string} */ cwd) =>
  spawnSync("node", [SCRIPT], { cwd, encoding: "utf8", env: env() });

test("passes when the reproduction fails at its commit and only code changed after", () => {
  const repo = makeRepo({ branch: "fix/weekend", testCommit: true, nodeModules: true });
  writeFileSync(path.join(repo, "src", "math.ts"), "export const one = 1 + 0;\n");
  git(repo, ["commit", "-q", "-am", "fix: the bug"]);
  const result = check(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reproduction fails/);
});

test("fails when a test changed after the reproduction", () => {
  const repo = makeRepo({ branch: "fix/weekend", testCommit: true, nodeModules: true });
  writeFileSync(path.join(repo, "test", "math.test.ts"), "// weakened\n");
  git(repo, ["commit", "-q", "-am", "fix: make it pass"]);
  const result = check(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test\/math\.test\.ts/);
});

test("fails when the reproduction passes at its own commit", () => {
  const result = check(
    makeRepo({ branch: "fix/weekend", testCommit: "passing", nodeModules: true }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /doesn't reproduce/);
});

test("fails on a fix/* branch with no reproduction", () => {
  const result = check(makeRepo({ branch: "fix/weekend" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no reproduction/);
});

test("has nothing to check off fix/* branches", () => {
  assert.equal(check(makeRepo({ branch: "feat/other", testCommit: true })).status, 0);
});
