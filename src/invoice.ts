import { addBusinessDays, parseISODate, type ISODate } from "./business-days.ts";

export interface Invoice {
  number: string;
  issuedOn: ISODate;
  /** Payment terms, e.g. 10 for "Net 10 business days". */
  netBusinessDays: number;
}

/** When payment is due under the invoice's terms. */
export function dueDate(invoice: Invoice, holidays: ReadonlySet<ISODate> = new Set()): ISODate {
  return addBusinessDays(invoice.issuedOn, invoice.netBusinessDays, holidays);
}

/** Whether the invoice is unpaid past its due date as of `today`. */
export function isOverdue(
  invoice: Invoice,
  today: ISODate,
  holidays: ReadonlySet<ISODate> = new Set(),
): boolean {
  return parseISODate(today) > parseISODate(dueDate(invoice, holidays));
}
