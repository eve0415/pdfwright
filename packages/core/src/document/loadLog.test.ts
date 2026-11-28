import type { LoadWarning, LoadWarningCode } from '../parse/loadWarning.ts';

import { describe, expect, it } from 'vitest';

import { LoadLog } from './loadLog.ts';

const warning = (code: LoadWarningCode, detail: string = code): LoadWarning => ({ code, detail });

const details = (log: LoadLog): Array<string> => log.warnings.map(entry => entry.detail);

describe('load log', () => {
  it.each(['dangling-reference', 'resources-missing', 'generation-mismatch', 'page-count-mismatch'] as const)(
    'records %s without making the structure tolerated',
    code => {
      const log = new LoadLog();
      log.warn(warning(code));
      expect([details(log), log.tolerated]).toStrictEqual([[code], false]);
    },
  );

  it.each(['startxref-corrected', 'duplicate-key', 'xref-reconstructed'] as const)('makes the structure tolerated for %s', code => {
    const log = new LoadLog();
    log.warn(warning(code));
    expect([details(log), log.tolerated]).toStrictEqual([[code], true]);
  });

  it('records a note without making the structure tolerated', () => {
    const log = new LoadLog();
    log.note(warning('startxref-corrected'));
    expect([details(log), log.tolerated]).toStrictEqual([['startxref-corrected'], false]);
  });

  it('discards the warnings of an attempt that throws', () => {
    const log = new LoadLog();
    log.warn(warning('dangling-reference', 'before'));
    expect(() =>
      log.attempt(warn => {
        warn(warning('startxref-corrected', 'held'));
        throw new RangeError('failed attempt');
      }),
    ).toThrow(RangeError);
    expect([details(log), log.tolerated]).toStrictEqual([['before'], false]);
  });

  it('keeps the warnings of an attempt that returns, in order after earlier ones, and logs later calls directly', () => {
    const log = new LoadLog();
    log.warn(warning('dangling-reference', 'before'));
    let retained: ((entry: LoadWarning) => void) | undefined;
    const result = log.attempt(warn => {
      retained = warn;
      warn(warning('dangling-reference', 'first'));
      warn(warning('startxref-corrected', 'second'));
      expect(details(log)).toStrictEqual(['before']);
      return 7;
    });
    retained?.(warning('dangling-reference', 'after'));
    expect([result, details(log), log.tolerated]).toStrictEqual([7, ['before', 'first', 'second', 'after'], true]);
  });

  it('applies the tolerated rule to a warning logged after an attempt returns', () => {
    const log = new LoadLog();
    let retained: ((entry: LoadWarning) => void) | undefined;
    log.attempt(warn => {
      retained = warn;
    });
    const before = log.tolerated;
    retained?.(warning('startxref-corrected', 'late'));
    expect([before, details(log), log.tolerated]).toStrictEqual([false, ['late'], true]);
  });
});
