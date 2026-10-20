#!/usr/bin/env node
// @ts-check
// The one command that decides whether work is done. CI runs it directly, and the Stop hook
// won't let an agent session end while it fails. It calls the tools itself rather than npm
// scripts, so editing package.json can't redefine "done" (package.json is a gate anyway).
// Steps run in order and stop at the first failure.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = (/** @type {string} */ name) => path.join(root, "node_modules", ".bin", name);

/** @type {[string, string, string[]][]} */
const STEPS = [
  ["lint", bin("prettier"), ["--check", "--log-level", "warn", "."]],
  ["typecheck", bin("tsc"), ["--noEmit", "-p", "tsconfig.json"]],
  ["test", "node", ["--test", "--test-reporter=spec", "test/**/*.test.ts"]],
  ["test:hooks", "node", ["--test", "--test-reporter=spec", "hooks/test/*.test.mjs"]],
  ["check:test-lock", "node", ["scripts/check-test-lock.mjs"]],
];

for (const [name, command, args] of STEPS) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    if (result.error) console.error(String(result.error));
    console.log(`\nVERIFY FAILED at ${name}`);
    process.exit(1);
  }
  console.log(`ok  ${name}`);
}
console.log("VERIFY PASSED");
