/** A calendar date in ISO 8601 form, YYYY-MM-DD. Dates are treated as UTC days. */
export type ISODate = string;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseISODate(value: ISODate): Date {
  if (!ISO_DATE.test(value)) {
    throw new RangeError(`Expected a date like 2026-10-01, got "${value}"`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatISODate(date) !== value) {
    throw new RangeError(`Not a real calendar date: "${value}"`);
  }
  return date;
}

export function formatISODate(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Monday to Friday, and not in the holiday list. */
export function isBusinessDay(date: ISODate, holidays: ReadonlySet<ISODate> = new Set()): boolean {
  const weekday = parseISODate(date).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(date);
}

/** The date `days` business days after `start`. Zero days returns `start` unchanged. */
export function addBusinessDays(
  start: ISODate,
  days: number,
  holidays: ReadonlySet<ISODate> = new Set(),
): ISODate {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`Business days must be a whole number of zero or more, got ${days}`);
  }
  let current = parseISODate(start);
  let counted = 0;
  while (counted < days) {
    if (!isBusinessDay(formatISODate(current), holidays)) {
      current = addDays(current, 1);
      continue;
    }
    current = addDays(current, 1);
    counted += 1;
  }
  return formatISODate(current);
}
