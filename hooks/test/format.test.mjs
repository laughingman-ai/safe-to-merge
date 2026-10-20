// @ts-check
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { makeRepo, runHook } from "./helpers.mjs";

test("formats the file that was just edited", () => {
  const repo = makeRepo({ nodeModules: true });
  const file = path.join(repo, "src", "messy.ts");
  writeFileSync(file, "export   const  a={b:1,c:[1,2,3]}\n");
  const result = runHook(
    "format.mjs",
    { tool_name: "Write", tool_input: { file_path: file } },
    { cwd: repo },
  );
  assert.equal(result.status, 0);
  assert.equal(readFileSync(file, "utf8"), "export const a = { b: 1, c: [1, 2, 3] };\n");
});

test("leaves files it doesn't format alone", () => {
  const repo = makeRepo({ nodeModules: true });
  const file = path.join(repo, "notes.txt");
  writeFileSync(file, "a   b\n");
  const result = runHook(
    "format.mjs",
    { tool_name: "Write", tool_input: { file_path: file } },
    { cwd: repo },
  );
  assert.equal(result.status, 0);
  assert.equal(readFileSync(file, "utf8"), "a   b\n");
});

test("tells the agent when the file can't be parsed", () => {
  const repo = makeRepo({ nodeModules: true });
  const file = path.join(repo, "src", "broken.ts");
  writeFileSync(file, "export const = ;\n");
  const result = runHook(
    "format.mjs",
    { tool_name: "Write", tool_input: { file_path: file } },
    { cwd: repo },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /couldn't format src\/broken\.ts/);
});
