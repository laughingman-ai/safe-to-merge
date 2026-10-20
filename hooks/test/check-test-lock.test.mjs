// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { git, HOOKS, makeRepo } from "./helpers.mjs";

const SCRIPT = path.join(HOOKS, "..", "scripts", "check-test-lock.mjs");

function check(/** @type {string} */ cwd) {
  const env = { ...process.env };
  delete env.GITHUB_HEAD_REF;
  return spawnSync("node", [SCRIPT], { cwd, encoding: "utf8", env });
}

test("passes when only code changed after the reproduction", () => {
  const repo = makeRepo({ branch: "fix/weekend", testCommit: true });
  writeFileSync(path.join(repo, "src", "math.ts"), "export const one = 1 + 0;\n");
  git(repo, ["commit", "-q", "-am", "fix: the bug"]);
  const result = check(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tests unchanged/);
});

test("fails when a test changed after the reproduction", () => {
  const repo = makeRepo({ branch: "fix/weekend", testCommit: true });
  writeFileSync(path.join(repo, "test", "math.test.ts"), "// weakened\n");
  git(repo, ["commit", "-q", "-am", "fix: make it pass"]);
  const result = check(repo);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test\/math\.test\.ts/);
});

test("has nothing to check off fix/* branches", () => {
  const result = check(makeRepo({ branch: "feat/other", testCommit: true }));
  assert.equal(result.status, 0);
});
