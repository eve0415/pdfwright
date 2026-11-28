import type { PdfDirectObject } from './pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { PdfDictionaryEntries, parsedDictionaryEntries } from './pdfDictionaryEntries.ts';
import { pdfInteger } from './pdfObject.ts';

const bytes = (name: string): Uint8Array => new TextEncoder().encode(name);

const keysOf = (entries: PdfDictionaryEntries): Array<Array<number>> => [...entries.entries()].map(([key]) => [...key]);

describe('dictionary entries', () => {
  it('copies a key when it is set', () => {
    const key = Uint8Array.of(0x41);
    const entries = new PdfDictionaryEntries().set(key, pdfInteger(1));
    key[0] = 0x42;
    expect([entries.get(Uint8Array.of(0x41)), entries.get(Uint8Array.of(0x42)), keysOf(entries)]).toStrictEqual([pdfInteger(1), undefined, [[0x41]]]);
  });

  it('yields copies of its keys', () => {
    const entries = new PdfDictionaryEntries([[Uint8Array.of(0x41), pdfInteger(1)]]);
    for (const [key] of entries.entries()) {
      key[0] = 0x42;
    }
    expect(keysOf(entries)).toStrictEqual([[0x41]]);
  });

  it('reports whether delete removed a key', () => {
    const entries = new PdfDictionaryEntries([[Uint8Array.of(0x41), pdfInteger(1)]]);
    expect([entries.delete(Uint8Array.of(0x42)), entries.delete(Uint8Array.of(0x41)), entries.delete(Uint8Array.of(0x41)), entries.size]).toStrictEqual([
      false,
      true,
      false,
      0,
    ]);
  });

  it('lets a later parsed key replace an earlier equal one', () => {
    const entries = parsedDictionaryEntries([
      [Uint8Array.of(0x41), pdfInteger(1)],
      [Uint8Array.of(0x42), pdfInteger(2)],
      [Uint8Array.of(0x41), pdfInteger(3)],
    ]);
    expect([...entries.entries()].map(([key, value]) => [[...key], value])).toStrictEqual([
      [[0x41], pdfInteger(3)],
      [[0x42], pdfInteger(2)],
    ]);
  });

  it('validates keys from callers again once parsed entries are built', () => {
    parsedDictionaryEntries([[Uint8Array.of(0), pdfInteger(1)]]);
    expect(() => new PdfDictionaryEntries().set(Uint8Array.of(0), pdfInteger(1))).toThrow(InvalidArgumentError);
  });
});

describe('properties', () => {
  const key = fc.constantFrom('A', 'B', 'C');

  type Operation = { kind: 'set'; key: string; value: number } | { kind: 'null'; key: string } | { kind: 'delete'; key: string };

  const set = fc.record({ kind: fc.constant('set' as const), key, value: fc.integer({ min: 0, max: 3 }) });
  const remove = fc.record({ kind: fc.constant('delete' as const), key });
  const setNull = fc.record({ kind: fc.constant('null' as const), key });

  const apply = (operations: ReadonlyArray<Operation>): PdfDictionaryEntries => {
    const entries = new PdfDictionaryEntries();
    for (const operation of operations) {
      if (operation.kind === 'delete') {
        entries.delete(bytes(operation.key));
      } else {
        const value: PdfDirectObject = operation.kind === 'set' ? pdfInteger(operation.value) : { kind: 'null' };
        entries.set(bytes(operation.key), value);
      }
    }
    return entries;
  };

  interface Observation {
    entries: Array<[string, PdfDirectObject]>;
    size: number;
    lookups: Array<[boolean, PdfDirectObject | undefined]>;
  }

  const names = ['A', 'B', 'C'];

  const observed = (entries: PdfDictionaryEntries): Observation => ({
    entries: [...entries.entries()].map(([name, value]) => [new TextDecoder().decode(name), value]),
    size: entries.size,
    lookups: names.map(name => [entries.has(bytes(name)), entries.get(bytes(name))]),
  });

  const expected = (model: ReadonlyMap<string, number>): Observation => ({
    entries: [...model].map(([name, value]) => [name, pdfInteger(value)]),
    size: model.size,
    lookups: names.map(name => {
      const value = model.get(name);
      return value === undefined ? [false, undefined] : [true, pdfInteger(value)];
    }),
  });

  const byName = (observation: Observation): Observation => ({
    ...observation,
    entries: observation.entries.toSorted(([left], [right]) => left.localeCompare(right)),
  });

  // A Map keeps first-insertion order, keeps a replaced key in place and forgets a deleted key's position, which is the order a rewritten dictionary keeps.
  it('matches a Map under set and delete, order included', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(set, remove), { maxLength: 12 }), operations => {
        const model = new Map<string, number>();
        for (const operation of operations) {
          if (operation.kind === 'delete') {
            model.delete(operation.key);
          } else {
            model.set(operation.key, operation.value);
          }
        }
        expect(observed(apply(operations))).toStrictEqual(expected(model));
      }),
    );
  });

  // ISO 32000-1:2008, 7.3.7: an entry whose value is null is equivalent to an absent entry. Only content is compared here, not where a key set to null later reappears.
  it('reads a key set to null as absent', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(set, remove, setNull), { maxLength: 12 }), operations => {
        const model = new Map<string, number>();
        for (const operation of operations) {
          if (operation.kind === 'set') {
            model.set(operation.key, operation.value);
          } else {
            model.delete(operation.key);
          }
        }
        expect(byName(observed(apply(operations)))).toStrictEqual(byName(expected(model)));
      }),
    );
  });
});
