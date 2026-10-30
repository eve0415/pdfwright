import type { LoadWarning } from '../parse/loadWarning.ts';
import type { Reconstruction } from './recover.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { ABSENT, COMPRESSED, IN_FILE } from './objectIndex.ts';
import { reconstructIndex } from './recover.ts';

interface Result {
  reconstruction: Reconstruction;
  warnings: LoadWarning[];
}

const reconstruct = (text: string, maxObjectStreamMembers = 100, maxDecodedBytes = 1_048_576): Result => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const context = { warn, names: new Map(), maxNesting: 256, maxDecodedBytes, maxObjectStreamMembers };
  return { reconstruction: reconstructIndex(new ByteSource(latin1Bytes(text)), context), warnings };
};

const located = (reconstruction: Reconstruction): (number | string)[][] =>
  [...reconstruction.index.inUse()].map(number => {
    const entry = reconstruction.index.get(number);
    return [number, entry.type === IN_FILE ? 'file' : 'compressed', entry.location];
  });

const rootOf = (reconstruction: Reconstruction): string[] =>
  reconstruction.trailers.map(trailer => {
    const root = trailer.get(pdfName('Root').bytes);
    return root?.kind === 'reference' ? `${String(root.objectNumber)} R` : '-';
  });

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
});
