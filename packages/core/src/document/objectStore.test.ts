import type { PdfObject } from '../object/pdfObject.ts';
import type { LexContext, LexWindow } from '../parse/lexer.ts';
import type { LoadWarning } from '../parse/loadWarning.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { XrefEntry } from '../xref/xrefSection.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GenerationMismatchError } from '../error/generationMismatchError.ts';
import { ParseError } from '../error/parseError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';
import { ObjectIndex } from '../xref/objectIndex.ts';
import { readSectionChain, searchOrder } from '../xref/sectionChain.ts';

import { ObjectStore } from './objectStore.ts';

interface Store {
  store: ObjectStore;
  warnings: Array<LoadWarning>;
}

interface StoreOptions {
  readonly generationMismatch?: 'error' | 'null';
  readonly parsedObjectCacheBytes?: number;
  readonly source?: ByteSource;
}

const contextOf = (warnings: Array<LoadWarning>, options: StoreOptions = {}) => ({
  warn: (warning: LoadWarning): void => {
    warnings.push(warning);
  },
  names: new Map<string, Uint8Array>(),
  maxNesting: 256,
  maxDecodedBytes: 1_048_576,
  maxObjectStreamMembers: 1000,
  generationMismatch: options.generationMismatch ?? 'error',
  parsedObjectCacheBytes: options.parsedObjectCacheBytes ?? 1_048_576,
});

const storeFrom = (bytes: Uint8Array, startxref: number, options: StoreOptions = {}): Store => {
  const source = options.source ?? new ByteSource(bytes);
  const warnings: Array<LoadWarning> = [];
  const context = contextOf(warnings, options);
  const chain = readSectionChain(source, { startxref, shift: 0 }, context);
  return { store: new ObjectStore(source, ObjectIndex.fromSections(searchOrder(chain)), context), warnings };
};

// A store over hand-made cross-reference entries, for entries no well-formed file has.
const storeOfEntries = (bytes: Uint8Array, entries: ReadonlyArray<XrefEntry>, options: StoreOptions = {}): Store => {
  const warnings: Array<LoadWarning> = [];
  return { store: new ObjectStore(new ByteSource(bytes), ObjectIndex.fromEntries(entries), contextOf(warnings, options)), warnings };
};

const storeOf = (objects: ReadonlyArray<TestObject>, options: StoreOptions = {}): Store => {
  const pdf = buildPdf([{ xref: 'classic', objects }]);
  return storeFrom(pdf.bytes, pdf.sections.at(-1) ?? 0, options);
};

const lastSection = (sections: ReadonlyArray<number>): number => sections.at(-1) ?? 0;

const data = (value: PdfObject): string => (value.kind === 'stream' ? new TextDecoder().decode(value.data) : '');

class SearchGuard extends Uint8Array {
  override indexOf(searchElement: number, fromIndex?: number): number {
    if (searchElement === 0x65) {
      throw new Error('searched past the last endstream');
    }
    return super.indexOf(searchElement, fromIndex);
  }
}

// Records the offset of every object the store parses from the source.
class CountingSource extends ByteSource {
  readonly parsed: Array<number> = [];

  override parseAt<T>(offset: number, context: LexContext, parse: (window: LexWindow, local: number, context: LexContext) => T): T {
    this.parsed.push(offset);
    return super.parseAt(offset, context, parse);
  }
}

const literal = (text: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(text), encoding: 'literal' });

// Five object streams 10 to 14, each holding one member numbered ten above it.
const fiveStreams = buildPdf([
  {
    xref: 'stream',
    objects: [],
    objectStreams: [0, 1, 2, 3, 4].map(index => ({ number: 10 + index, members: [{ number: 20 + index, body: `(member ${String(index)})` }] })),
  },
]);

const ignore = (): void => {
  // The stream error is the only result under test.
};

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

  it('rejects a stream after the last endstream without searching the remaining file', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: streamBody('', 'valid') },
          { number: 2, body: '<</Length 999>>\nstream\ninvalid' },
        ],
      },
    ]);
    const entries = [...pdf.offsets].map(([objectNumber, location]) => ({ objectNumber, type: 'file' as const, location, generation: 0 }));
    const context = {
      warn: ignore,
      names: new Map(),
      maxNesting: 256,
      maxDecodedBytes: 1_048_576,
      maxObjectStreamMembers: 1000,
      generationMismatch: 'error' as const,
      parsedObjectCacheBytes: 1_048_576,
    };
    const source = new ByteSource(new SearchGuard(pdf.bytes));
    const store = new ObjectStore(source, ObjectIndex.fromEntries(entries), context);
    // The guard only works while the source searches the caller's array rather than a copy.
    expect(source.segments[0]).toBeInstanceOf(SearchGuard);
    expect(() => store.parse(2)).toThrow(ParseError);
  });

  it('resolves free and absent objects to null and caches parsed objects', () => {
    const { store, warnings } = storeOf([{ number: 2, body: streamBody('', 'x') }]);
    expect([store.resolve(1, 0), store.resolve(7, 0)]).toStrictEqual([{ kind: 'null' }, { kind: 'null' }]);
    expect(warnings.map(warning => [warning.code, warning.objectNumber])).toStrictEqual([
      ['dangling-reference', 1],
      ['dangling-reference', 7],
    ]);
    expect(store.resolve(2, 0)).toBe(store.resolve(2, 0));
    expect(store.parse(2)?.value).not.toBe(store.resolve(2, 0));
  });

  it('throws on a generation mismatch unless asked to read it as null', () => {
    const pdf = buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '5' }] }]);
    expect(() => storeFrom(pdf.bytes, lastSection(pdf.sections)).store.resolve(1, 1)).toThrow(
      expect.objectContaining({ constructor: GenerationMismatchError, offset: pdf.offsets.get(1) }),
    );
    const { store, warnings } = storeOf([{ number: 1, body: '5' }], { generationMismatch: 'null' });
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
    expect(() => store.resolve(3, 1)).toThrow(expect.objectContaining({ constructor: GenerationMismatchError, offset: 0 }));
  });

  it('follows an indirect Filter of an object stream', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: 'null' }],
        objectStreams: [{ number: 5, members: [{ number: 2, body: '(member)' }], dictionary: '/Filter 1 0 R' }],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    expect(store.resolve(2, 0)).toStrictEqual({ kind: 'string', bytes: new TextEncoder().encode('member'), encoding: 'literal' });
  });

  it.each(['Filter', 'DecodeParms'])('resolves an acyclic %s dependency through another object stream', entry => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: 'null' }],
        objectStreams: [
          { number: 3, members: [{ number: 4, body: '(member)' }], dictionary: `/${entry} 6 0 R` },
          { number: 5, members: [{ number: 6, body: 'null' }], dictionary: `/${entry} 1 0 R` },
        ],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    expect(store.resolve(4, 0)).toStrictEqual({ kind: 'string', bytes: new TextEncoder().encode('member'), encoding: 'literal' });
  });

  it.each(['Filter', 'DecodeParms'])('rejects an object stream whose %s refers to its own member on repeated reads', entry => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [],
        objectStreams: [{ number: 3, members: [{ number: 4, body: 'null' }], dictionary: `/${entry} 4 0 R` }],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    const error = { constructor: ParseError, message: 'cyclic dependency while decoding object stream 3', offset: pdf.offsets.get(3) };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => store.resolve(4, 0)).toThrow(expect.objectContaining(error));
    }
  });

  it.each([
    ['Filter', 'Filter'],
    ['Filter', 'DecodeParms'],
    ['DecodeParms', 'Filter'],
    ['DecodeParms', 'DecodeParms'],
  ])('rejects a %s dependency through another object stream’s %s on repeated reads', (first, second) => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [],
        objectStreams: [
          { number: 3, members: [{ number: 4, body: 'null' }], dictionary: `/${first} 6 0 R` },
          { number: 5, members: [{ number: 6, body: 'null' }], dictionary: `/${second} 4 0 R` },
        ],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    const error = { constructor: ParseError, message: 'cyclic dependency while decoding object stream 3', offset: pdf.offsets.get(3) };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => store.resolve(4, 0)).toThrow(expect.objectContaining(error));
    }
  });

  it('re-parses an evicted object and keeps the newest object even when it alone exceeds the budget', () => {
    const objects = [
      { number: 1, body: '<</A 1>>' },
      { number: 2, body: '<</B 2>>' },
    ];
    const tight = storeOf(objects, { parsedObjectCacheBytes: 0 }).store;
    const first = tight.resolve(1, 0);
    expect(tight.resolve(1, 0)).toBe(first);
    tight.resolve(2, 0);
    const again = tight.resolve(1, 0);
    expect(again).toStrictEqual(first);
    expect(again).not.toBe(first);
    const roomy = storeOf(objects).store;
    const kept = roomy.resolve(1, 0);
    roomy.resolve(2, 0);
    expect(roomy.resolve(1, 0)).toBe(kept);
  });

  it.each([
    { order: 'four streams, then the first again', sequence: [0, 1, 2, 3, 0], decodes: 1 },
    { order: 'five streams, then the first again', sequence: [0, 1, 2, 3, 4, 0], decodes: 2 },
    { order: 'four streams, the first again, a fifth, then the first again', sequence: [0, 1, 2, 3, 0, 4, 0], decodes: 1 },
  ])('keeps the four most recently used object streams decoded: $order', ({ sequence, decodes }) => {
    const source = new CountingSource(fiveStreams.bytes);
    const { store } = storeFrom(fiveStreams.bytes, lastSection(fiveStreams.sections), { source, parsedObjectCacheBytes: 0 });
    source.parsed.length = 0;
    expect(sequence.map(index => store.resolve(20 + index, 0))).toStrictEqual(sequence.map(index => literal(`member ${String(index)}`)));
    expect(source.parsed.filter(offset => offset === fiveStreams.offsets.get(10))).toHaveLength(decodes);
  });

  it('refuses an object stream whose in-use entry has a generation other than 0', () => {
    const pdf = buildPdf([{ xref: 'stream', objects: [], objectStreams: [{ number: 5, members: [{ number: 2, body: '(member)' }] }] }]);
    const location = pdf.offsets.get(5) ?? 0;
    const entries = (generation: number): Array<XrefEntry> => [
      { objectNumber: 5, type: 'file', location, generation },
      { objectNumber: 2, type: 'compressed', location: 5, generation: 0 },
    ];
    // The header is rewritten to match the entry, at the same length, so only the object stream rule rejects it.
    const renumbered = latin1Bytes(pdf.text.replace('5 0 obj', '5 1 obj'));
    // ISO 32000-1:2008, 7.5.8.3, Table 18, type 2: "The generation number of the object stream shall be implicitly 0."
    const { store } = storeOfEntries(renumbered, entries(1));
    expect(() => store.resolve(2, 0)).toThrow(ParseError);
    expect(() => store.resolve(2, 0)).toThrow(/no in-file entry with generation 0/u);
    expect(storeOfEntries(pdf.bytes, entries(0)).store.resolve(2, 0)).toStrictEqual(literal('member'));
  });

  it.each([
    { entry: 'another object’s offset', objectNumber: 2, at: 1, generation: 0 },
    { entry: 'a generation its header does not have', objectNumber: 1, at: 1, generation: 1 },
  ])('refuses an object whose cross-reference entry gives $entry', ({ objectNumber, at, generation }) => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '(one)' },
          { number: 2, body: '(two)' },
        ],
      },
    ]);
    const location = pdf.offsets.get(at) ?? 0;
    const { store } = storeOfEntries(pdf.bytes, [{ objectNumber, type: 'file', location, generation }]);
    expect(() => store.parse(objectNumber)).toThrow(expect.objectContaining({ constructor: ParseError, offset: location }));
    const { store: matching } = storeOfEntries(pdf.bytes, [{ objectNumber: at, type: 'file', location, generation: 0 }]);
    expect(matching.parse(at)?.value).toStrictEqual(literal(at === 1 ? 'one' : 'two'));
  });

  it.each([
    { length: 'a negative integer', reference: '2 0 R', value: '-1' },
    { length: 'a real', reference: '2 0 R', value: '11.0' },
    { length: 'a name', reference: '2 0 R', value: '/Eleven' },
    { length: 'a reference naming another generation', reference: '2 1 R', value: '11' },
  ])('recovers a stream whose indirect Length is $length', ({ reference, value }) => {
    const { store, warnings } = storeOf([
      { number: 1, body: `<</Length ${reference}>>\nstream\nhello world\nendstream` },
      { number: 2, body: value },
    ]);
    expect([data(store.resolve(1, 0)), warnings.map(warning => warning.code)]).toStrictEqual(['hello world', ['stream-length-recovered']]);
  });

  it('reads an object stream whose Length is one of its own members as unresolvable', () => {
    const header = '%PDF-1.7\n';
    const bytes = latin1Bytes(`${header}5 0 obj\n<</Type/ObjStm/N 1/First 5/Length 2 0 R>>\nstream\n2 0 \n11\n\nendstream\nendobj\n`);
    const { store, warnings } = storeOfEntries(bytes, [
      { objectNumber: 5, type: 'file', location: header.length, generation: 0 },
      { objectNumber: 2, type: 'compressed', location: 5, generation: 0 },
    ]);
    // ISO 32000-1:2008, 7.5.7 forbids storing the Length of an object stream in an object stream, so resolving it would recurse into the stream being read.
    expect([store.resolve(2, 0), warnings.map(warning => warning.code)]).toStrictEqual([{ kind: 'integer', value: 11 }, ['stream-length-recovered']]);
  });

  it('warns once per dangling reference, counting each generation separately', () => {
    const { store, warnings } = storeOf([{ number: 1, body: '5' }]);
    for (const generation of [0, 0, 1]) {
      expect(store.resolve(7, generation)).toStrictEqual({ kind: 'null' });
    }
    expect(warnings.map(warning => [warning.code, warning.objectNumber])).toStrictEqual([
      ['dangling-reference', 7],
      ['dangling-reference', 7],
    ]);
  });

  it('reads a compressed object under another generation as null when asked to', () => {
    const pdf = buildPdf([{ xref: 'stream', objects: [], objectStreams: [{ number: 5, members: [{ number: 3, body: '(member)' }] }] }]);
    const { store, warnings } = storeFrom(pdf.bytes, lastSection(pdf.sections), { generationMismatch: 'null' });
    expect([store.resolve(3, 1), warnings.map(warning => [warning.code, warning.objectNumber])]).toStrictEqual([
      { kind: 'null' },
      [['generation-mismatch', 3]],
    ]);
  });

  it('notes duplicate keys in in-file and compressed objects and marks the compressed source unclean', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</A 1/A 2>>' },
          { number: 2, body: '<</A 1/B 2>>' },
        ],
        objectStreams: [
          {
            number: 5,
            members: [
              { number: 3, body: '<</C 1/C 2>>' },
              { number: 4, body: '<</C 1/D 2>>' },
            ],
          },
        ],
      },
    ]);
    const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections));
    const clean = [1, 2, 3, 4].map(number => {
      const source = store.load(number)?.source;
      return source?.kind === 'compressed' ? source.clean : 'in file';
    });
    // ISO 32000-1:2008, 7.3.7: "Multiple entries in the same dictionary shall not have the same key."
    expect([[1, 2, 3, 4].map(number => store.hasDuplicateKeys(number)), clean]).toStrictEqual([
      [true, false, true, false],
      ['in file', 'in file', false, true],
    ]);
  });
});

describe('properties', () => {
  // Six object streams of two members each, so that four decoded streams cannot hold them all.
  const pdf = buildPdf([
    {
      xref: 'stream',
      objects: [
        { number: 1, body: '<</Kind/InFile/N 1>>' },
        { number: 2, body: '[1 2 (three)]' },
      ],
      objectStreams: [0, 1, 2, 3, 4, 5].map(index => ({
        number: 10 + index,
        members: [
          { number: 20 + 2 * index, body: `<</Stream ${String(index)}/First true>>` },
          { number: 21 + 2 * index, body: `(member ${String(index)})` },
        ],
      })),
    },
  ]);
  const numbers = [1, 2, ...Array.from({ length: 12 }, (_, index) => 20 + index)];

  it('resolves every object to the same value whatever the cache budget and access order', () => {
    const unbounded = storeFrom(pdf.bytes, lastSection(pdf.sections), { parsedObjectCacheBytes: Number.MAX_SAFE_INTEGER }).store;
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: 0, max: 4000 }), fc.integer({ min: 0, max: 1_048_576 })),
        fc.array(fc.constantFrom(...numbers), { minLength: 1, maxLength: 40 }),
        (budget, sequence) => {
          const { store } = storeFrom(pdf.bytes, lastSection(pdf.sections), { parsedObjectCacheBytes: budget });
          expect(sequence.map(number => store.resolve(number, 0))).toStrictEqual(sequence.map(number => unbounded.resolve(number, 0)));
        },
      ),
    );
  });
});
