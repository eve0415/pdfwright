import type { LoadWarning } from '../parse/loadWarning.ts';
import type { TestPdf, TestSection } from '../testing/pdfBuilder.ts';
import type { SectionChain } from './sectionChain.ts';
import type { XrefEntry, XrefSection } from './xrefSection.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { locateStartxref } from './locate.ts';
import { readSectionChain, searchOrder } from './sectionChain.ts';

interface Chain {
  chain: SectionChain;
  warnings: Array<LoadWarning>;
}

const chainOf = (bytes: Uint8Array, shift = 0): Chain => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const source = new ByteSource(bytes);
  const startxref = locateStartxref(source)?.offset ?? -1;
  const chain = readSectionChain(source, { startxref, shift }, { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 });
  return { chain, warnings };
};

// The offset a ParseError reports, or a description of the other outcome, so that one equality checks both the class and the offset.
const parseErrorOffset = (run: () => void): { readonly offset: number } | string => {
  try {
    run();
  } catch (error: unknown) {
    return error instanceof ParseError ? { offset: error.offset } : String(error);
  }
  return 'no error';
};

// The trailer dictionary of the newest classic section starts after its keyword trailer and the line end.
const newestTrailerStart = (text: string): number => text.lastIndexOf('trailer\n') + 'trailer\n'.length;

const order = (chain: SectionChain): Array<string> => searchOrder(chain).map(section => `${section.kind}@${String(section.offset)}`);

const expectedOrder = (pdf: TestPdf, formats: ReadonlyArray<string>): Array<string> =>
  pdf.sections.map((offset, index) => `${formats[index] ?? ''}@${String(offset)}`).toReversed();

const hybridOffset = (chain: SectionChain): number => chain.sections[0]?.hybrid?.offset ?? -1;

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };

const updated = (formats: ReadonlyArray<'classic' | 'stream'>): TestPdf =>
  buildPdf(formats.map((xref, index) => ({ xref, objects: index === 0 ? [catalog, pages] : [{ number: 3, body: String(index) }], trailer: '/Root 1 0 R' })));

const hybridPdf = (): TestPdf =>
  buildPdf([
    { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' },
    {
      xref: 'hybrid',
      objects: [{ number: 5, body: '<<>>' }],
      objectStreams: [{ number: 4, members: [{ number: 3, body: '(hidden)' }] }],
      trailer: '/Root 1 0 R',
    },
  ]);

describe('cross-reference section chains', () => {
  it('follows Prev from the newest section to the oldest', () => {
    for (const formats of [
      ['classic', 'classic', 'classic'],
      ['stream', 'stream'],
    ] as const) {
      const pdf = updated(formats);
      const { chain, warnings } = chainOf(pdf.bytes);
      expect(order(chain)).toStrictEqual(expectedOrder(pdf, formats));
      expect([chain.mixed, chain.startxrefCorrected, warnings]).toStrictEqual([false, false, []]);
    }
  });

  it('searches a hybrid section, then its XRefStm stream, then the previous section', () => {
    const pdf = buildPdf([
      { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' },
      {
        xref: 'hybrid',
        objects: [{ number: 5, body: '<<>>' }],
        objectStreams: [{ number: 4, members: [{ number: 3, body: '(hidden)' }] }],
        trailer: '/Root 1 0 R',
      },
    ]);
    const { chain } = chainOf(pdf.bytes);
    const [newest, oldest] = pdf.sections.toReversed();
    expect(order(chain)).toStrictEqual([`classic@${String(newest)}`, `stream@${String(hybridOffset(chain))}`, `classic@${String(oldest)}`]);
    expect([chain.mixed]).toStrictEqual([false]);
  });

  it('reports mixed chains, Prev cycles and a corrected startxref', () => {
    expect(chainOf(updated(['classic', 'stream']).bytes).warnings.map(warning => warning.code)).toStrictEqual(['mixed-xref-chain']);
    const pdf = updated(['classic', 'classic']);
    const [, newest = 0] = pdf.sections;
    const cyclic = pdf.text.replace(/\/Prev \d+/u, `/Prev ${String(newest)}`);
    expect(chainOf(latin1Bytes(cyclic)).warnings.map(warning => warning.code)).toStrictEqual(['prev-cycle']);
    const aliased = pdf.text.replace(/\/Prev \d+/u, `/Prev ${String(newest - 1)}`);
    const aliasedChain = chainOf(latin1Bytes(aliased));
    expect([aliasedChain.chain.sections.length, aliasedChain.warnings.map(warning => warning.code)]).toStrictEqual([1, ['prev-cycle']]);
    const shifted = pdf.text.replace(/startxref\n(\d+)\n%%EOF\n$/u, (_, offset: string) => `startxref\n${String(Number(offset) + 3)}\n%%EOF\n`);
    const corrected = chainOf(latin1Bytes(shifted));
    expect([corrected.chain.startxrefCorrected, corrected.warnings.map(warning => warning.code)]).toStrictEqual([true, ['startxref-corrected']]);
  });

  it('rejects a Prev entry that points into garbage or is not an offset', () => {
    const pdf = updated(['classic', 'classic']);
    expect(() => chainOf(latin1Bytes(pdf.text.replace(/\/Prev \d+/u, '/Prev 17')))).toThrow(ParseError);
    expect(() => chainOf(latin1Bytes(pdf.text.replace(/\/Prev \d+/u, '/Prev 4 0 R')))).toThrow(ParseError);
    expect(() => chainOf(latin1Bytes('%PDF-1.4\nnothing\nstartxref\n9\n%%EOF'))).toThrow(ParseError);
  });

  it('refuses to correct a Prev entry a few bytes off a section, unlike startxref', () => {
    const pdf = updated(['classic', 'classic']);
    const [oldest = 0] = pdf.sections;
    const text = pdf.text.replace(/\/Prev \d+/u, `/Prev ${String(oldest + 2)}`);
    expect(parseErrorOffset(() => chainOf(latin1Bytes(text)))).toStrictEqual({ offset: oldest + 2 });
  });

  // ISO 32000-1:2008, 7.5.5, Table 15 gives Prev, and 7.5.8.4, Table 19 gives XRefStm, as byte offsets.
  it.each([
    ['a negative Prev', (pdf: TestPdf): string => pdf.text.replace(/\/Prev \d+/u, '/Prev -1'), (): TestPdf => updated(['classic', 'classic'])],
    ['an XRefStm that is a reference', (pdf: TestPdf): string => pdf.text.replace(/\/XRefStm \d+/u, '/XRefStm 4 0 R'), hybridPdf],
  ])('rejects %s at the start of its trailer', (_, edit, build) => {
    const text = edit(build());
    expect(parseErrorOffset(() => chainOf(latin1Bytes(text)))).toStrictEqual({ offset: newestTrailerStart(text) });
  });

  // ISO 32000-1:2008, 7.5.8.4, Table 19: XRefStm gives the byte offset of a cross-reference stream.
  it('rejects an XRefStm entry that points at an object other than a cross-reference stream', () => {
    const pdf = hybridPdf();
    const text = pdf.text.replace(/\/XRefStm \d+/u, `/XRefStm ${String(pdf.offsets.get(1) ?? 0)}`);
    expect(() => chainOf(latin1Bytes(text))).toThrow(ParseError);
  });

  it('adds the header position to Prev and XRefStm offsets in a header-relative file', () => {
    // A file whose offsets count from its header, behind 4 bytes of junk, is read with a shift of 4.
    const pdf = buildPdf([
      { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' },
      { xref: 'classic', objects: [{ number: 3, body: '(update)' }], trailer: '/Root 1 0 R' },
      {
        xref: 'hybrid',
        objects: [{ number: 5, body: '<<>>' }],
        objectStreams: [{ number: 4, members: [{ number: 6, body: '(hidden)' }] }],
        trailer: '/Root 1 0 R',
      },
    ]);
    const { chain, warnings } = chainOf(latin1Bytes(`JUNK${pdf.text}`), 4);
    const [newest = 0, middle = 0, oldest = 0] = pdf.sections.toReversed();
    const stream = Number(/\/XRefStm (\d+)/u.exec(pdf.text)?.[1]);
    expect([order(chain), warnings]).toStrictEqual([
      [`classic@${String(newest + 4)}`, `stream@${String(stream + 4)}`, `classic@${String(middle + 4)}`, `classic@${String(oldest + 4)}`],
      [],
    ]);
  });
});

interface ChainView {
  readonly sections: Array<readonly [XrefSection['kind'], number, ReadonlyArray<XrefEntry>, number, number]>;
  readonly mixed: boolean;
  readonly codes: Array<LoadWarning['code']>;
}

// Each section with its offset, entries and trailer span, and the chain's warnings, so that two reads can be compared whole.
const viewOf = (bytes: Uint8Array | ReadonlyArray<Uint8Array>, startxref: number): ChainView => {
  const warnings: Array<LoadWarning> = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const chain = readSectionChain(new ByteSource(bytes), { startxref, shift: 0 }, { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 });
  return {
    sections: searchOrder(chain).map(section => [section.kind, section.offset, section.entries, section.trailerStart, section.trailerEnd] as const),
    mixed: chain.mixed,
    codes: warnings.map(warning => warning.code),
  };
};

describe('properties', () => {
  const formats = fc.array(fc.constantFrom<'classic' | 'stream' | 'hybrid'>('classic', 'stream', 'hybrid'), { minLength: 1, maxLength: 3 });

  it('reads the same chain whatever the segment sizes', () => {
    fc.assert(
      fc.property(formats, fc.integer({ min: 1, max: 64 }), (drawn, size) => {
        const pdf = buildPdf(
          drawn.map((xref, index): TestSection => ({
            xref,
            objects: index === 0 ? [catalog, pages] : [{ number: 3, body: String(index) }],
            objectStreams: xref === 'classic' ? [] : [{ number: 10 + index, members: [{ number: 20 + index, body: `(member ${String(index)})` }] }],
            trailer: '/Root 1 0 R',
          })),
        );
        const chunks = Array.from({ length: Math.ceil(pdf.bytes.length / size) }, (_, index) => pdf.bytes.subarray(index * size, index * size + size));
        const startxref = pdf.sections.at(-1) ?? 0;
        expect(viewOf(chunks, startxref)).toStrictEqual(viewOf(pdf.bytes, startxref));
      }),
    );
  });
});
