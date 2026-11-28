import type { LoadWarning } from '../parse/loadWarning.ts';
import type { TestSection } from '../testing/pdfBuilder.ts';
import type { Reconstruction } from './recover.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { locateStartxref } from './locate.ts';
import { ABSENT, COMPRESSED, IN_FILE, ObjectIndex } from './objectIndex.ts';
import { reconstructIndex } from './recover.ts';
import { readSectionChain, searchOrder } from './sectionChain.ts';

interface Result {
  reconstruction: Reconstruction;
  warnings: Array<LoadWarning>;
}

const reconstruct = (text: string, maxObjectStreamMembers = 100, maxDecodedBytes = 1_048_576): Result => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const context = { warn, names: new Map(), maxNesting: 256, maxDecodedBytes, maxObjectStreamMembers };
  return { reconstruction: reconstructIndex(new ByteSource(latin1Bytes(text)), context), warnings };
};

const located = (reconstruction: Reconstruction): Array<Array<number | string>> =>
  [...reconstruction.index.inUse()].map(number => {
    const entry = reconstruction.index.get(number);
    return [number, entry.type === IN_FILE ? 'file' : 'compressed', entry.location];
  });

const rootOf = (reconstruction: Reconstruction): Array<string> =>
  reconstruction.trailers.map(trailer => {
    const root = trailer.get(pdfName('Root').bytes);
    return root?.kind === 'reference' ? `${String(root.objectNumber)} R` : '-';
  });

interface Summary {
  readonly located: Array<Array<number | string>>;
  readonly roots: Array<string>;
  readonly catalogs: ReadonlyArray<number>;
  readonly ambiguous: ReadonlyArray<number>;
  readonly unreadable: ReadonlyArray<number>;
  readonly objects: number;
  readonly objectStreams: number;
}

const summary = (reconstruction: Reconstruction): Summary => ({
  located: located(reconstruction),
  roots: rootOf(reconstruction),
  catalogs: reconstruction.catalogs,
  ambiguous: reconstruction.ambiguous,
  unreadable: reconstruction.unreadable,
  objects: reconstruction.objects,
  objectStreams: reconstruction.objectStreams,
});

// Objects 1 to 3, the last an object stream holding member 5 and a second member numbered `number` whose value is `body`.
const objectStream = (number: number, body: string): string => {
  const header = `5 0 ${String(number)} 3 `;
  return `%PDF-1.5\n1 0 obj (a) endobj\n2 0 obj (b) endobj\n3 0 obj\n${streamBody(`/Type/ObjStm/N 2/First ${String(header.length)}`, `${header}(m)${body}`)}\nendobj\n`;
};

class CountedBytes extends Uint8Array {
  searchedBytes = 0;

  override indexOf(searchElement: number, fromIndex = 0): number {
    const found = super.indexOf(searchElement, fromIndex);
    this.searchedBytes += (found === -1 ? this.length : found + 1) - Math.min(fromIndex, this.length);
    return found;
  }
}

describe('cross-reference reconstruction', () => {
  it('finds objects and trailers without any cross-reference section', () => {
    const text = '%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj <</Type/Pages/Kids[]/Count 0>> endobj\ntrailer\n<</Root 1 0 R>>\n%%EOF';
    const { reconstruction } = reconstruct(text);
    expect(located(reconstruction)).toStrictEqual([
      [1, 'file', 9],
      [2, 'file', 54],
    ]);
    expect([rootOf(reconstruction), reconstruction.catalogs, reconstruction.ambiguous, reconstruction.objects]).toStrictEqual([['1 R'], [1], [], 2]);
  });

  it('does not mistake bytes inside stream data for objects', () => {
    const text = `%PDF-1.4\n1 0 obj\n${streamBody('', '5 0 obj (inside) endobj trailer <</Root 5 0 R>>')}\nendobj\n`;
    const { reconstruction } = reconstruct(text);
    expect([located(reconstruction).map(([number]) => number), reconstruction.trailers]).toStrictEqual([[1], []]);
  });

  it('bounds searched bytes when streams lack their own endstream', () => {
    for (const count of [128, 256, 512]) {
      const fragments = Array.from({ length: count }, (_, index) => `${String(index + 1)} 0 obj<<>>stream\neeee\n`);
      const bytes = new CountedBytes(latin1Bytes(`%PDF-1.7\n${fragments.join('')}endstream X\n`));
      const reconstruction = reconstructIndex(new ByteSource(bytes), {
        warn: () => {
          // Only reconstruction and its search cost are under test.
        },
        names: new Map(),
        maxNesting: 256,
        maxDecodedBytes: 1_048_576,
        maxObjectStreamMembers: 100,
      });
      expect(reconstruction.unreadable).toHaveLength(count);
      expect(bytes.searchedBytes).toBeLessThanOrEqual(8 * bytes.length);
    }
  });

  it('preserves the first-two-candidate rule for recovered stream extents', () => {
    const preferred = reconstruct('1 0 obj<<>>stream\nx endstream y\n2 0 obj (data) endobj\nendstream endobj\n3 0 obj 5 endobj');
    expect(located(preferred.reconstruction).map(([number]) => number)).toStrictEqual([1, 3]);
    const fallback = reconstruct('1 0 obj<<>>stream\nx\nendstream\n2 0 obj (next) endobj\nendstream X\nendstream endobj');
    expect(located(fallback.reconstruction).map(([number]) => number)).toStrictEqual([1, 2]);
  });

  it('prefers the later copy and reports copies that differ', () => {
    const same = reconstruct('%PDF-1.4\n3 0 obj (a) endobj\n3 0 obj (a) endobj\n').reconstruction;
    expect([located(same), same.ambiguous]).toStrictEqual([[[3, 'file', 28]], []]);
    const different = reconstruct('%PDF-1.4\n3 0 obj (a) endobj\n3 0 obj (b) endobj\n').reconstruction;
    expect([located(different), different.ambiguous]).toStrictEqual([[[3, 'file', 28]], [3]]);
  });

  it('compares copies by value and reports unreadable copies', () => {
    const spacing = reconstruct('%PDF-1.4\n3 0 obj <</A 1>> endobj\n3 0 obj << /A 1 >> endobj\n').reconstruction;
    const broken = reconstruct('%PDF-1.4\n3 0 obj (a) endobj\n3 0 obj <zz> endobj\n4 0 obj <zz> endobj\n').reconstruction;
    expect([spacing.ambiguous, broken.ambiguous, broken.unreadable, located(broken)]).toStrictEqual([[], [3], [4], [[3, 'file', 9]]]);
  });

  it.each([
    ['/N 1/First 4/Filter/UnknownDecode', '9 0 null'],
    ['/N 1/First 4/Filter/FlateDecode', 'invalid'],
    ['/First 4', '9 0 null'],
    ['/N 1', '9 0 null'],
    ['/N 1/First 4', 'xxxxnull'],
    ['/N 1/First 4', '9 9 null'],
  ])('records an unreadable object stream with dictionary %s', (dictionary, data) => {
    const text = `1 0 obj (readable) endobj\n3 0 obj\n${streamBody(`/Type/ObjStm${dictionary}`, data)}\nendobj\n`;
    const { reconstruction } = reconstruct(text);
    expect([reconstruction.unreadable, reconstruction.ambiguous, reconstruction.objectStreams]).toStrictEqual([[3], [], 0]);
    expect(located(reconstruction).map(([number]) => number)).toStrictEqual([1]);
  });

  it('keeps readable copies when another copy is an unreadable object stream', () => {
    const bad = `3 0 obj\n${streamBody('/Type/ObjStm/N 1/First 4/Filter/UnknownDecode', '9 0 null')}\nendobj\n`;
    const good = '3 0 obj (readable) endobj\n';
    for (const text of [good + bad, bad + good]) {
      const { reconstruction } = reconstruct(text);
      expect([reconstruction.unreadable, reconstruction.ambiguous]).toStrictEqual([[], [3]]);
      expect(located(reconstruction)).toStrictEqual([[3, 'file', text.indexOf(good)]]);
    }
  });

  it.each([
    { objects: [], unreadable: [9], ambiguous: [], type: ABSENT },
    { objects: [{ number: 9, body: '(readable)' }], unreadable: [], ambiguous: [9], type: IN_FILE },
  ])('records malformed object-stream members with readable copies $objects', ({ objects, unreadable, ambiguous, type }) => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects,
        objectStreams: [
          {
            number: 3,
            members: [
              { number: 9, body: '<zz>' },
              { number: 10, body: '(valid)' },
            ],
          },
        ],
      },
    ]);
    const { reconstruction } = reconstruct(pdf.text);
    expect([reconstruction.unreadable, reconstruction.ambiguous]).toStrictEqual([unreadable, ambiguous]);
    expect([reconstruction.index.get(9).type, reconstruction.index.get(10).type]).toStrictEqual([type, COMPRESSED]);
  });

  it('propagates decoded object-stream size limits', () => {
    const text = `3 0 obj\n${streamBody('/Type/ObjStm/N 1/First 4', '9 0 null')}\nendobj\n`;
    expect(() => reconstruct(text, 100, 4)).toThrow(ResourceLimitError);
  });

  it('ranks object-stream members at their stream position against top-level copies', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }],
        objectStreams: [{ number: 4, members: [{ number: 2, body: '(member)' }] }],
        trailer: '/Root 1 0 R',
      },
      { xref: 'classic', objects: [{ number: 2, body: '(later)' }], trailer: '/Root 1 0 R' },
    ]);
    const { reconstruction } = reconstruct(pdf.text);
    const entry = reconstruction.index.get(2);
    expect([entry.type, entry.location, reconstruction.ambiguous, reconstruction.objectStreams]).toStrictEqual([IN_FILE, pdf.offsets.get(2), [2], 1]);
    expect(rootOf(reconstruction)).toStrictEqual(['1 R', '1 R']);
    const earlier = buildPdf([
      { xref: 'stream', objects: [{ number: 2, body: '(early)' }], objectStreams: [{ number: 4, members: [{ number: 2, body: '(member)' }] }] },
    ]);
    expect(reconstruct(earlier.text).reconstruction.index.get(2).type).toBe(COMPRESSED);
  });

  it('reports cycles in Extends links and propagates resource limits', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [],
        objectStreams: [
          { number: 4, members: [{ number: 2, body: '1' }], dictionary: '/Extends 5 0 R' },
          { number: 5, members: [{ number: 3, body: '2' }], dictionary: '/Extends 4 0 R' },
        ],
      },
    ]);
    expect(reconstruct(pdf.text).warnings.map(warning => warning.code)).toStrictEqual(['objstm-extends-cycle', 'objstm-extends-cycle']);
    expect(() => reconstruct(pdf.text, 0)).toThrow(ResourceLimitError);
  });

  // ISO 32000-1:2008, 7.5.7, Table 16, Extends: the links "form a directed acyclic graph".
  it.each([
    ['an acyclic chain', '/Extends 5 0 R', '', []],
    ['a stream that extends itself', '/Extends 4 0 R', '', ['objstm-extends-cycle']],
    ['a stream that extends one that was never decoded', '/Extends 9 0 R', '', []],
    ['a second stream that extends itself', '', '/Extends 5 0 R', ['objstm-extends-cycle']],
  ])('reports Extends cycles as expected for %s', (_, first, second, codes) => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [],
        objectStreams: [
          { number: 4, members: [{ number: 2, body: '1' }], dictionary: first },
          { number: 5, members: [{ number: 3, body: '2' }], dictionary: second },
        ],
      },
    ]);
    expect(reconstruct(pdf.text).warnings.map(warning => warning.code)).toStrictEqual(codes);
  });

  it.each([
    ['a regular byte before the object number', 'x1 0 obj (a) endobj'],
    ['a regular byte after obj', '1 0 objx (a) endobj'],
    ['no white space before obj', '1 0obj (a) endobj'],
    ['an object number of 11 digits, leading zeros included', '00000000001 0 obj (a) endobj'],
    ['an object number above 2^31 - 1', '2147483648 0 obj (a) endobj'],
    ['a generation above 2^32 - 1', '1 4294967296 obj (a) endobj'],
  ])('does not read a header with %s', (_, candidate) => {
    const { reconstruction } = reconstruct(`%PDF-1.4\n${candidate}\n7 0 obj (b) endobj\n`);
    expect([located(reconstruction).map(([number]) => number), reconstruction.unreadable]).toStrictEqual([[7], []]);
  });

  it('reads a ten-digit object number and headers at the highest object number and generation', () => {
    expect(located(reconstruct('%PDF-1.4\n0000000003 0 obj (a) endobj\n').reconstruction)).toStrictEqual([[3, 'file', 9]]);
    const { reconstruction } = reconstruct('%PDF-1.4\n2147483647 0 obj (a) endobj\n1 4294967295 obj (b) endobj\n');
    expect([reconstruction.index.get(2_147_483_647).type, reconstruction.index.get(1)]).toStrictEqual([
      IN_FILE,
      { type: IN_FILE, location: 37, generation: 4_294_967_295 },
    ]);
  });

  // A member above 2^31 - 1 is skipped whether or not its value parses; 2^32 + 1 would otherwise wrap to object 1.
  it.each([
    [2_147_483_647, [2_147_483_647]],
    [2_147_483_648, []],
    [4_294_967_297, []],
  ])('reads an object-stream member numbered %i only up to 2^31 - 1', (number, kept) => {
    const readable = reconstruct(objectStream(number, '(n)')).reconstruction;
    const unreadable = reconstruct(objectStream(number, '<zz>')).reconstruction;
    expect([located(readable).map(([objectNumber, type]) => [objectNumber, type]), readable.objects, unreadable.unreadable]).toStrictEqual([
      [[1, 'file'], [2, 'file'], [3, 'file'], [5, 'compressed'], ...kept.map(objectNumber => [objectNumber, 'compressed'])],
      4 + kept.length,
      kept,
    ]);
  });

  it('reads only trailer keywords that stand alone and hold a dictionary, and scans on past a broken one', () => {
    const text = '%PDF-1.4\nxtrailer<</Root 8 0 R>>\ntrailer 5\ntrailer <</A [>>\n1 0 obj (a) endobj\ntrailer <</Root 1 0 R>>\n';
    const { reconstruction } = reconstruct(text);
    expect([rootOf(reconstruction), located(reconstruction).map(([number]) => number)]).toStrictEqual([['1 R'], [1]]);
  });

  it('lists as catalogs only dictionaries with Type Catalog and a Pages entry', () => {
    const text = `%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\n2 0 obj\n${streamBody('/Type/Catalog/Pages 4 0 R', 'x')}\nendobj\n3 0 obj <</Type/Catalog/Pages 4 0 R>> endobj\n`;
    expect(reconstruct(text).reconstruction.catalogs).toStrictEqual([3]);
  });

  it('reconstructs a file held as several segments as it reconstructs one buffer', () => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }],
        objectStreams: [{ number: 4, members: [{ number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }] }],
        trailer: '/Root 1 0 R',
      },
      { xref: 'classic', objects: [{ number: 3, body: '(later)' }], trailer: '/Root 1 0 R' },
    ]);
    const chunks = Array.from({ length: Math.ceil(pdf.bytes.length / 7) }, (_, index) => pdf.bytes.subarray(index * 7, index * 7 + 7));
    const context = { warn: () => undefined, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576, maxObjectStreamMembers: 100 };
    const whole = reconstructIndex(new ByteSource(pdf.bytes), context);
    expect(summary(reconstructIndex(new ByteSource(chunks), context))).toStrictEqual(summary(whole));
    expect(located(whole)).toStrictEqual([
      [1, 'file', pdf.offsets.get(1)],
      [2, 'compressed', 4],
      [3, 'file', pdf.offsets.get(3)],
      [4, 'file', pdf.offsets.get(4)],
      [5, 'file', pdf.sections[0]],
    ]);
  });

  it('propagates the nesting limit from an object it scans', () => {
    // loadDocument documents that limits raise ResourceLimitError; only malformed objects are skipped.
    const text = '%PDF-1.4\n1 0 obj [[[1]]] endobj\n';
    const nested = (maxNesting: number): Reconstruction =>
      reconstructIndex(new ByteSource(latin1Bytes(text)), {
        warn: () => undefined,
        names: new Map(),
        maxNesting,
        maxDecodedBytes: 1_048_576,
        maxObjectStreamMembers: 100,
      });
    expect(located(nested(3))).toStrictEqual([[1, 'file', 9]]);
    expect(() => nested(2)).toThrow(ResourceLimitError);
  });
});

describe('properties', () => {
  const body = fc.constantFrom('5', '(text)', '<</A 1>>', '[1 2 3]', 'null');
  const objects = fc.uniqueArray(fc.record({ number: fc.integer({ min: 1, max: 8 }), body }), { selector: object => object.number, maxLength: 5 });
  const section = fc.oneof(
    fc.record({ xref: fc.constant('classic' as const), objects }),
    fc.record({
      xref: fc.constant('stream' as const),
      objects,
      members: fc.uniqueArray(fc.record({ number: fc.integer({ min: 9, max: 12 }), body }), { selector: object => object.number, maxLength: 3 }),
    }),
  );

  const files = fc
    .array(section, { minLength: 1, maxLength: 3 })
    .map(drawn =>
      buildPdf(
        drawn.map((item, index): TestSection =>
          item.xref === 'stream' && item.members.length > 0
            ? { xref: 'stream', objects: item.objects, objectStreams: [{ number: 20 + index, members: item.members }] }
            : { xref: item.xref, objects: item.objects },
        ),
      ),
    );
  const context = { warn: () => undefined, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576, maxObjectStreamMembers: 100 };

  it('rebuilds the index the cross-reference chain of an intact file gives', () => {
    fc.assert(
      fc.property(files, pdf => {
        const source = new ByteSource(pdf.bytes);
        const chain = readSectionChain(source, { startxref: locateStartxref(source)?.offset ?? -1, shift: 0 }, context);
        const expected = ObjectIndex.fromSections(searchOrder(chain));
        const rebuilt = reconstructIndex(source, context).index;
        const numbers = [...expected.inUse()];
        expect([[...rebuilt.inUse()], numbers.map(number => rebuilt.get(number))]).toStrictEqual([numbers, numbers.map(number => expected.get(number))]);
      }),
    );
  });

  it('reconstructs the same index whatever the segment sizes', () => {
    fc.assert(
      fc.property(files, fc.integer({ min: 1, max: 64 }), (pdf, size) => {
        const chunks = Array.from({ length: Math.ceil(pdf.bytes.length / size) }, (_, index) => pdf.bytes.subarray(index * size, index * size + size));
        expect(summary(reconstructIndex(new ByteSource(chunks), context))).toStrictEqual(summary(reconstructIndex(new ByteSource(pdf.bytes), context)));
      }),
    );
  });
});
