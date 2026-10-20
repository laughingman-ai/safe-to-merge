#!/usr/bin/env node
// @ts-check
// Print a hook's decision in one or two readable lines. Reads the hook's stdout on stdin.
// Usage: node hooks/x.mjs < fixture | node demo/show.mjs

import { readFileSync } from "node:fs";

const raw = readFileSync(0, "utf8").trim();
const out = raw ? JSON.parse(raw) : {};
const pre = out.hookSpecificOutput;

if (pre?.permissionDecision === "deny") {
  console.log(`   BLOCKED  ${pre.permissionDecisionReason}`);
} else if (out.decision === "block") {
  const [first] = out.reason.split("\n");
  const failures = [
    ...new Set(
      out.reason.split("\n").filter((/** @type {string} */ l) => /^\s*✖|VERIFY FAILED/.test(l)),
    ),
  ];
  console.log(`   BLOCKED  ${first}`);
  for (const line of failures) console.log(`            ${line.trim()}`);
} else {
  console.log("   allowed");
}
