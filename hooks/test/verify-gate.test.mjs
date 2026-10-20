// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { clean } from "../verify-gate.mjs";
import { makeRepo, runHook } from "./helpers.mjs";

/** A repo whose scripts/verify.mjs runs `body`. */
function repoWithVerify(/** @type {string} */ body) {
  const repo = makeRepo();
  mkdirSync(path.join(repo, "scripts"));
  writeFileSync(path.join(repo, "scripts", "verify.mjs"), body);
  return repo;
}

const stop = (/** @type {string} */ root, active = false) =>
  runHook("verify-gate.mjs", { hook_event_name: "Stop", stop_hook_active: active }, { root });

test("lets the session end when verify passes", () => {
  const result = stop(repoWithVerify("process.exit(0);\n"));
  assert.equal(result.status, 0);
  assert.equal(result.json, null);
});

test("blocks the session from ending when verify fails, with the failure as the reason", () => {
  const repo = repoWithVerify(
    'console.log("✖ a due date never lands on a weekend (1.234ms)");\nprocess.exit(1);\n',
  );
  const result = stop(repo);
  assert.equal(result.json.decision, "block");
  assert.match(result.json.reason, /can't end yet/);
  assert.match(result.json.reason, /✖ a due date never lands on a weekend$/m);
});

test("still blocks when the agent is already continuing because of this hook", () => {
  const result = stop(repoWithVerify("process.exit(1);\n"), true);
  assert.equal(result.json.decision, "block");
});

test("blocks on its own internal errors", () => {
  const result = runHook("verify-gate.mjs", "{oops", { root: makeRepo() });
  assert.equal(result.json.decision, "block");
  assert.match(result.json.reason, /internal error/);
});

test("blocks when there is no verify script", () => {
  assert.equal(stop(makeRepo()).json.decision, "block");
});

test("strips timings so the same failure always reads the same", () => {
  assert.equal(clean("✔ ok (0.5ms)\n✖ bad (12ms)\nℹ duration_ms 87.4\n"), "✔ ok\n✖ bad");
});
