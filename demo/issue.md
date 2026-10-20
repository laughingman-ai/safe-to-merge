# Invoice due date lands on a Saturday

Invoice INV-1042 was issued Thursday, October 1, 2026 on Net 2 business days terms. The due
date shows as Saturday, October 3. It should be Monday, October 5.
Friday invoices on Net 1 do the same thing: due Saturday instead of Monday.

Steps: `addBusinessDays("2026-10-01", 2)` returns `"2026-10-03"`.

Expected: a due date is always a business day.
