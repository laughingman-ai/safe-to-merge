#!/usr/bin/env node
// @ts-check
// PostToolUse (Edit|Write): format the file the agent just changed, so formatting never
// shows up in review or fails the lint step. PostToolUse can't block (the edit already
// happened); exit 2 shows the problem to the agent.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { projectDir, readInput, repoPaths } from "./lib.mjs";

const FORMATTED = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|css|html)$/;

try {
  const input = readInput();
  const root = projectDir(input);
  const file = input.tool_input?.file_path;
  const rel = typeof file === "string" ? repoPaths(root, input.cwd || root, file)[0] : undefined;
  const prettier = path.join(root, "node_modules", ".bin", "prettier");

  if (rel && FORMATTED.test(rel) && existsSync(path.join(root, rel)) && existsSync(prettier)) {
    const result = spawnSync(prettier, ["--write", "--log-level", "warn", rel], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(`Prettier couldn't format ${rel}:\n${result.stderr || result.stdout}`);
      process.exit(2);
    }
  }
} catch (error) {
  process.stderr.write(`The format hook failed: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
process.exit(0);
