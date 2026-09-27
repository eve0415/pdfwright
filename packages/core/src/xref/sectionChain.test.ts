import type { LoadWarning } from '../parse/loadWarning.ts';
import type { TestPdf } from '../testing/pdfBuilder.ts';
import type { SectionChain } from './sectionChain.ts';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { locateStartxref } from './locate.ts';
import { readSectionChain, searchOrder } from './sectionChain.ts';

interface Chain {
  chain: SectionChain;
  warnings: LoadWarning[];
}

const chainOf = (bytes: Uint8Array): Chain => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const source = new ByteSource(bytes);
  const startxref = locateStartxref(source)?.offset ?? -1;
  const chain = readSectionChain(source, { startxref, shift: 0 }, { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 });
  return { chain, warnings };
};

const order = (chain: SectionChain): string[] => searchOrder(chain).map(section => `${section.kind}@${String(section.offset)}`);

const expectedOrder = (pdf: TestPdf, formats: readonly string[]): string[] =>
  pdf.sections.map((offset, index) => `${formats[index] ?? ''}@${String(offset)}`).toReversed();

const hybridOffset = (chain: SectionChain): number => chain.sections[0]?.hybrid?.offset ?? -1;

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };

const updated = (formats: readonly ('classic' | 'stream')[]): TestPdf =>
  buildPdf(formats.map((xref, index) => ({ xref, objects: index === 0 ? [catalog, pages] : [{ number: 3, body: String(index) }], trailer: '/Root 1 0 R' })));

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
});
