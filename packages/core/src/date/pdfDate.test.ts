import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';

import { pdfDate, pdfDateFromDate, pdfDateString } from './pdfDate.ts';

describe('pdf dates', () => {
  it('serializes UTC and signed offsets without a trailing apostrophe', () => {
    const fields = { year: 1998, month: 12, day: 23, hour: 19, minute: 52, second: 0 };
    expect(pdfDateString(pdfDate({ ...fields, offset: 'Z' }))).toBe('D:19981223195200Z');
    expect(pdfDateString(pdfDate({ ...fields, offset: { sign: '-', hours: 8, minutes: 30 } }))).toBe("D:19981223195200-08'30");
    expect(pdfDateString(pdfDate({ ...fields, offset: { sign: '+', hours: 5, minutes: 45 } }))).toBe("D:19981223195200+05'45");
  });

  it('uses the offset local clock fields when converting a Date', () => {
    const date = new Date('2024-01-01T00:15:30.000Z');
    expect(pdfDateString(pdfDateFromDate(date, -210))).toBe("D:20231231204530-03'30");
    expect(pdfDateString(pdfDateFromDate(date, 345))).toBe("D:20240101060030+05'45");
    expect(pdfDateString(pdfDateFromDate(date, 0))).toBe('D:20240101001530Z');
  });

  it('rejects every out-of-range field and invalid calendar days', () => {
    const valid = { year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 59, offset: 'Z' as const };
    for (const wrong of [
      { year: -1 },
      { year: 10000 },
      { month: 0 },
      { month: 13 },
      { day: 0 },
      { day: 30 },
      { hour: 24 },
      { minute: 60 },
      { second: 60 },
      { second: 1.5 },
      { offset: { sign: '+' as const, hours: 24, minutes: 0 } },
      { offset: { sign: '-' as const, hours: 1, minutes: 60 } },
    ]) {
      expect(() => pdfDate({ ...valid, ...wrong })).toThrow(ValidationError);
    }
    expect(() => pdfDate({ ...valid, year: 2023 })).toThrow(ValidationError);
    expect(() => pdfDateFromDate(new Date(Number.NaN), 0)).toThrow(ValidationError);
    expect(() => pdfDateFromDate(new Date(), 1440)).toThrow(ValidationError);
  });
});
