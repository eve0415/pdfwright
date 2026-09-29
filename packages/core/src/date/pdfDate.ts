import type { PdfDirectObject } from '../object/pdfObject.ts';

import { ValidationError } from '../error/validationError.ts';
import { pdfString } from '../object/pdfObject.ts';

/** Calendar fields for `pdfDate`: year 0–9999, month 1–12, valid day, 24-hour clock, and a UTC offset up to 23:59; invalid fields raise ValidationError without a reason under ISO 32000-1:2008, 7.9.4. */
export interface PdfDateComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly offset: 'Z' | { readonly sign: '+' | '-'; readonly hours: number; readonly minutes: number };
}

/** A validated immutable PDF date created by `pdfDate`; all fields are required and ISO 32000-1:2008, 7.9.4 supplies the serialized form. */
export interface PdfDate extends PdfDateComponents {
  readonly kind: 'pdfDate';
}

const inRange = (value: number, minimum: number, maximum: number): boolean => Number.isInteger(value) && value >= minimum && value <= maximum;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
};

/** Validates calendar components and creates an immutable PDF date. */
export const pdfDate = (components: PdfDateComponents): PdfDate => {
  // ISO 32000-1:2008, 7.9.4 gives the ranges for month, day, clock fields, and UTC offset fields.
  const { year, month, day, hour, minute, second, offset } = components;
  if (
    !inRange(year, 0, 9999) ||
    !inRange(month, 1, 12) ||
    !inRange(day, 1, 31) ||
    !inRange(hour, 0, 23) ||
    !inRange(minute, 0, 59) ||
    !inRange(second, 0, 59)
  ) {
    throw new ValidationError('PDF date has an out-of-range field');
  }
  if (day > daysInMonth(year, month)) throw new ValidationError('Writer policy: PDF date must name an actual calendar day');
  if (offset !== 'Z' && (!['+', '-'].includes(offset.sign) || !inRange(offset.hours, 0, 23) || !inRange(offset.minutes, 0, 59))) {
    throw new ValidationError('PDF date has an out-of-range UTC offset');
  }
  return Object.freeze({ ...components, kind: 'pdfDate' });
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// ISO 32000-1:2008, 7.9.4 uses local clock fields and places an apostrophe between offset hours and minutes, with none after the minutes.
/** Formats a PDF date with its UTC offset (ISO 32000-1:2008, 7.9.4). */
export const pdfDateString = (date: PdfDate): string => {
  const clock = `${pad(date.year, 4)}${pad(date.month, 2)}${pad(date.day, 2)}${pad(date.hour, 2)}${pad(date.minute, 2)}${pad(date.second, 2)}`;
  const offset = date.offset === 'Z' ? 'Z' : `${date.offset.sign}${pad(date.offset.hours, 2)}'${pad(date.offset.minutes, 2)}`;
  return `D:${clock}${offset}`;
};

export const pdfDateObject = (date: PdfDate): PdfDirectObject => pdfString(new TextEncoder().encode(pdfDateString(date)));

/** Creates a PDF date from a JavaScript Date and a UTC offset in minutes. */
export const pdfDateFromDate = (date: Date, offsetMinutes: number): PdfDate => {
  if (!Number.isFinite(date.getTime()) || !inRange(offsetMinutes, -1439, 1439)) throw new ValidationError('invalid date or UTC offset');
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const absolute = Math.abs(offsetMinutes);
  const offset: PdfDateComponents['offset'] =
    offsetMinutes === 0 ? 'Z' : { sign: offsetMinutes < 0 ? '-' : '+', hours: Math.floor(absolute / 60), minutes: absolute % 60 };
  return pdfDate({
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    offset,
  });
};

/** The last clock field present in a parsed date, from year through second; omitted fields take the defaults described by ISO 32000-1:2008, 7.9.4. */
export type PdfDatePrecision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** A parsed PDF date with its supplied precision and whether a zone was explicit; missing month and day become 01, time fields become zero, and the zone becomes Z under ISO 32000-1:2008, 7.9.4. */
export interface ParsedPdfDate {
  /** The date with omitted fields at their defaults: month and day 01, the rest zero, and Z when no offset is given. */
  readonly date: PdfDate;
  /** The last clock field the string gives. */
  readonly precision: PdfDatePrecision;
  /** Whether the string gives its relationship to UT. */
  readonly zone: 'explicit' | 'absent';
}

const PRECISIONS: readonly PdfDatePrecision[] = ['year', 'month', 'day', 'hour', 'minute', 'second'];

// ISO 32000-1:2008, 7.9.4: "The prefix D: shall be present, the year field (YYYY) shall be present and all other fields may be present but only if all of their preceding fields are also present."
// The offset is O, then HH, then an apostrophe and mm; an apostrophe after mm, which many writers add, is tolerated.
const DATE_PATTERN = /^D:(\d{4})((?:\d{2}){0,5})(?:([Z+-])(?:(\d{2})(?:'(?:(\d{2})'?)?)?)?)?$/u;

const clockInRange = (components: PdfDateComponents): boolean => {
  const { year, month, day, hour, minute, second, offset } = components;
  const offsetInRange = offset === 'Z' || (inRange(offset.hours, 0, 23) && inRange(offset.minutes, 0, 59));
  return (
    inRange(month, 1, 12) &&
    inRange(day, 1, daysInMonth(year, month)) &&
    inRange(hour, 0, 23) &&
    inRange(minute, 0, 59) &&
    inRange(second, 0, 59) &&
    offsetInRange
  );
};

/**
 * Reads a date string of ISO 32000-1:2008, 7.9.4, in which every field after the year may be omitted; undefined for any other string, including one that names no actual calendar day.
 * "If no UT information is specified, the relationship of the specified time to UT shall be considered to be GMT", so such a date reads with offset Z and zone 'absent'.
 */
export const parsePdfDate = (text: string): ParsedPdfDate | undefined => {
  const match = DATE_PATTERN.exec(text);
  if (match === null) return undefined;
  const [, year = '', clock = '', sign, offsetHours = '00', offsetMinutes = '00'] = match;
  const numbers = [year, ...(clock.match(/\d{2}/gu) ?? [])].map(Number);
  const [, month = 1, day = 1, hour = 0, minute = 0, second = 0] = numbers;
  const hours = Number(offsetHours);
  const minutes = Number(offsetMinutes);
  // 7.9.4: "LATIN CAPITAL LETTER Z signifies that local time is equal to UT", so any offset after Z is zero.
  if (sign === 'Z' && hours + minutes > 0) return undefined;
  const offset: PdfDateComponents['offset'] = sign === '+' || sign === '-' ? { sign, hours, minutes } : 'Z';
  const components = { year: Number(year), month, day, hour, minute, second, offset };
  if (!clockInRange(components)) return undefined;
  return { date: pdfDate(components), precision: PRECISIONS[numbers.length - 1] ?? 'year', zone: sign === undefined ? 'absent' : 'explicit' };
};
