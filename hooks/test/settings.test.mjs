// @ts-check
// The wiring: every hook the settings name exists, and the matchers cover the tools that
// can run commands or write files (names from code.claude.com/docs/en/tools-reference).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { REPO } from "./helpers.mjs";

const settings = JSON.parse(readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
const groups = (/** @type {string} */ event) => /** @type {any[]} */ (settings.hooks[event] ?? []);
const covered = (/** @type {string} */ event) =>
  new Set(groups(event).flatMap((g) => String(g.matcher ?? "").split("|")));

test("every hook script the settings name exists", () => {
  for (const event of Object.keys(settings.hooks)) {
    for (const group of groups(event)) {
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command");
        for (const arg of hook.args ?? []) {
          const file = arg.replace("${CLAUDE_PROJECT_DIR}", REPO);
          assert.ok(existsSync(file), `${event}: ${arg} doesn't exist`);
        }
      }
    }
  }
});

test("PreToolUse covers every tool that runs commands or writes files", () => {
  const tools = covered("PreToolUse");
  for (const tool of ["Bash", "Monitor", "PowerShell", "Edit", "Write", "NotebookEdit"]) {
    assert.ok(tools.has(tool), `PreToolUse doesn't match ${tool}`);
  }
});

test("PreToolUse hooks fail closed", () => {
  for (const group of groups("PreToolUse")) {
    for (const hook of group.hooks) assert.equal(hook.onFailure, "block", group.matcher);
  }
});

test("the verify gate runs on Stop", () => {
  const args = groups("Stop").flatMap((g) => g.hooks.flatMap((/** @type {any} */ h) => h.args));
  assert.ok(args.some((a) => a.endsWith("hooks/verify-gate.mjs")));
});
