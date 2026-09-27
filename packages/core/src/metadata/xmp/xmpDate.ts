import type { ParsedPdfDate, PdfDate, PdfDateComponents, PdfDatePrecision } from '../../date/pdfDate.ts';

import { parsePdfDate } from '../../date/pdfDate.ts';

export interface XmpDate {
  /** The date with omitted fields at their defaults, and offset Z when the value has no time zone designator. */
  readonly date: PdfDate;
  readonly precision: Exclude<PdfDatePrecision, 'hour'>;
  /** Whether the value has a time zone designator; a value without a time has none. */
  readonly zone: 'explicit' | 'absent';
}

// XMP Part 1 8.2.1.2: YYYY, YYYY-MM, YYYY-MM-DD, YYYY-MM-DDThh:mmTZD, YYYY-MM-DDThh:mm:ssTZD, YYYY-MM-DDThh:mm:ss.sTZD, where "The time zone designator need not be present in XMP".
const XMP_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/u;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/** Reads an XMP date (XMP Part 1 8.2.1.2); undefined for any other text or a day that does not exist. */
export const parseXmpDate = (text: string): XmpDate | undefined => {
  const match = XMP_DATE.exec(text);
  if (match === null) return undefined;
  const [, year = '', month, day, hour, minute, second, zone] = match;
  const clock = `${year}${month ?? ''}${day ?? ''}${hour ?? ''}${minute ?? ''}${second ?? ''}`;
  const offset = zone === undefined || zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}'${zone.slice(4)}`;
  // The same fields as a PDF date string, which checks their ranges and the calendar day.
  const parsed = parsePdfDate(`D:${clock}${offset}`);
  if (parsed === undefined) return undefined;
  const precision = parsed.precision === 'hour' ? 'minute' : parsed.precision;
  return { date: parsed.date, precision, zone: zone === undefined ? 'absent' : 'explicit' };
};

/** Writes a PDF date as an XMP date with seconds and its time zone designator, keeping the local time as XMP Part 1 8.2.1.2 recommends. */
export const xmpDateString = (date: PdfDate): string => {
  const { offset } = date;
  const zone = offset === 'Z' ? 'Z' : `${offset.sign}${pad(offset.hours, 2)}:${pad(offset.minutes, 2)}`;
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}T${pad(date.hour, 2)}:${pad(date.minute, 2)}:${pad(date.second, 2)}${zone}`;
};

const ORDER: readonly PdfDatePrecision[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];
const UNIT_MS: Readonly<Record<'hour' | 'minute' | 'second', number>> = { hour: 3_600_000, minute: 60_000, second: 1000 };

const offsetMinutes = (offset: PdfDateComponents['offset']): number =>
  offset === 'Z' ? 0 : (offset.sign === '-' ? -1 : 1) * (offset.hours * 60 + offset.minutes);

/** Milliseconds since 1970-01-01T00:00:00Z; years 0 to 99 are those years, not 1900 to 1999 as Date.UTC reads them. */
export const instant = (date: PdfDate): number => {
  const time = new Date(0);
  time.setUTCFullYear(date.year, date.month - 1, date.day);
  time.setUTCHours(date.hour, date.minute, date.second, 0);
  return time.getTime() - offsetMinutes(date.offset) * 60_000;
};

/**
 * Whether a PDF date and an XMP date name the same time at the coarser of their precisions.
 * Dates are compared by their fields; times as instants, with a PDF date without offset read as GMT (ISO 32000-1:2008, 7.9.4) and an XMP time without a designator as unknown, since XMP Part 1 8.2.1.2 says "an XMP processor should not assume anything about the missing time zone".
 */
export const compareDates = (pdf: ParsedPdfDate, xmp: XmpDate): 'equal' | 'different' | 'indeterminate' => {
  const precision = ORDER[Math.min(ORDER.indexOf(pdf.precision), ORDER.indexOf(xmp.precision))] ?? 'year';
  if (precision === 'year' || precision === 'month' || precision === 'day') {
    const count = ORDER.indexOf(precision) + 1;
    const fields = (date: PdfDate): string => [date.year, date.month, date.day].slice(0, count).join('-');
    const same = fields(pdf.date) === fields(xmp.date);
    return same ? 'equal' : 'different';
  }
  if (xmp.zone === 'absent') return 'indeterminate';
  // The coarser value names an hour or minute of its own local time, which a finer value must fall within; UTC hours would split an hour of a +05:30 zone.
  const [coarse, fine] = pdf.precision === precision ? [pdf, xmp] : [xmp, pdf];
  const start = instant(coarse.date);
  const at = instant(fine.date);
  if (fine.precision === precision) return start === at ? 'equal' : 'different';
  return at >= start && at < start + UNIT_MS[precision] ? 'equal' : 'different';
};
