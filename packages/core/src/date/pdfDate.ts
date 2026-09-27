import type { PdfObject } from '../object/pdfObject.ts';

import { ValidationError } from '../error/validationError.ts';
import { pdfString } from '../object/pdfObject.ts';

export interface PdfDateComponents {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly offset: 'Z' | { readonly sign: '+' | '-'; readonly hours: number; readonly minutes: number };
}

export interface PdfDate extends PdfDateComponents {
  readonly kind: 'pdfDate';
}

const inRange = (value: number, minimum: number, maximum: number): boolean => Number.isInteger(value) && value >= minimum && value <= maximum;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
};

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
export const pdfDateString = (date: PdfDate): string => {
  const clock = `${pad(date.year, 4)}${pad(date.month, 2)}${pad(date.day, 2)}${pad(date.hour, 2)}${pad(date.minute, 2)}${pad(date.second, 2)}`;
  const offset = date.offset === 'Z' ? 'Z' : `${date.offset.sign}${pad(date.offset.hours, 2)}'${pad(date.offset.minutes, 2)}`;
  return `D:${clock}${offset}`;
};

export const pdfDateObject = (date: PdfDate): PdfObject => pdfString(new TextEncoder().encode(pdfDateString(date)));

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
