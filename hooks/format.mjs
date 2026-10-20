#!/usr/bin/env node
// @ts-check
// PostToolUse (Edit|Write|MultiEdit): format the file the agent just changed, so
// formatting never shows up in review or fails the lint step.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { projectDir, readInput, repoPath } from "./lib.mjs";

const FORMATTED = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html)$/;

const input = readInput();
const root = projectDir(input);
const file = input.tool_input?.file_path;
const rel = typeof file === "string" ? repoPath(root, file) : null;
const prettier = path.join(root, "node_modules", ".bin", "prettier");

if (rel && FORMATTED.test(rel) && existsSync(path.join(root, rel)) && existsSync(prettier)) {
  const result = spawnSync(prettier, ["--write", "--log-level", "warn", rel], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    // Exit 2 on PostToolUse shows stderr to the agent; the edit itself already happened.
    process.stderr.write(`Prettier couldn't format ${rel}:\n${result.stderr || result.stdout}`);
    process.exit(2);
  }
}
process.exit(0);
