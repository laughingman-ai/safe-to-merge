// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import { denied, makeRepo, runHook } from "./helpers.mjs";

/** @param {string} cwd @param {string} tool @param {Record<string, unknown>} toolInput */
const edit = (cwd, tool, toolInput) =>
  denied(
    runHook(
      "guard-files.mjs",
      {
        tool_name: tool,
        tool_input: { ...toolInput, file_path: path.join(cwd, String(toolInput.file_path)) },
      },
      { cwd },
    ),
  );

// Built at run time so this file never contains a real-looking credential.
const FAKE_AWS_KEY = "AKIA" + "Q".repeat(16);
const FAKE_PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY-----\nabc\n";

describe("gates", () => {
  const repo = makeRepo({ branch: "fix/weekend" });

  test("blocks edits to the hook settings and the hooks", () => {
    assert.match(
      edit(repo, "Edit", {
        file_path: ".claude/settings.json",
        old_string: "a",
        new_string: "b",
      }) ?? "",
      /part of the gates/,
    );
    assert.match(
      edit(repo, "Write", { file_path: "hooks/guard-bash.mjs", content: "" }) ?? "",
      /part of the gates/,
    );
    assert.match(
      edit(repo, "Write", { file_path: ".github/workflows/verify.yml", content: "" }) ?? "",
      /part of the gates/,
    );
  });
});

describe("secrets", () => {
  const repo = makeRepo();

  test("blocks .env files but allows .env.example", () => {
    assert.match(edit(repo, "Write", { file_path: ".env", content: "A=1" }) ?? "", /\.env/);
    assert.match(
      edit(repo, "Write", { file_path: "config/.env.local", content: "A=1" }) ?? "",
      /\.env/,
    );
    assert.equal(edit(repo, "Write", { file_path: ".env.example", content: "A=" }), null);
  });

  test("blocks credentials in written content", () => {
    assert.match(
      edit(repo, "Write", { file_path: "src/aws.ts", content: `const key = "${FAKE_AWS_KEY}";` }) ??
        "",
      /AWS access key/,
    );
    assert.match(
      edit(repo, "Edit", {
        file_path: "src/k.ts",
        old_string: "x",
        new_string: FAKE_PRIVATE_KEY,
      }) ?? "",
      /private key/,
    );
  });

  test("allows ordinary code", () => {
    assert.equal(
      edit(repo, "Write", { file_path: "src/math.ts", content: "export const two = 2;\n" }),
      null,
    );
  });
});

describe("test lock", () => {
  const change = {
    file_path: "test/math.test.ts",
    old_string: "// tests",
    new_string: "// changed",
  };

  test("tests are editable until the reproduction is committed", () => {
    assert.equal(edit(makeRepo({ branch: "fix/weekend" }), "Edit", change), null);
  });

  test("tests are locked once the reproduction is committed", () => {
    const repo = makeRepo({ branch: "fix/weekend", testCommit: true });
    assert.match(edit(repo, "Edit", change) ?? "", /locked/);
    assert.equal(
      edit(repo, "Edit", { file_path: "src/math.ts", old_string: "1", new_string: "2" }),
      null,
    );
  });

  test("only fix/* branches lock tests", () => {
    assert.equal(edit(makeRepo({ branch: "feat/other", testCommit: true }), "Edit", change), null);
  });
});
