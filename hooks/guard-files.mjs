#!/usr/bin/env node
// @ts-check
// PreToolUse (Edit|Write|MultiEdit|NotebookEdit): protects the gates, enforces the test
// lock, and keeps secrets out of the repo.

import {
  deny,
  findSecret,
  GATE_REASON,
  isEnvFile,
  isGatePath,
  isTestPath,
  LOCKED_TEST_REASON,
  projectDir,
  readInput,
  repoPath,
  testLock,
} from "./lib.mjs";

const input = readInput();
const tool = input.tool_input ?? {};
const root = projectDir(input);
const file = tool.file_path ?? tool.notebook_path;

if (typeof file === "string") {
  const rel = repoPath(root, file);
  if (isGatePath(rel)) deny(`Blocked: ${rel}. ${GATE_REASON}`);
  if (isEnvFile(rel ?? file)) {
    deny(
      `Blocked: ${rel ?? file}. Secrets don't go in .env files in this repo; they are injected ` +
        "at run time from the vault. Use .env.example for variable names only.",
    );
  }
  if (isTestPath(rel) && testLock(root).locked) deny(`Blocked: ${rel}. ${LOCKED_TEST_REASON}`);
}

const written = [tool.content, tool.new_string, tool.new_source]
  .concat(Array.isArray(tool.edits) ? tool.edits.map((/** @type {any} */ e) => e.new_string) : [])
  .filter((v) => typeof v === "string")
  .join("\n");
const secret = findSecret(written);
if (secret) {
  deny(
    `Blocked: this change contains what looks like ${secret}. Never write credentials into ` +
      "files. Read them at run time from the vault instead.",
  );
}

process.exit(0);
