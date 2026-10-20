// @ts-check
import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { denied, makeRepo, runHook } from "./helpers.mjs";

/**
 * @param {string} root @param {string} tool @param {Record<string, unknown>} toolInput
 * @param {string} [cwd]
 */
const edit = (root, tool, toolInput, cwd = root) =>
  denied(runHook("guard-files.mjs", { tool_name: tool, tool_input: toolInput }, { root, cwd }));
const write = (/** @type {string} */ root, /** @type {string} */ file, content = "") =>
  edit(root, "Write", { file_path: path.join(root, file), content });

// Built at run time so this file never contains a real-looking credential.
const FAKE_AWS_KEY = "AKIA" + "Q".repeat(16);
const FAKE_PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY-----\nabc\n";

describe("gates", () => {
  const repo = makeRepo({ branch: "fix/weekend" });

  for (const file of [
    ".claude/settings.json",
    ".claude/settings.local.json",
    "hooks/guard-bash.mjs",
    ".github/workflows/verify.yml",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".prettierignore",
    ".prettierrc.json",
    "scripts/verify.mjs",
    "scripts/check-test-lock.mjs",
    "scripts/review-prompt.md",
    "scripts/run-reviewer.sh",
    "scripts/agent-token.mjs",
    "KNOWN_BUGS.md",
    "node_modules/.bin/tsc",
  ]) {
    test(`blocks writing ${file}`, () =>
      assert.match(write(repo, file) ?? "", /part of the gates/));
  }

  test("resolves relative paths against the session's cwd", () => {
    const hooks = path.join(repo, "hooks");
    assert.match(
      edit(repo, "Write", { file_path: "guard-bash.mjs", content: "" }, hooks) ?? "",
      /gates/,
    );
  });

  test("a symlink to a gate counts as the gate", () => {
    symlinkSync(path.join(repo, ".claude", "settings.json"), path.join(repo, "s.json"));
    assert.match(write(repo, "s.json", "{}") ?? "", /\.claude\/settings\.json/);
  });

  test("a NotebookEdit is checked like a write", () => {
    const result = edit(repo, "NotebookEdit", {
      notebook_path: path.join(repo, "hooks", "n.ipynb"),
      new_source: "",
    });
    assert.match(result ?? "", /gates/);
  });
});

describe("secrets", () => {
  const repo = makeRepo();

  test("blocks .env files but allows .env.example", () => {
    assert.match(write(repo, ".env", "A=1") ?? "", /\.env/);
    assert.match(write(repo, "config/.env.local", "A=1") ?? "", /\.env/);
    assert.match(write(repo, ".envrc", "export A=1") ?? "", /\.env/);
    assert.equal(write(repo, ".env.example", "A="), null);
  });

  test("blocks credentials in written content", () => {
    assert.match(
      write(repo, "src/aws.ts", `const key = "${FAKE_AWS_KEY}";`) ?? "",
      /AWS access key/,
    );
    const result = edit(repo, "Edit", {
      file_path: path.join(repo, "src/k.ts"),
      old_string: "x",
      new_string: FAKE_PRIVATE_KEY,
    });
    assert.match(result ?? "", /private key/);
  });

  test("allows ordinary code", () => {
    assert.equal(write(repo, "src/math.ts", "export const two = 2;\n"), null);
  });
});

describe("test lock", () => {
  const change = (/** @type {string} */ root) => ({
    file_path: path.join(root, "test/math.test.ts"),
    old_string: "one is one",
    new_string: "changed",
  });

  test("tests are editable until the reproduction is committed", () => {
    const repo = makeRepo({ branch: "fix/weekend" });
    assert.equal(edit(repo, "Edit", change(repo)), null);
  });

  test("tests are locked once the reproduction is committed", () => {
    const repo = makeRepo({ branch: "fix/weekend", testCommit: true });
    assert.match(edit(repo, "Edit", change(repo)) ?? "", /locked/);
    assert.match(write(repo, "test/new.test.ts") ?? "", /locked/);
    assert.equal(write(repo, "src/math.ts", "export const one = 1;\n"), null);
  });

  test("only fix/* branches lock tests", () => {
    const repo = makeRepo({ branch: "feat/other", testCommit: true });
    assert.equal(edit(repo, "Edit", change(repo)), null);
  });
});

describe("failing closed", () => {
  const repo = makeRepo();

  test("bad input blocks with exit 2", () => {
    const result = runHook("guard-files.mjs", "[", { root: repo });
    assert.equal(result.status, 2);
  });

  test("a call without a file path blocks", () => {
    assert.equal(
      runHook("guard-files.mjs", { tool_name: "Write", tool_input: {} }, { root: repo }).status,
      2,
    );
  });
});
