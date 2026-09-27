import { describe, expect, it } from 'vitest';

import { parsePdfDate, pdfDate, pdfDateString } from '../../date/pdfDate.ts';

import { compareDates, instant, parseXmpDate, xmpDateString } from './xmpDate.ts';

const described = (text: string): readonly unknown[] | undefined => {
  const parsed = parseXmpDate(text);
  return parsed === undefined ? undefined : [pdfDateString(parsed.date), parsed.precision, parsed.zone];
};

const agreement = (pdf: string, xmp: string): string => {
  const left = parsePdfDate(pdf);
  const right = parseXmpDate(xmp);
  return left === undefined || right === undefined ? 'unparsed' : compareDates(left, right);
};

describe('dates in XMP', () => {
  it('reads every form of XMP Part 1 8.2.1.2', () => {
    expect(
      ['2024', '2024-02', '2024-02-29', '2024-02-29T12:34Z', '2024-02-29T12:34:56+09:00', '2024-02-29T12:34:56.789-05:30', '2024-02-29T12:34:56'].map(text =>
        described(text),
      ),
    ).toStrictEqual([
      ['D:20240101000000Z', 'year', 'absent'],
      ['D:20240201000000Z', 'month', 'absent'],
      ['D:20240229000000Z', 'day', 'absent'],
      ['D:20240229123400Z', 'minute', 'explicit'],
      ["D:20240229123456+09'00", 'second', 'explicit'],
      ["D:20240229123456-05'30", 'second', 'explicit'],
      ['D:20240229123456Z', 'second', 'absent'],
    ]);
  });

  it('rejects other forms', () => {
    const rejected = [
      '',
      '24',
      '2024-2',
      '2024-02-30',
      '2024-02-29T12',
      '2024-02-29T12:34:56+0900',
      '2024-02-29 12:34:56Z',
      '2024-02-29T24:00:00Z',
      '2024-02-29T12:34:56.Z',
    ];
    expect(rejected.filter(text => parseXmpDate(text) !== undefined)).toStrictEqual([]);
  });

  it('writes a PDF date with its offset', () => {
    const fields = { year: 2024, month: 2, day: 29, hour: 12, minute: 34, second: 56 };
    expect([
      xmpDateString(pdfDate({ ...fields, offset: 'Z' })),
      xmpDateString(pdfDate({ ...fields, offset: { sign: '+', hours: 9, minutes: 0 } })),
      xmpDateString(pdfDate({ ...fields, offset: { sign: '-', hours: 5, minutes: 30 } })),
    ]).toStrictEqual(['2024-02-29T12:34:56Z', '2024-02-29T12:34:56+09:00', '2024-02-29T12:34:56-05:30']);
  });

  it('compares the same instant at the coarser precision', () => {
    expect([
      agreement("D:20030826163921-06'00'", '2003-08-26T22:39:21Z'),
      agreement("D:20030826163921-06'00'", '2003-08-26T23:39:02Z'),
      agreement("D:20030826163921-06'00'", '2003-08-26T16:39-06:00'),
      agreement("D:20030826163921-06'00'", '2003-08-26T16:40-06:00'),
      agreement('D:20030826', '2003-08-26T16:39:21-06:00'),
      agreement('D:2003082622', '2003-08-26T22:39:21Z'),
      agreement('D:20030826163921', '2003-08-26T16:39:21Z'),
      agreement('D:20030826163921Z', '2003-08-26T16:39:21.9Z'),
    ]).toStrictEqual(['equal', 'different', 'equal', 'different', 'equal', 'equal', 'equal', 'equal']);
  });

  it('takes a coarse time as the hour or minute it names in its own time zone', () => {
    expect([
      agreement("D:2024030112+05'30'", '2024-03-01T12:45:00+05:30'),
      agreement("D:2024030112+05'30'", '2024-03-01T06:45:00Z'),
      agreement("D:2024030112+05'30'", '2024-03-01T13:10:00+05:30'),
      agreement("D:202403011245+05'45'", '2024-03-01T12:45:30+05:45'),
      agreement("D:20240301124530+05'45'", '2024-03-01T12:45+05:45'),
      agreement("D:2024030112+05'30'", '2024-03-01T12:00+06:00'),
    ]).toStrictEqual(['equal', 'equal', 'different', 'equal', 'equal', 'different']);
  });

  it('compares times in the years 0 to 99 as those years', () => {
    expect([
      agreement('D:19990101000000Z', '0099-01-01T00:00:00Z'),
      agreement('D:00990101000000Z', '0099-01-01T00:00:00Z'),
      agreement("D:00000101000000+01'00'", '0000-01-01T00:00:00+01:00'),
    ]).toStrictEqual(['different', 'equal', 'equal']);
    expect(instant(pdfDate({ year: 99, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }))).toBe(-59_042_995_200_000);
  });

  it('cannot compare a time without a time zone designator', () => {
    expect([agreement('D:20030826163921Z', '2003-08-26T16:39:21'), agreement('D:20030826', '2003-08-26'), agreement('D:20030827', '2003-08-26')]).toStrictEqual(
      ['indeterminate', 'equal', 'different'],
    );
  });
});
