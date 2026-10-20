#!/usr/bin/env node
// @ts-check
// Stop: the session can't end while `npm run verify` fails. The failure goes back to the
// agent as the reason to keep working. Claude Code caps consecutive Stop blocks (eight by
// default), so a failure the agent can't fix still ends with the agent reporting it.

import { spawnSync } from "node:child_process";
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();

function main() {
  const input = readInput();
  const root = projectDir(input);
  const command = process.env.SAFE_TO_MERGE_VERIFY_CMD || "npm run --silent verify";

  const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", timeout: 600_000 });
  if (result.status === 0) process.exit(0);

  const output = clean(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const tail = output.split("\n").slice(-TAIL_LINES).join("\n");
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason:
        `Verify failed (${command}), so this session can't end yet. ` +
        `Fix the failure below and finish again.\n\n${tail}`,
    }) + "\n",
  );
  process.exit(0);
}
