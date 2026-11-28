import type { CodespaceRange } from './parseCMap.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { CMap } from './cmap.ts';
import { parseCMap } from './parseCMap.ts';

const cmapOf = (text: string, parent?: CMap): CMap => new CMap(parseCMap(latin1Bytes(text), 32), parent);

describe('CMaps', () => {
  it('reads each byte as an invalid 1-byte code when no codespace range is defined', () => {
    expect(cmapOf('').read(Uint8Array.of(0x41, 0x42), 0, { checks: 0 })).toStrictEqual({ code: { value: 0x41, length: 1 }, valid: false });
  });

  it('consumes an invalid code by the shortest codespace range of the CMap its usecmap names, when it defines none of its own', () => {
    const parent = cmapOf('1 begincodespacerange <8000> <80FF> endcodespacerange');
    const child = cmapOf('/Parent usecmap', parent);
    // 9.7.6.3 a): the first byte 90 matches the first byte of no range, so the range with the shortest codes, here 2 bytes, decides.
    expect([child.read(Uint8Array.of(0x90, 0x00, 0x41, 0x41), 0, { checks: 0 }), child.read(Uint8Array.of(0x80, 0x01), 0, { checks: 0 })]).toStrictEqual([
      { code: { value: 0x90_00, length: 2 }, valid: false },
      { code: { value: 0x80_01, length: 2 }, valid: true },
    ]);
  });

  it('takes the character collection, notdef mappings and text of the CMap its usecmap names', () => {
    const parent = cmapOf(
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginnotdefrange <00> <1F> 1 endnotdefrange 1 beginbfchar <41> <0042> endbfchar',
    );
    const child = cmapOf('/Parent usecmap 1 begincidchar <41> 7 endcidchar', parent);
    expect([
      child.cidSystemInfo,
      child.cid({ value: 0x05, length: 1 }),
      child.cid({ value: 0x41, length: 1 }),
      child.unicode({ value: 0x41, length: 1 }),
    ]).toStrictEqual([{ registry: latin1Bytes('Adobe'), ordering: latin1Bytes('Japan1'), supplement: 6 }, 1, 7, 'B']);
  });

  it('compares a valid code only with the codespace ranges of the lengths it tries, each counted as a check', () => {
    const wide = Array.from({ length: 100 }, (_, index) => `<${index.toString(16).padStart(8, '0')}> <${index.toString(16).padStart(8, '0')}>`);
    const parsed = parseCMap(latin1Bytes(`101 begincodespacerange ${wide.join(' ')} <00> <7F> endcodespacerange`), 32);
    // A range is compared with a code by reading its lower bound, so the ranges whose bound is read are the ranges compared.
    const compared = new Set<number>();
    const codespaces = parsed.codespaces.map(({ low, high }, index): CodespaceRange => ({
      get low(): Uint8Array {
        compared.add(index);
        return low;
      },
      high,
    }));
    const cmap = new CMap({ ...parsed, codespaces });
    compared.clear();
    const budget = { checks: 0 };
    const read = cmap.read(Uint8Array.of(0x41, 0x00, 0x00, 0x00), 0, budget);
    expect([read, [...compared], budget.checks]).toStrictEqual([{ code: { value: 0x41, length: 1 }, valid: true }, [100], 1]);
  });

  it('gives U+FFFD where incrementing a bfrange destination passes U+FFFF', () => {
    // ISO 32000-1:2008, 9.10.3: a destination whose last byte passes 255 over the range gives a result that "is undefined"; a code unit past 0xFFFF is no UTF-16.
    const cmap = cmapOf('1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <00> <02> <FFFF> endbfrange');
    expect([0, 1, 2].map(value => cmap.unicode({ value, length: 1 }))).toStrictEqual(['\uFFFF', '\uFFFD', '\uFFFD']);
  });
});

const hexOf = (bytes: ReadonlyArray<number>): string => `<${bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')}>`;

// Whether `bytes` from `offset` match `range` byte for byte over its whole length.
const matches = (range: CodespaceRange, bytes: Uint8Array, offset: number): boolean =>
  offset + range.low.length <= bytes.length &&
  [...range.low].every((low, index) => (bytes[offset + index] ?? -1) >= low && (bytes[offset + index] ?? 256) <= (range.high[index] ?? -1));

describe('properties', () => {
  // Codespace ranges of 1 to 4 bytes over the byte values 0 to 7, so that random strings often match a range in part.
  const bound = fc.integer({ min: 0, max: 7 });
  const range = fc
    .integer({ min: 1, max: 4 })
    .chain(length => fc.array(fc.tuple(bound, bound), { minLength: length, maxLength: length }))
    .map((pairs): CodespaceRange => ({ low: Uint8Array.from(pairs, ([a, b]) => Math.min(a, b)), high: Uint8Array.from(pairs, ([a, b]) => Math.max(a, b)) }));

  it('splits any string into codes that consume it exactly, each valid one matching a range and each invalid one matching none', () => {
    fc.assert(
      fc.property(fc.array(range, { maxLength: 6 }), fc.uint8Array({ max: 7, maxLength: 24 }), (ranges, bytes) => {
        const text = `${String(ranges.length)} begincodespacerange ${ranges.map(({ low, high }) => `${hexOf([...low])} ${hexOf([...high])}`).join(' ')} endcodespacerange`;
        const cmap = cmapOf(text);
        const budget = { checks: 0 };
        let consumed = 0;
        while (consumed < bytes.length) {
          const { code, valid } = cmap.read(bytes, consumed, budget);
          const remaining = bytes.length - consumed;
          // 9.7.6.2: a valid code is the shortest one that matches a range of its length; 9.7.6.3: an invalid code matches no range.
          const matching = ranges.filter(candidate => matches(candidate, bytes, consumed)).map(candidate => candidate.low.length);
          expect([code.length >= 1 && code.length <= Math.min(4, remaining), valid ? Math.min(...matching) : matching.length]).toStrictEqual([
            true,
            valid ? code.length : 0,
          ]);
          consumed += code.length;
        }
        expect(consumed).toBe(bytes.length);
      }),
    );
  });
});
