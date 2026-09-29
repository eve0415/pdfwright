import type { IllustratorDocument, PathItem, Subpath } from '../model/illustratorDocument.ts';
import type { ReadIllustratorPdfOptions } from './readIllustratorPdf.ts';

import {
  InvalidArgumentError,
  ParseError,
  PdfDictionaryEntries,
  UnsupportedFeatureError,
  ValidationError,
  createDocument,
  deflateZlib,
  mm,
  pdfDate,
  pdfDateString,
  pdfDictionary,
  pdfName,
  pt,
  rect,
} from '@pdfwright/core';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { writeNative } from '../native/writeNative.ts';
import { numberDeviation } from '../testing/modelNumbers.ts';
import { normalizeModel } from '../testing/normalizeModel.ts';
import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

import { readIllustratorPdf } from './readIllustratorPdf.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: { sign: '+', hours: 9, minutes: 0 } });
const outline: Subpath = {
  start: [mm(5), mm(5)],
  segments: [
    { kind: 'line', to: [mm(35), mm(5)] },
    { kind: 'line', to: [mm(35), mm(25)] },
    { kind: 'line', to: [mm(5), mm(25)] },
  ],
};
const hole: Subpath = {
  start: [mm(15), mm(10)],
  segments: [
    { kind: 'quadratic', control: [mm(20), mm(20)], to: [mm(25), mm(10)], anchor: 'smooth' },
    { kind: 'line', to: [mm(15), mm(10)] },
  ],
};
const die: PathItem = {
  kind: 'path',
  geometry: { subpaths: [outline] },
  stroke: { paint: { kind: 'spot', spot: { name: 'Cut', alternate: [0, 1, 0, 0] } }, width: 0 },
};
const model: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3), name: 'Sheet' },
  layers: [
    { name: 'Hidden', visible: false, locked: true, items: [die] },
    {
      name: 'Artwork',
      opacity: 0.5,
      items: [
        { kind: 'path', geometry: { subpaths: [outline, hole], fillRule: 'evenodd' }, fill: { paint: { kind: 'process', cmyk: [0, 0.5, 1, 0] } } },
        {
          kind: 'clipGroup',
          clip: { subpaths: [outline, hole] },
          items: [
            {
              kind: 'raster',
              width: 2,
              height: 1,
              bounds: { x: mm(10), y: mm(12), width: mm(20), height: mm(10) },
              color: { space: 'cmyk', samples: Uint8Array.of(0, 0, 0, 255, 13, 10, 0, 0) },
              alpha: Uint8Array.of(255, 128),
            },
          ],
        },
        { kind: 'group', opacity: 0.3, isolated: true, items: [{ ...die, locked: true }] },
      ],
    },
  ],
  lastModified: date,
  title: 'Sheet (front)',
};
const pathOnly: IllustratorDocument = { ...model, layers: [{ name: 'Die', items: [die] }] };
const options: ReadIllustratorPdfOptions = { zstandard: decompress };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const thrown = (action: () => void): Error | undefined => {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw error;
  }
  return undefined;
};

// Builds the page-piece container around a wrapped native payload, as attachPrivateData does for the Zstandard wrapper.
const wrappedPdf = (wrapper: string, payload: Uint8Array): Uint8Array => {
  const document = createDocument();
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(70)) });
  const header = encoder.encode(wrapper);
  const block = new Uint8Array(header.length + payload.length);
  block.set(header);
  block.set(payload, header.length);
  const entries = new PdfDictionaryEntries();
  entries.set(pdfName('AIPDFPrivateData1').bytes, document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: block }));
  page.pieceInfo({ lastModified: date, data: { Illustrator: { private: document.object(pdfDictionary(entries)) } } });
  return document.save().toBytes();
};

describe('reading package output', () => {
  it('reads the artwork and header of a bottom-left native copy', () => {
    const read = readIllustratorPdf(writeIllustratorPdf(model), options);
    expect(read.document).toStrictEqual(normalizeModel(model));
    expect(read.nativeOrigin).toBe('artboard-bottom-left');
    expect(read.header.get('%AI3_Cropmarks')).toBe('0 0 283.4645669291 198.4251968504');
    expect(read.native).toStrictEqual(writeNative(model).bytes);
  });

  it('reports the container facts of package output', () => {
    const read = readIllustratorPdf(writeIllustratorPdf(model), options);
    const dateBytes = encoder.encode(pdfDateString(date));
    expect(read.lastModified).toStrictEqual({ page: dateBytes, application: dateBytes });
    expect(read.privateDataKeys).toStrictEqual([
      'AIMetaData',
      'AIPDFPrivateData1',
      'ContainerVersion',
      'CreatorVersion',
      'RoundtripStreamType',
      'RoundtripVersion',
    ]);
    expect(read.blockLengths).toHaveLength(1);
    expect(read.compression).toStrictEqual({ kind: 'zstandard', frameHeaderDescriptor: 0, windowDescriptor: 0x58 });
  });

  it('reads a top-left native copy back into model coordinates', () => {
    const read = readIllustratorPdf(writeIllustratorPdf(model, { nativeOrigin: 'artboard-top-left' }), options);
    expect(read.nativeOrigin).toBe('artboard-top-left');
    expect(read.header.get('%AI3_Cropmarks')).toBe('0 -198.4251968504 283.4645669291 0');
    expect(read.native).toStrictEqual(writeNative(model, { nativeOrigin: 'artboard-top-left' }).bytes);
    expect(numberDeviation(read.document, normalizeModel(model))).toBeLessThan(1.5e-10);
    expect(writeNative(read.document, { nativeOrigin: 'artboard-top-left' }).bytes).toStrictEqual(read.native);
  });

  it('keeps compound paths and compound clips as one item each', () => {
    const read = readIllustratorPdf(writeIllustratorPdf(model), options);
    const items = read.document.layers[1]?.items;
    expect(items?.[0]).toMatchObject({ kind: 'path', geometry: { fillRule: 'evenodd', subpaths: [{}, {}] } });
    expect(items?.[1]).toMatchObject({ kind: 'clipGroup', clip: { fillRule: 'nonzero', subpaths: [{}, {}] } });
  });

  it('passes the caller decoder the Zstandard frame after the wrapper', () => {
    const frames: Uint8Array[] = [];
    const recording: ReadIllustratorPdfOptions = {
      zstandard: frame => {
        frames.push(frame);
        return decompress(frame);
      },
    };
    readIllustratorPdf(writeIllustratorPdf(pathOnly), recording);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.subarray(0, 4)).toStrictEqual(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd));
  });

  it('inflates a zlib-wrapped payload without the Zstandard decoder', () => {
    const native = writeNative(model).bytes;
    const refusing: ReadIllustratorPdfOptions = {
      zstandard: () => {
        throw new Error('the zlib payload must not reach the Zstandard decoder');
      },
    };
    const read = readIllustratorPdf(wrappedPdf('%AI12_CompressedData', deflateZlib(native)), refusing);
    expect(read.compression).toStrictEqual({ kind: 'zlib' });
    expect(read.native).toStrictEqual(native);
    expect(read.privateDataKeys).toStrictEqual(['AIPDFPrivateData1']);
    expect(read.document).toStrictEqual(normalizeModel(model));
  });
});

describe('refusals', () => {
  it('refuses a missing or non-function Zstandard decoder', () => {
    const missing: ReadIllustratorPdfOptions = { zstandard: decompress };
    Object.defineProperty(missing, 'zstandard', { value: 'fzstd' });
    const pdf = writeIllustratorPdf(pathOnly);
    expect(() => readIllustratorPdf(pdf, missing)).toThrow(InvalidArgumentError);
  });

  it('refuses a decoder that returns something other than bytes', () => {
    const wrong: ReadIllustratorPdfOptions = { zstandard: decompress };
    Object.defineProperty(wrong, 'zstandard', { value: () => [1, 2, 3] });
    const pdf = writeIllustratorPdf(pathOnly);
    expect(() => readIllustratorPdf(pdf, wrong)).toThrow(InvalidArgumentError);
  });

  it('refuses a PDF without Illustrator page-piece data', () => {
    const document = createDocument();
    document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
    const pdf = document.save().toBytes();
    expect(() => readIllustratorPdf(pdf, options)).toThrow(ValidationError);
  });

  it('refuses an unknown compression wrapper', () => {
    const pdf = wrappedPdf('%AI99_UnknownPayload', Uint8Array.of(1, 2, 3));
    expect(() => readIllustratorPdf(pdf, options)).toThrow(UnsupportedFeatureError);
  });

  it('refuses native grammar the reader does not support', () => {
    const native = decoder.decode(writeNative(pathOnly).bytes).replace('0 Xw\r', '0 Xw\r1 Xz\r');
    const pdf = writeIllustratorPdf(pathOnly);
    const error = thrown(() => {
      readIllustratorPdf(pdf, { zstandard: () => encoder.encode(native) });
    });
    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    expect(error).toMatchObject({ message: `unknown native layer operator 1 Xz at native byte ${String(native.indexOf('1 Xz\r'))}` });
  });

  it('reports malformed native bytes with their offset', () => {
    const native = writeNative(pathOnly).bytes;
    const truncated = native.subarray(0, -1);
    const pdf = writeIllustratorPdf(pathOnly);
    const error = thrown(() => {
      readIllustratorPdf(pdf, { zstandard: () => truncated });
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: truncated.lastIndexOf(13) + 1 });
  });
});
