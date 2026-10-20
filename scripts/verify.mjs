#!/usr/bin/env node
// @ts-check
// The one command that decides whether work is done. CI runs it, and the Stop hook won't
// let an agent session end while it fails. Steps run in order and stop at the first failure.

import { spawnSync } from "node:child_process";

const STEPS = [
  ["lint", "npm run --silent lint"],
  ["typecheck", "npm run --silent typecheck"],
  ["test", "npm run --silent test"],
  ["test:hooks", "npm run --silent test:hooks"],
  ["check:test-lock", "npm run --silent check:test-lock"],
];

for (const [name, command] of STEPS) {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    console.log(`\nVERIFY FAILED at ${name}`);
    process.exit(1);
  }
  console.log(`ok  ${name}`);
}
console.log("VERIFY PASSED");
