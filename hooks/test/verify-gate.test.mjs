// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { clean } from "../verify-gate.mjs";
import { makeRepo, runHook } from "./helpers.mjs";

const stop = (/** @type {string} */ command) =>
  runHook(
    "verify-gate.mjs",
    { hook_event_name: "Stop", stop_hook_active: false },
    {
      cwd: makeRepo(),
      env: { SAFE_TO_MERGE_VERIFY_CMD: command },
    },
  );

test("lets the session end when verify passes", () => {
  const result = stop("node -e 'process.exit(0)'");
  assert.equal(result.status, 0);
  assert.equal(result.json, null);
});

test("blocks the session from ending when verify fails, with the failure as the reason", () => {
  const result = stop(
    `node -e 'console.log("✖ a due date never lands on a weekend (1.234ms)"); process.exit(1)'`,
  );
  assert.equal(result.status, 0);
  assert.equal(result.json.decision, "block");
  assert.match(result.json.reason, /can't end yet/);
  assert.match(result.json.reason, /✖ a due date never lands on a weekend$/m);
});

test("strips timings so the same failure always reads the same", () => {
  assert.equal(clean("✔ ok (0.5ms)\n✖ bad (12ms)\nℹ duration_ms 87.4\n"), "✔ ok\n✖ bad");
});
