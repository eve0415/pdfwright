import { PdfwrightError, ParseError, cmyk, createDocument, listColorants, loadDocument, pdfDate, pt, rect } from '@pdfwright/core';
import { readIllustratorPdf, writeIllustratorPdf } from '@pdfwright/illustrator';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

// Each package is imported by its name, so its exports map is resolved as a dependent workspace package resolves it.
const entries = { '@pdfwright/core': await import('@pdfwright/core'), '@pdfwright/illustrator': await import('@pdfwright/illustrator') };

const manifests = import.meta.glob('../packages/*/package.json', { eager: true });

const packageName = (manifest: ModuleNamespace): string => {
  if (!('name' in manifest) || typeof manifest.name !== 'string') {
    throw new TypeError('a package manifest has no name');
  }
  return manifest.name;
};

describe('public API', () => {
  it('imports every workspace package by name', () => {
    expect(Object.values(manifests).map(packageName).toSorted()).toStrictEqual(Object.keys(entries));
  });

  it('exports exactly these values from each package entry', () => {
    // A rename or removal here breaks dependents, so the list changes only on purpose.
    expect(Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, Object.keys(entry).toSorted()]))).toStrictEqual({
      '@pdfwright/core': [
        'CORE_BOX_TOLERANCE',
        'DEFAULT_FRACTION_DIGITS',
        'EncryptedDocumentError',
        'InvalidArgumentError',
        'InvalidProfileError',
        'ParseError',
        'PdfDictionaryEntries',
        'PdfwrightError',
        'ResourceLimitError',
        'UnsupportedFeatureError',
        'ValidationError',
        'add',
        'adler32',
        'checkPdfX4',
        'cmyk',
        'compare',
        'compareDocuments',
        'convertToCmyk',
        'createColorTransform',
        'createDeflateStream',
        'createDocument',
        'createPdfFunction',
        'createPdfFunctionReader',
        'decodeJpeg',
        'decodePng',
        'deflateRaw',
        'deflateZlib',
        'equals',
        'extractText',
        'formatInteger',
        'formatLength',
        'formatNumber',
        'gray',
        'inch',
        'inflateChunks',
        'inflateRaw',
        'inflateZlib',
        'listColorants',
        'listFonts',
        'loadDocument',
        'matchText',
        'md5',
        'mm',
        'multiply',
        'negate',
        'orderGlyphs',
        'parseIccProfile',
        'parsePdfDate',
        'pdfArray',
        'pdfDate',
        'pdfDateFromDate',
        'pdfDateString',
        'pdfDictionary',
        'pdfInteger',
        'pdfLiteralString',
        'pdfName',
        'pdfNameFromBytes',
        'pdfReal',
        'pdfReference',
        'pdfString',
        'pdfX4Rules',
        'pngToRgba8',
        'preparePdfX4Pages',
        'pt',
        'readMetadata',
        'rect',
        'registeredPrintingConditions',
        'rgb',
        'serializeObject',
        'setMetadata',
        'srgbColorSource',
        'srgbProfileBytes',
        'subtract',
        'writeGtsPdfxOutputIntent',
        'writePdfX4Metadata',
      ],
      '@pdfwright/illustrator': ['readIllustratorPdf', 'writeIllustratorPdf'],
    });
  });
});

describe('@pdfwright/core', () => {
  it('loads back the boxes and spot colorants of a page it saved', () => {
    const document = createDocument();
    const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
    const cut = document.separation({ name: 'Cut', alternate: cmyk(0, 1, 0, 0) });
    const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(200), pt(100)), trimBox: rect(pt(10), pt(20), pt(190), pt(90)) });
    page.draw(content => {
      content.fillColor(white, 1);
      content.path(path => path.rect(10, 20, 30, 40));
      content.fill('nonzero');
      content.strokeColor(cut, 1);
      content.path(path => path.rect(10, 20, 180, 70));
      content.stroke();
    });

    const loaded = loadDocument(document.save().toBytes());
    const { MediaBox, TrimBox, BleedBox } = loaded.page(0).boxes();
    expect({ pageCount: loaded.pageCount, MediaBox, TrimBox, BleedBox }).toStrictEqual({
      pageCount: 1,
      MediaBox: { explicit: true, rect: [0, 0, 200, 100] },
      TrimBox: { explicit: true, rect: [10, 20, 190, 90] },
      BleedBox: { explicit: false, rect: [0, 0, 200, 100] },
    });
    const colorants = listColorants(loaded).flatMap(({ colorants: list }) =>
      list.map(({ name, kind, painted }) => ({ name: new TextDecoder().decode(name), kind, painted })),
    );
    expect(colorants.toSorted((a, b) => a.name.localeCompare(b.name))).toStrictEqual([
      { name: 'Cut', kind: 'spot', painted: ['stroke'] },
      { name: 'White', kind: 'spot', painted: ['fill'] },
    ]);
  });

  it('refuses bytes that are not a PDF with the exported error classes', () => {
    const notPdf = new TextEncoder().encode('not a pdf');
    expect(() => loadDocument(notPdf)).toThrow(ParseError);
    expect(() => loadDocument(notPdf)).toThrow(PdfwrightError);
  });
});

describe('@pdfwright/illustrator', () => {
  it('reads back the layers and artboard it wrote', () => {
    const lastModified = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
    const bytes = writeIllustratorPdf({
      artboard: { width: 100, height: 70 },
      layers: [
        { name: 'Die', items: [] },
        { name: 'Cut', visible: false, items: [] },
      ],
      lastModified,
    });

    const read = readIllustratorPdf(bytes, { zstandard: decompress });
    expect(read.document.layers.map(({ name, visible }) => ({ name, visible }))).toStrictEqual([
      { name: 'Die', visible: true },
      { name: 'Cut', visible: false },
    ]);
    expect([read.document.artboard.width, read.document.artboard.height, read.document.lastModified]).toStrictEqual([100, 70, lastModified]);
    expect(loadDocument(bytes).page(0).boxes().MediaBox.rect).toStrictEqual([0, 0, 100, 70]);
  });
});
