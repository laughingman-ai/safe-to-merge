#!/usr/bin/env node
// @ts-check
// PreToolUse (Edit|Write|NotebookEdit): protects the gates, enforces the test lock, and
// keeps secrets out of the repo. Paths are resolved against the session's cwd and through
// symlinks, so a link to a gate counts as the gate.

import {
  deny,
  findSecret,
  GATE_REASON,
  guarded,
  isEnvFile,
  LOCKED_TEST_REASON,
  projectDir,
  readInput,
  repoPaths,
  testLock,
  touchesGate,
  touchesTests,
} from "./lib.mjs";

guarded(() => {
  const input = readInput();
  const tool = input.tool_input ?? {};
  const root = projectDir(input);
  const cwd = input.cwd || root;
  const file = tool.file_path ?? tool.notebook_path;
  if (typeof file !== "string") throw new Error(`${input.tool_name} call without a file path`);

  for (const rel of repoPaths(root, cwd, file)) {
    if (touchesGate(rel)) deny(`Blocked: ${rel}. ${GATE_REASON}`);
    if (isEnvFile(rel)) {
      deny(
        `Blocked: ${rel}. Secrets don't go in .env files in this repo; they are injected at ` +
          "run time from the vault. Use .env.example for variable names only.",
      );
    }
    if (touchesTests(rel) && testLock(root).locked) deny(`Blocked: ${rel}. ${LOCKED_TEST_REASON}`);
  }
  if (isEnvFile(file)) deny(`Blocked: ${file}. Secrets don't go in .env files in this repo.`);

  const written = [tool.content, tool.new_string, tool.new_source]
    .filter((v) => typeof v === "string")
    .join("\n");
  const secret = findSecret(written);
  if (secret) {
    deny(
      `Blocked: this change contains what looks like ${secret}. Never write credentials into ` +
        "files. Read them at run time from the vault instead.",
    );
  }
});
