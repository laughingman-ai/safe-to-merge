import assert from "node:assert/strict";
import { test } from "node:test";

import { dueDate, isOverdue, type Invoice } from "../src/invoice.ts";

const invoice: Invoice = { number: "INV-1042", issuedOn: "2026-10-05", netBusinessDays: 10 };

test("due date follows the invoice terms", () => {
  assert.equal(dueDate({ ...invoice, netBusinessDays: 3 }), "2026-10-08");
});

test("an invoice is overdue only after its due date", () => {
  const terms = { ...invoice, netBusinessDays: 3 };
  assert.equal(isOverdue(terms, "2026-10-08"), false);
  assert.equal(isOverdue(terms, "2026-10-09"), true);
});
