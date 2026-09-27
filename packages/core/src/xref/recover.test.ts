import type { LoadWarning } from '../parse/loadWarning.ts';
import type { Reconstruction } from './recover.ts';

import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';

import { COMPRESSED, IN_FILE } from './objectIndex.ts';
import { reconstructIndex } from './recover.ts';

interface Result {
  reconstruction: Reconstruction;
  warnings: LoadWarning[];
}

const reconstruct = (text: string, maxObjectStreamMembers = 100): Result => {
  const warnings: LoadWarning[] = [];
  const warn = (warning: LoadWarning): void => {
    warnings.push(warning);
  };
  const context = { warn, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576, maxObjectStreamMembers };
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

  it('prefers the later copy and reports copies that differ', () => {
    const same = reconstruct('%PDF-1.4\n3 0 obj (a) endobj\n3 0 obj (a) endobj\n').reconstruction;
    expect([located(same), same.ambiguous]).toStrictEqual([[[3, 'file', 28]], []]);
    const different = reconstruct('%PDF-1.4\n3 0 obj (a) endobj\n3 0 obj (b) endobj\n').reconstruction;
    expect([located(different), different.ambiguous]).toStrictEqual([[[3, 'file', 28]], [3]]);
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
