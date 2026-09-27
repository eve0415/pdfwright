import type { PdfObject } from '../object/pdfObject.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';
import { ObjectIndex } from '../xref/objectIndex.ts';
import { readSectionChain, searchOrder } from '../xref/sectionChain.ts';

import { ObjectStore } from './objectStore.ts';

interface Store {
  store: ObjectStore;
  warnings: LoadWarning[];
}

const storeFrom = (bytes: Uint8Array, startxref: number, generationMismatch: 'error' | 'null' = 'error'): Store => {
  const source = new ByteSource(bytes);
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const context = {
    warn,
    names: new Map(),
    maxNesting: 256,
    maxDecodedBytes: 1_048_576,
    maxObjectStreamMembers: 1000,
    generationMismatch,
    parsedObjectCacheBytes: 1_048_576,
  };
  const chain = readSectionChain(source, { startxref, shift: 0 }, context);
  return { store: new ObjectStore(source, ObjectIndex.fromSections(searchOrder(chain)), context), warnings };
};

const storeOf = (objects: readonly TestObject[], generationMismatch: 'error' | 'null' = 'error'): Store => {
  const pdf = buildPdf([{ xref: 'classic', objects }]);
  return storeFrom(pdf.bytes, pdf.sections.at(-1) ?? 0, generationMismatch);
};

const lastSection = (sections: readonly number[]): number => sections.at(-1) ?? 0;

const data = (value: PdfObject): string => (value.kind === 'stream' ? new TextDecoder().decode(value.data) : '');

describe('object store', () => {
  it('resolves an indirect Length that follows the stream', () => {
    const { store, warnings } = storeOf([
      { number: 1, body: '<</Length 2 0 R>>\nstream\nhello world\nendstream' },
      { number: 2, body: '11' },
    ]);
    expect([data(store.resolve(1, 0)), warnings]).toStrictEqual(['hello world', []]);
  });

  it('recovers a stream whose indirect Length is missing or refers to the stream itself', () => {
    for (const reference of ['9 0 R', '1 0 R']) {
      const { store, warnings } = storeOf([{ number: 1, body: `<</Length ${reference}>>\nstream\nabc\nendstream` }]);
      expect([data(store.resolve(1, 0)), warnings.map(warning => warning.code)]).toStrictEqual(['abc', ['stream-length-recovered']]);
    }
  });

  it('resolves free and absent objects to null and caches parsed objects', () => {
    const { store } = storeOf([{ number: 2, body: streamBody('', 'x') }]);
    expect([store.resolve(1, 0), store.resolve(7, 0)]).toStrictEqual([{ kind: 'null' }, { kind: 'null' }]);
    expect(store.resolve(2, 0)).toBe(store.resolve(2, 0));
    expect(store.parse(2)?.value).not.toBe(store.resolve(2, 0));
  });

  it('throws on a generation mismatch unless asked to read it as null', () => {
    expect(() => storeOf([{ number: 1, body: '5' }]).store.resolve(1, 1)).toThrow(ParseError);
    const { store, warnings } = storeOf([{ number: 1, body: '5' }], 'null');
    expect([store.resolve(1, 1), warnings.map(warning => warning.code)]).toStrictEqual([{ kind: 'null' }, ['generation-mismatch']]);
  });

  it('resolves objects stored in object streams', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }],
        objectStreams: [
          {
            number: 5,
            members: [
              { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
              { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
            ],
          },
        ],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    const page = store.resolve(3, 0);
    expect([page.kind, store.load(3)?.source]).toStrictEqual([
      'dictionary',
      { kind: 'compressed', streamNumber: 5, index: 1, valueStart: 46, valueEnd: 73, clean: true },
    ]);
    expect(() => store.resolve(3, 1)).toThrow(ParseError);
  });
});
