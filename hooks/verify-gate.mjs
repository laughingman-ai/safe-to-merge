#!/usr/bin/env node
// @ts-check
// Stop: the session can't end while `node scripts/verify.mjs` fails. The failure goes back
// to the agent as the reason to keep working.
//
// It re-runs verify on every stop attempt, including when stop_hook_active is true (the
// agent is already continuing because of this hook): a red tree is red no matter how many
// times the agent tries to stop. Claude Code overrides the block after eight consecutive
// Stop-hook continuations with no tool call in between (each tool call resets the count),
// so an agent that has stopped trying is let out, with verify still red. CI runs the same
// verify, so that work can't merge.
//
// "onFailure" has no effect on Stop hooks, so this hook blocks on its own internal errors.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { projectDir, readInput } from "./lib.mjs";

const TAIL_LINES = 40;

/** Strip timings so the same failure always reads the same. */
export function clean(/** @type {string} */ output) {
  return output
    .split("\n")
    .filter((l) => !/^\s*ℹ duration_ms/.test(l))
    .map((l) => l.replace(/\s*\(\d+(?:\.\d+)?m?s\)/g, "").trimEnd())
    .join("\n")
    .trim();
}

function block(/** @type {string} */ reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const input = readInput();
    const root = projectDir(input);
    const result = spawnSync("node", [path.join(root, "scripts", "verify.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 600_000,
    });
    if (result.status !== 0) {
      const output = clean(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      const tail = output.split("\n").slice(-TAIL_LINES).join("\n");
      block(
        "Verify failed (node scripts/verify.mjs), so this session can't end yet. " +
          `Fix the failure below and finish again.\n\n${tail}`,
      );
    }
  } catch (error) {
    block(
      `The verify gate hit an internal error (${error instanceof Error ? error.message : error}), ` +
        "so it can't confirm the work is done. Report this to the user.",
    );
  }
  process.exit(0);
}
