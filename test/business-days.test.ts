import assert from "node:assert/strict";
import { test } from "node:test";

import { addBusinessDays, isBusinessDay, parseISODate } from "../src/business-days.ts";

test("weekdays are business days and weekends are not", () => {
  assert.equal(isBusinessDay("2026-10-05"), true); // Monday
  assert.equal(isBusinessDay("2026-10-03"), false); // Saturday
  assert.equal(isBusinessDay("2026-10-04"), false); // Sunday
});

test("a listed holiday is not a business day", () => {
  assert.equal(isBusinessDay("2026-11-26", new Set(["2026-11-26"])), false);
});

test("adds business days within a week", () => {
  assert.equal(addBusinessDays("2026-10-05", 1), "2026-10-06"); // Mon + 1 = Tue
  assert.equal(addBusinessDays("2026-10-06", 3), "2026-10-09"); // Tue + 3 = Fri
});

test("skips the weekend when counting", () => {
  assert.equal(addBusinessDays("2026-10-02", 3), "2026-10-07"); // Fri + 3 = Wed
});

test("skips holidays when counting", () => {
  // Mon + 2 with Tuesday off = Thu
  assert.equal(addBusinessDays("2026-10-05", 2, new Set(["2026-10-06"])), "2026-10-08");
});

test("zero days returns the start date", () => {
  assert.equal(addBusinessDays("2026-10-05", 0), "2026-10-05");
});

test("rejects bad input", () => {
  assert.throws(() => addBusinessDays("2026-10-05", -1), RangeError);
  assert.throws(() => addBusinessDays("2026-10-05", 1.5), RangeError);
  assert.throws(() => parseISODate("10/05/2026"), RangeError);
  assert.throws(() => parseISODate("2026-02-30"), RangeError);
});
