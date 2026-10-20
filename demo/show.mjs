#!/usr/bin/env node
// @ts-check
// Print a hook's decision in a few readable lines. Reads the hook's stdout on stdin.
// Usage: node hooks/x.mjs < fixture | node demo/show.mjs

import { readFileSync } from "node:fs";

const WIDTH = 96;
const INDENT = " ".repeat(12);

/** Word-wrap `text` to WIDTH, indenting continuation lines under the label. */
function wrap(/** @type {string} */ text) {
  const lines = [""];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if ((INDENT + lines[last] + " " + word).length > WIDTH && lines[last]) lines.push(word);
    else lines[last] = lines[last] ? `${lines[last]} ${word}` : word;
  }
  return lines.join(`\n${INDENT}`);
}

const raw = readFileSync(0, "utf8").trim();
const out = raw ? JSON.parse(raw) : {};
const pre = out.hookSpecificOutput;

if (pre?.permissionDecision === "deny") {
  console.log(`   BLOCKED  ${wrap(pre.permissionDecisionReason.replace(/^Blocked: /, ""))}`);
} else if (out.decision === "block") {
  const lines = out.reason.split("\n").map((/** @type {string} */ l) => l.trim());
  const detail = lines.filter((/** @type {string} */ l) =>
    /^(✖ (?!failing tests:)|actual: |expected: |VERIFY FAILED)/.test(l),
  );
  console.log(`   BLOCKED  ${wrap(lines[0])}`);
  for (const line of new Set(detail)) console.log(`${INDENT}${line}`);
} else {
  console.log("   allowed");
}
