import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';

import { parsePdfDate, pdfDate, pdfDateFromDate, pdfDateString } from './pdfDate.ts';

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

interface DateFields {
  readonly date: string;
  readonly precision: string;
  readonly zone: string;
}

const fields = (text: string): DateFields | undefined => {
  const parsed = parsePdfDate(text);
  return parsed === undefined ? undefined : { date: pdfDateString(parsed.date), precision: parsed.precision, zone: parsed.zone };
};

describe('reading pdf dates', () => {
  it('fills omitted fields with the defaults and records the precision', () => {
    expect(['D:1998', 'D:199812', 'D:19981223', 'D:1998122319', 'D:199812231952', 'D:19981223195230'].map(text => fields(text))).toStrictEqual([
      { date: 'D:19980101000000Z', precision: 'year', zone: 'absent' },
      { date: 'D:19981201000000Z', precision: 'month', zone: 'absent' },
      { date: 'D:19981223000000Z', precision: 'day', zone: 'absent' },
      { date: 'D:19981223190000Z', precision: 'hour', zone: 'absent' },
      { date: 'D:19981223195200Z', precision: 'minute', zone: 'absent' },
      { date: 'D:19981223195230Z', precision: 'second', zone: 'absent' },
    ]);
  });

  it('reads Z, signed offsets with and without minutes, and the trailing apostrophe writers add', () => {
    expect(
      ['D:19981223195200Z', "D:199812231952-08'00", "D:20240101090000+09'00'", 'D:20240101090000+09', "D:20240101090000+05'", "D:20240101090000Z00'00'"].map(
        text => fields(text),
      ),
    ).toStrictEqual([
      { date: 'D:19981223195200Z', precision: 'second', zone: 'explicit' },
      { date: "D:19981223195200-08'00", precision: 'minute', zone: 'explicit' },
      { date: "D:20240101090000+09'00", precision: 'second', zone: 'explicit' },
      { date: "D:20240101090000+09'00", precision: 'second', zone: 'explicit' },
      { date: "D:20240101090000+05'00", precision: 'second', zone: 'explicit' },
      { date: 'D:20240101090000Z', precision: 'second', zone: 'explicit' },
    ]);
  });

  it('rejects every other form', () => {
    const rejected = [
      '',
      'D:',
      '19981223195200Z',
      'D:98',
      'D:1998122',
      'D:19981323',
      'D:19980230',
      'D:19981223245200',
      'D:19981223195260',
      'D:19981223195200X',
      'D:19981223195200+0800',
      "D:19981223195200+08'0",
      "D:19981223195200+24'00",
      "D:19981223195200+08'60",
      "D:19981223195200Z05'00",
      "D:19981223195200+08'00'00",
      'D:19981223195200Z ',
      ' D:19981223195200Z',
      'D:１９９８',
    ];
    expect(rejected.filter(text => parsePdfDate(text) !== undefined)).toStrictEqual([]);
  });
});
