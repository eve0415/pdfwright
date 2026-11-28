import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { SampledCmykFunction } from './sampleCmykFunction.ts';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { stitchCmykFunction, writeCmykFunction } from './stitchCmykFunction.ts';

const documentWith = (objects: ReadonlyArray<TestObject>): LoadedDocument =>
  loadDocument(
    buildPdf([
      {
        xref: 'classic',
        trailer: '/Root 1 0 R',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>' },
          ...objects,
        ],
      },
    ]).bytes,
  );

const sampled = (marker: number): SampledCmykFunction => ({
  kind: 'sampled',
  dictionary: new PdfDictionaryEntries([[pdfName('FunctionType').bytes, pdfInteger(0)]]),
  data: Uint8Array.of(marker),
  maxDeltaE2000: 0,
});

interface Recorder {
  readonly children: Array<PdfObject>;
  readonly compose: (child: PdfObject) => SampledCmykFunction;
}

// Records each subfunction it is handed and returns a sampled function marked with its position.
const recorder = (): Recorder => {
  const children: Array<PdfObject> = [];
  return {
    children,
    compose: child => {
      children.push(child);
      return sampled(children.length);
    },
  };
};

const entry = (entries: PdfDictionaryEntries, name: string): PdfObject | undefined => entries.get(pdfName(name).bytes);

const dictionaryAt = (document: LoadedDocument, number: number): PdfDictionaryEntries => {
  const object = document.get(pdfReference(number, 0));
  if (object.kind !== 'dictionary') {
    throw new Error(`object ${String(number)} is not a dictionary`);
  }
  return object.entries;
};

const children = [
  { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 1 0]/N 1>>' },
  { number: 9, body: '<</FunctionType 2/Domain[0 1]/C0[0 1 0]/C1[0 0 1]/N 2>>' },
];

describe('stitched CMYK functions', () => {
  // ISO 32000-1:2008, 7.10.4 Table 41: a Type 3 function is a dictionary whose Functions array holds one or more subfunctions.
  it.each([
    ['an integer', '6'],
    ['a dictionary with no Functions', '<</FunctionType 3/Domain[0 1]/Bounds[]/Encode[0 1]>>'],
    ['a Functions entry that is not an array', '<</FunctionType 3/Domain[0 1]/Functions 8 0 R/Bounds[]/Encode[0 1]>>'],
    ['an empty Functions array', '<</FunctionType 3/Domain[0 1]/Functions[]/Bounds[]/Encode[0 1]>>'],
    ['an indirect empty Functions array', '<</FunctionType 3/Domain[0 1]/Functions 7 0 R/Bounds[]/Encode[0 1]>>'],
    ['a Functions array naming a missing object', '<</FunctionType 3/Domain[0 1]/Functions[99 0 R]/Bounds[]/Encode[0 1]>>'],
    ['a Functions array holding null', '<</FunctionType 3/Domain[0 1]/Functions[null]/Bounds[]/Encode[0 1]>>'],
  ])('refuses %s', (_, body) => {
    const document = documentWith([{ number: 6, body }, { number: 7, body: '[]' }, ...children]);
    const source = document.get(pdfReference(6, 0));
    const { children: composed, compose } = recorder();
    expect(() => stitchCmykFunction(document, source, compose)).toThrow(ValidationError);
    expect(() => stitchCmykFunction(document, source, compose)).toThrow(expect.objectContaining({ reason: 'color-space' }));
    expect(composed).toStrictEqual([]);
  });

  it.each([
    ['a direct Functions array', '[8 0 R 9 0 R]'],
    ['an indirect Functions array', '7 0 R'],
  ])('composes each subfunction of %s in order', (_, functions) => {
    const document = documentWith([
      { number: 6, body: `<</FunctionType 3/Domain[0 1]/Functions ${functions}/Bounds[0.5]/Encode[0 1 0 1]>>` },
      { number: 7, body: '[8 0 R 9 0 R]' },
      ...children,
    ]);
    const { children: composed, compose } = recorder();
    const stitched = stitchCmykFunction(document, document.get(pdfReference(6, 0)), compose);
    expect(composed).toStrictEqual([document.get(pdfReference(8, 0)), document.get(pdfReference(9, 0))]);
    expect(stitched.functions).toStrictEqual([sampled(1), sampled(2)]);
  });

  it('keeps the source Domain, Bounds and Encode and declares a CMYK Range', () => {
    const document = documentWith([
      { number: 6, body: '<</FunctionType 3/Domain[0.2 0.9]/Functions[8 0 R 9 0 R]/Bounds 10 0 R/Encode[0 1 1 0]/Range[0 1 0 1 0 1]>>' },
      { number: 10, body: '[0.4]' },
      ...children,
    ]);
    const source = dictionaryAt(document, 6);
    const { dictionary } = stitchCmykFunction(document, document.get(pdfReference(6, 0)), recorder().compose);
    expect(['FunctionType', 'Domain', 'Bounds', 'Encode'].map(name => entry(dictionary, name))).toStrictEqual(
      ['FunctionType', 'Domain', 'Bounds', 'Encode'].map(name => entry(source, name)),
    );
    expect(entry(dictionary, 'Bounds')).toStrictEqual(pdfReference(10, 0));
    // ISO 32000-1:2008, 7.10.1 Table 38: Range holds a minimum and maximum for each of the four CMYK outputs.
    expect(entry(dictionary, 'Range')).toStrictEqual(pdfArray([0, 1, 0, 1, 0, 1, 0, 1].map(value => pdfInteger(value))));
  });

  it('writes one sampled stream per subfunction into the wrapper Functions array', () => {
    const document = documentWith([{ number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions[8 0 R 9 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' }, ...children]);
    const stitched = stitchCmykFunction(document, document.get(pdfReference(6, 0)), recorder().compose);
    const written = writeCmykFunction(document, stitched);
    const functions = entry(dictionaryAt(document, written.objectNumber), 'Functions');
    if (functions?.kind !== 'array') {
      throw new Error('the written wrapper has no Functions array');
    }
    expect(
      functions.items.map(item => {
        const stream = item.kind === 'reference' ? document.get(item) : item;
        return stream.kind === 'stream' ? stream.data : stream;
      }),
    ).toStrictEqual([Uint8Array.of(1), Uint8Array.of(2)]);
    expect(entry(dictionaryAt(document, written.objectNumber), 'Bounds')).toStrictEqual(entry(dictionaryAt(document, 6), 'Bounds'));
  });

  it('writes a sampled function as one stream', () => {
    const document = documentWith([]);
    const written = document.get(writeCmykFunction(document, sampled(7)));
    expect(written.kind === 'stream' ? [entry(written.dictionary, 'FunctionType'), written.data] : written).toStrictEqual([pdfInteger(0), Uint8Array.of(7)]);
  });
});
