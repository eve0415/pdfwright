import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';

import { parsePdfDate, pdfDate, pdfDateFromDate, pdfDateObject, pdfDateString } from './pdfDate.ts';

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

  // ISO 32000-1:2008, 7.9.4 gives the field ranges; each row sits at a limit, so that moving the limit by one rejects it.
  it.each([
    [{ year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 59, offset: 'Z' }, 'D:20240229235959Z'],
    [{ year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }, 'D:00000101000000Z'],
    [{ year: 5, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }, 'D:00050101000000Z'],
    [{ year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59, offset: 'Z' }, 'D:99991231235959Z'],
    [{ year: 2000, month: 2, day: 29, hour: 0, minute: 0, second: 0, offset: 'Z' }, 'D:20000229000000Z'],
    [{ year: 2024, month: 4, day: 30, hour: 0, minute: 0, second: 0, offset: 'Z' }, 'D:20240430000000Z'],
    [{ year: 2024, month: 1, day: 31, hour: 0, minute: 0, second: 0, offset: 'Z' }, 'D:20240131000000Z'],
    [{ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: { sign: '+', hours: 23, minutes: 59 } }, "D:20240101000000+23'59"],
    [{ year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: { sign: '-', hours: 0, minutes: 1 } }, "D:20240101000000-00'01"],
  ] as const)('accepts %o as %s', (components, expected) => {
    expect(pdfDateString(pdfDate(components))).toBe(expected);
  });

  const valid = { year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 59, offset: 'Z' } as const;

  it.each([
    [{ year: -1 }],
    [{ year: 10_000 }],
    [{ year: 2024.5 }],
    [{ month: 0 }],
    [{ month: 13 }],
    [{ day: 0 }],
    [{ day: 30 }],
    [{ year: 2023 }],
    [{ year: 1900 }],
    [{ month: 4, day: 31 }],
    [{ month: 6, day: 31 }],
    [{ month: 9, day: 31 }],
    [{ month: 11, day: 31 }],
    [{ month: 1, day: 32 }],
    [{ hour: 24 }],
    [{ hour: -1 }],
    [{ minute: 60 }],
    [{ second: 60 }],
    [{ second: 1.5 }],
    [{ offset: { sign: '+', hours: 24, minutes: 0 } }],
    [{ offset: { sign: '-', hours: 1, minutes: 60 } }],
    [{ offset: { sign: '+', hours: -1, minutes: 0 } }],
    [{ offset: { sign: '+', hours: 1, minutes: 1.5 } }],
  ] as const)('rejects the valid date with %o', wrong => {
    expect(() => pdfDate({ ...valid, ...wrong })).toThrow(ValidationError);
  });

  it('rejects an offset sign outside its type', () => {
    // @ts-expect-error The sign is outside its type, as it can be in data from a JavaScript caller.
    expect(() => pdfDate({ ...valid, offset: { sign: '*', hours: 1, minutes: 0 } })).toThrow(ValidationError);
  });

  it('returns a frozen date that names its kind', () => {
    const date = pdfDate(valid);
    expect([Object.isFrozen(date), date.kind]).toStrictEqual([true, 'pdfDate']);
  });

  it('keeps the validated offset when the caller changes its offset object afterwards', () => {
    const offset = { sign: '+' as const, hours: 1, minutes: 0 };
    const date = pdfDate({ ...valid, offset });
    offset.hours = 99;
    expect([pdfDateString(date), date.offset !== 'Z' && Object.isFrozen(date.offset)]).toStrictEqual(["D:20240229235959+01'00", true]);
  });

  it('wraps the serialized date in a literal string object', () => {
    const date = pdfDate({ ...valid, offset: { sign: '-', hours: 8, minutes: 30 } });
    expect(pdfDateObject(date)).toStrictEqual({ kind: 'string', bytes: new TextEncoder().encode("D:20240229235959-08'30"), encoding: 'literal' });
  });

  it.each([
    ['2024-01-01T00:00:00.999Z', 0, 'D:20240101000000Z'],
    ['2024-01-01T00:00:00Z', 1439, "D:20240101235900+23'59"],
    ['2024-01-01T00:00:00Z', -1439, "D:20231231000100-23'59"],
    ['9999-12-31T23:59:59Z', 0, 'D:99991231235959Z'],
    ['0000-01-01T00:00:00Z', 0, 'D:00000101000000Z'],
  ])('converts %s at offset %s minutes, dropping milliseconds, as %s', (instant, offsetMinutes, expected) => {
    expect(pdfDateString(pdfDateFromDate(new Date(instant), offsetMinutes))).toBe(expected);
  });

  it.each([
    ['an invalid date', 0],
    ['2024-01-01T00:00:00Z', 1440],
    ['2024-01-01T00:00:00Z', -1440],
    ['2024-01-01T00:00:00Z', 1.5],
    ['9999-12-31T23:59:59Z', 1],
    ['0000-01-01T00:00:00Z', -1],
    ['+010000-01-01T00:00:00Z', 0],
  ])('rejects converting %s at offset %s minutes', (instant, offsetMinutes) => {
    expect(() => pdfDateFromDate(new Date(instant), offsetMinutes)).toThrow(ValidationError);
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

  it('reads leap days, the last day of a long month, the widest offset and an offset after any precision', () => {
    expect(['D:20240229', 'D:20000229', 'D:19981231', "D:20240101000000+23'59", 'D:1998Z', "D:199812-05'30"].map(text => fields(text))).toStrictEqual([
      { date: 'D:20240229000000Z', precision: 'day', zone: 'absent' },
      { date: 'D:20000229000000Z', precision: 'day', zone: 'absent' },
      { date: 'D:19981231000000Z', precision: 'day', zone: 'absent' },
      { date: "D:20240101000000+23'59", precision: 'second', zone: 'explicit' },
      { date: 'D:19980101000000Z', precision: 'year', zone: 'explicit' },
      { date: "D:19981201000000-05'30", precision: 'month', zone: 'explicit' },
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
      'D:20230229',
      'D:19000229',
      'D:19980431',
      'D:19980132',
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

// JavaScript's Date follows the proleptic Gregorian calendar, an implementation of month lengths independent of the one under test.
const daysInMonth = (year: number, month: number): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
};

describe('properties', () => {
  // A signed zero offset is left out: whether it reads back signed or as Z is not settled.
  const signedOffset = fc
    .record({ sign: fc.constantFrom('+', '-'), hours: fc.integer({ min: 0, max: 23 }), minutes: fc.integer({ min: 0, max: 59 }) })
    .filter(offset => offset.hours + offset.minutes > 0);

  const components = fc.record({ year: fc.integer({ min: 0, max: 9999 }), month: fc.integer({ min: 1, max: 12 }) }).chain(({ year, month }) =>
    fc.record({
      year: fc.constant(year),
      month: fc.constant(month),
      day: fc.integer({ min: 1, max: daysInMonth(year, month) }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
      offset: fc.oneof(fc.constant('Z' as const), signedOffset),
    }),
  );

  it('reads back every date it writes, at second precision with an explicit zone', () => {
    fc.assert(
      fc.property(components, value => {
        expect(parsePdfDate(pdfDateString(pdfDate(value)))).toStrictEqual({ date: pdfDate(value), precision: 'second', zone: 'explicit' });
      }),
    );
  });

  it('names the instant of the Date it converts, truncated to whole seconds', () => {
    const instant = fc.date({ min: new Date('0000-01-02T00:00:00Z'), max: new Date('9999-12-30T23:59:59.999Z'), noInvalidDate: true });
    fc.assert(
      fc.property(instant, fc.integer({ min: -1439, max: 1439 }), (date, offsetMinutes) => {
        const parsed = parsePdfDate(pdfDateString(pdfDateFromDate(date, offsetMinutes)));
        const local = new Date(0);
        if (parsed !== undefined) {
          const { year, month, day, hour, minute, second, offset } = parsed.date;
          local.setUTCFullYear(year, month - 1, day);
          local.setUTCHours(hour, minute, second, 0);
          const offsetMilliseconds = offset === 'Z' ? 0 : (offset.sign === '-' ? -1 : 1) * (offset.hours * 60 + offset.minutes) * 60_000;
          local.setTime(local.getTime() - offsetMilliseconds);
        }
        expect([parsed?.zone, local.getTime()]).toStrictEqual(['explicit', Math.floor(date.getTime() / 1000) * 1000]);
      }),
    );
  });
});
