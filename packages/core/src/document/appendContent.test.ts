import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { cmyk } from './color.ts';
import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const load = (objects: readonly TestObject[]): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...objects], trailer: '/Root 1 0 R' }]).bytes);

const page = (extra: string): TestObject[] => [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
  { number: 3, body: `<</Type/Page/Parent 2 0 R${extra}>>` },
  { number: 4, body: streamBody('', '0 0 m 10 10 l S') },
];

const text = (value: PdfObject): string => latin1Text(serializeObject(value, { fractionDigits: 5 }));

const object = (document: LoadedDocument, number: number): string => text(document.get(pdfReference(number, 0)));

// The content of a stream object, inflated when it is compressed.
const content = (document: LoadedDocument, number: number): string => {
  const value = document.get(pdfReference(number, 0));
  if (value.kind !== 'stream') return '';
  return latin1Text(value.dictionary.has(pdfName('Filter').bytes) ? inflateZlib(value.data).data : value.data);
};

describe('appending page content', () => {
  it('wraps existing content in q and Q and adds a stream after it', () => {
    const document = load(page('/Contents 4 0 R/Resources<<>>'));
    document.page(0).appendContent(latin1Bytes('1 0 0 rg 0 0 5 5 re f'));
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Contents[6 0 R 4 0 R 7 0 R 5 0 R]/Resources<<>>>>');
    expect([content(document, 6), content(document, 4), content(document, 7), content(document, 5)]).toStrictEqual([
      'q\n',
      '0 0 m 10 10 l S',
      'Q\n',
      '1 0 0 rg 0 0 5 5 re f',
    ]);
  });

  it('appends without wrapping when asked, and to pages with no content or an indirect content array', () => {
    const plain = load(page('/Contents[4 0 R]/Resources<<>>'));
    plain.page(0).appendContent(latin1Bytes('n'), { isolate: false });
    expect(object(plain, 3)).toBe('<</Type/Page/Parent 2 0 R/Contents[4 0 R 5 0 R]/Resources<<>>>>');
    const empty = load(page('/Resources<<>>'));
    empty.page(0).appendContent(latin1Bytes('n'));
    expect(object(empty, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<<>>/Contents 5 0 R>>');
    const indirect = load([...page('/Contents 9 0 R/Resources<<>>'), { number: 9, body: '[4 0 R]' }]);
    indirect.page(0).appendContent(latin1Bytes('n'));
    expect([object(indirect, 3), object(indirect, 9)]).toStrictEqual([
      '<</Type/Page/Parent 2 0 R/Contents[11 0 R 4 0 R 12 0 R 10 0 R]/Resources<<>>>>',
      '[4 0 R]',
    ]);
  });

  it('draws with the content builder under resource names the page does not use yet', () => {
    const document = load(page('/Contents 4 0 R/Resources<</ColorSpace<</CS1/DeviceGray>>>>'));
    const spot = document.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) });
    document.page(0).appendContent(builder => {
      builder.fillColor(spot, 1);
      builder.path(path => path.rect(0, 0, 10, 10));
      builder.fill('nonzero');
    });
    expect(content(document, 5)).toBe('q\n/CS2 cs\n1 scn\n0 0 10 10 re\nf\nQ\n');
    document.page(0).appendContent(builder => {
      builder.strokeColor(spot, 0.5);
    });
    expect(content(document, 8)).toBe('q\n/CS2 CS\n0.5 SCN\nQ\n');
    expect(object(document, 3)).toContain('/Resources<</ColorSpace<</CS1/DeviceGray/CS2[/Separation /Spot /DeviceCMYK <<');
  });

  it('refuses group PieceInfo once content has drawn the group', () => {
    const document = load(page('/Resources<<>>'));
    const group = document.group({ bbox: rect(pt(0), pt(0), pt(10), pt(10)) }, builder => {
      builder.path(path => path.rect(0, 0, 5, 5));
      builder.fill('nonzero');
    });
    const data = { Example: { private: { kind: 'null' } } } as const;
    group.pieceInfo({ lastModified: pdfDate({ year: 2026, month: 1, day: 1, hour: 0, minute: 0, second: 0, offset: 'Z' }), data });
    document.page(0).appendContent(builder => {
      builder.group(group, [1, 0, 0, 1, 0, 0]);
    });
    expect(() => {
      group.pieceInfo({ lastModified: pdfDate({ year: 2026, month: 1, day: 2, hour: 0, minute: 0, second: 0, offset: 'Z' }), data });
    }).toThrow(ValidationError);
  });

  it('raises the catalog version for transparent graphics states in a PDF 1.3 file', () => {
    const written = latin1Text(
      buildPdf([{ xref: 'classic', objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, ...page('/Resources<<>>')], trailer: '/Root 1 0 R' }]).bytes,
    );
    const old = loadDocument(latin1Bytes(written.replace('%PDF-1.7', '%PDF-1.3')));
    old.page(0).appendContent(builder => {
      builder.graphicsState({ fillAlpha: 0.5 });
    });
    const saved = old.save();
    expect([saved.warnings.map(warning => warning.code), loadDocument(saved.chunks).catalog().get(pdfName('Version').bytes)]).toStrictEqual([
      ['version-raised'],
      pdfName('1.4'),
    ]);
  });

  it('writes an image once however often content draws it', () => {
    const document = load(page('/Resources<<>>'));
    const image = document.image({
      width: 1,
      height: 1,
      colorSpace: 'DeviceGray',
      bitsPerComponent: 8,
      samples: Uint8Array.of(128),
      softMask: { width: 1, height: 1, samples: Uint8Array.of(255) },
    });
    for (let round = 0; round < 2; round++) {
      document.page(0).appendContent(builder => {
        builder.image(image, [10, 0, 0, 10, 0, 0]);
      });
    }
    expect(object(document, 3)).toBe('<</Type/Page/Parent 2 0 R/Resources<</XObject<</Im1 6 0 R>>>>/Contents[9 0 R 7 0 R 10 0 R 8 0 R]>>');
    expect([document.get(pdfReference(5, 0)).kind, object(document, 6).includes('/SMask 5 0 R')]).toStrictEqual(['stream', true]);
  });
});
