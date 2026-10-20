#!/usr/bin/env node
// @ts-check
// Apply a recorded Edit tool call to the file it names, the way Claude Code's Edit tool would.
// Usage: node demo/apply-edit.mjs <fixture.json> <repo-dir>

import { readFileSync, writeFileSync } from "node:fs";

const [fixture, repo] = process.argv.slice(2);
if (!fixture || !repo) throw new Error("usage: apply-edit.mjs <fixture.json> <repo-dir>");
const { tool_input: edit } = JSON.parse(readFileSync(fixture, "utf8").replaceAll("__REPO__", repo));
const before = readFileSync(edit.file_path, "utf8");
if (before.split(edit.old_string).length !== 2) {
  throw new Error(`old_string must appear exactly once in ${edit.file_path}`);
}
writeFileSync(
  edit.file_path,
  before.replace(edit.old_string, () => edit.new_string),
);
