import type { ShapedPdfInput } from '../testing/illustratorShapedPdf.ts';

import { ParseError, UnsupportedFeatureError, ValidationError, createDocument, deflateZlib, pdfDate, pt, rect } from '@pdfwright/core';
import fc from 'fast-check';
import { decompress } from 'fzstd';
import { describe, expect, it } from 'vitest';

import { attachPrivateData } from '../container/privateData.ts';
import { SHAPED_DATE, illustratorShapedPdf, zlibWrapped } from '../testing/illustratorShapedPdf.ts';
import { rawZstandardFrame } from '../testing/rawZstandardFrame.ts';
import { encodeRawFrame, encodeZstandardFrame } from '../zstd/frame.ts';

import { readIllustratorContainer } from './readContainer.ts';

const encoder = new TextEncoder();
const native = encoder.encode('%!PS-Adobe-3.0 \r%%Title: (Container)\r%%EndComments\r%AI5_BeginLayer\r');
const wrapped = zlibWrapped(native);
const metaData = native.subarray(0, 46);
const block = { key: 'AIPDFPrivateData1', stored: wrapped };
const metaStream = { key: 'AIMetaData', stored: metaData };

const thrown = (action: () => void): Error | undefined => {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  return undefined;
};

const chunks = (bytes: Uint8Array, lengths: ReadonlyArray<number>): Array<Uint8Array> => {
  const output: Array<Uint8Array> = [];
  let offset = 0;
  for (const length of lengths) {
    output.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  output.push(bytes.slice(offset));
  return output;
};

const zstandardWrapped = (frame: Uint8Array): Uint8Array => {
  const header = encoder.encode('%AI24_ZStandard_Data');
  const output = new Uint8Array(header.length + frame.length);
  output.set(header);
  output.set(frame, header.length);
  return output;
};

describe('Illustrator container reader', () => {
  it('reads the facts of a container written without the package writer', () => {
    const facts = readIllustratorContainer(
      illustratorShapedPdf({ streams: [metaStream, block], privateEntries: '/ContainerVersion 9 /NumBlock 1' }),
      decompress,
    );
    expect(facts).toStrictEqual({
      privateKeys: ['AIMetaData', 'AIPDFPrivateData1', 'ContainerVersion', 'NumBlock'],
      containerVersion: 9,
      creatorVersion: undefined,
      roundtripStreamType: undefined,
      roundtripVersion: undefined,
      numBlock: 1,
      blockLengths: [wrapped.length],
      compression: { kind: 'zlib' },
      frameHeaderDescriptor: undefined,
      windowDescriptor: undefined,
      pageDate: encoder.encode(SHAPED_DATE),
      applicationDate: encoder.encode(SHAPED_DATE),
      metaData,
      native,
    });
  });

  it('joins private-data blocks in numeric order whatever order their keys are written in', () => {
    // Ten blocks of distinct lengths written 10, 2, 1, 3 … 9, so neither the written order nor the text order of the keys is the numeric one.
    const lengths = [11, 12, 13, 14, 15, 16, 17, 18, 19];
    const pieces = chunks(wrapped, lengths);
    const order = [10, 2, 1, 3, 4, 5, 6, 7, 8, 9];
    const streams = order.map(index => ({ key: `AIPDFPrivateData${String(index)}`, stored: pieces[index - 1] ?? new Uint8Array() }));
    const facts = readIllustratorContainer(illustratorShapedPdf({ streams }), decompress);
    expect(facts.native).toStrictEqual(native);
    expect(facts.blockLengths).toStrictEqual(pieces.map(piece => piece.length));
  });

  // ISO 32000-1:2008, 7.4.4: FlateDecode data is a zlib stream.
  it('inflates FlateDecode blocks and metadata', () => {
    const [first = new Uint8Array(), second = new Uint8Array()] = chunks(wrapped, [30]);
    const streams = [
      { key: 'AIMetaData', stored: deflateZlib(metaData), filter: 'FlateDecode' },
      { key: 'AIPDFPrivateData1', stored: first },
      { key: 'AIPDFPrivateData2', stored: deflateZlib(second), filter: 'FlateDecode' },
    ];
    const facts = readIllustratorContainer(illustratorShapedPdf({ streams }), decompress);
    expect([facts.native, facts.metaData, facts.blockLengths]).toStrictEqual([native, metaData, [first.length, second.length]]);
  });

  // ISO 32000-1:2008, 7.5.7: a page dictionary may be stored in an object stream, which a cross-reference stream indexes.
  it('reads a page held in an object stream', () => {
    const facts = readIllustratorContainer(illustratorShapedPdf({ streams: [block], pageInObjectStream: true }), decompress);
    expect([facts.native, facts.pageDate]).toStrictEqual([native, encoder.encode(SHAPED_DATE)]);
  });

  // ISO 32000-1:2008, 7.5.6: the most recent copy of each object is the one accessed from the file.
  it('reads the page-piece dictionary an incremental update replaced', () => {
    const update = [{ number: 5, body: '<</LastModified(D:20261001000000Z)/Private 6 0 R>>' }];
    const facts = readIllustratorContainer(illustratorShapedPdf({ streams: [block], update }), decompress);
    expect([facts.applicationDate, facts.pageDate]).toStrictEqual([encoder.encode('D:20261001000000Z'), encoder.encode(SHAPED_DATE)]);
  });

  // RFC 8878, 3.1.1.1.2: a frame with the Single_Segment_flag set has no Window_Descriptor.
  it.each([
    { descriptor: 0x60, windowDescriptor: undefined },
    { descriptor: 0xa0, windowDescriptor: undefined },
    { descriptor: 0x40, windowDescriptor: 0x58 },
    { descriptor: 0x00, windowDescriptor: 0x58 },
  ])('reports the window descriptor of a frame with header descriptor $descriptor', ({ descriptor, windowDescriptor }) => {
    const content = Uint8Array.from({ length: 300 }, (_, index) => index % 251);
    const facts = readIllustratorContainer(
      illustratorShapedPdf({ streams: [{ key: 'AIPDFPrivateData1', stored: zstandardWrapped(rawZstandardFrame(content, descriptor)) }] }),
      decompress,
    );
    expect([facts.native, facts.compression]).toStrictEqual([content, { kind: 'zstandard', frameHeaderDescriptor: descriptor, windowDescriptor }]);
  });

  it('refuses a Zstandard frame of four bytes at the end of the payload', () => {
    const pdf = illustratorShapedPdf({ streams: [{ key: 'AIPDFPrivateData1', stored: zstandardWrapped(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd)) }] });
    const error = thrown(() => {
      readIllustratorContainer(pdf, decompress);
    });
    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ offset: 24 });
  });

  it('passes a Zstandard frame of five bytes to the decoder', () => {
    const frames: Array<Uint8Array> = [];
    const pdf = illustratorShapedPdf({ streams: [{ key: 'AIPDFPrivateData1', stored: zstandardWrapped(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0)) }] });
    const facts = readIllustratorContainer(pdf, frame => {
      frames.push(frame);
      return Uint8Array.of(1);
    });
    expect([frames, facts.native, facts.compression]).toStrictEqual([
      [Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0)],
      Uint8Array.of(1),
      { kind: 'zstandard', frameHeaderDescriptor: 0, windowDescriptor: undefined },
    ]);
  });
});

// Each row changes one object of the container the first test reads. ISO 32000-1:2008, 14.5: page-piece data lives in the page's PieceInfo dictionary, keyed by the conforming product's name, and each data dictionary carries a LastModified date.
const refusals = [
  { name: 'page-piece data without an Illustrator entry', input: { streams: [block], pieceInfo: '<< /Other 5 0 R >>' }, error: ValidationError },
  {
    name: 'a Private entry that is not a dictionary',
    input: { streams: [block], applicationEntries: `/LastModified(${SHAPED_DATE})/Private 7` },
    error: ParseError,
  },
  { name: 'an Illustrator entry without LastModified', input: { streams: [block], applicationEntries: '/Private 6 0 R' }, error: ParseError },
  { name: 'a Private dictionary without private-data blocks', input: { streams: [metaStream] }, error: ValidationError },
  { name: 'a block filter other than FlateDecode', input: { streams: [{ ...block, filter: 'ASCIIHexDecode' }] }, error: UnsupportedFeatureError },
  { name: 'a ContainerVersion that is not an integer', input: { streams: [block], privateEntries: '/ContainerVersion 9.5' }, error: ParseError },
] as const satisfies Array<{ name: string; input: ShapedPdfInput; error: typeof ParseError | typeof UnsupportedFeatureError | typeof ValidationError }>;

describe('Illustrator container refusals', () => {
  it.each(refusals)('refuses $name', ({ input, error }) => {
    const pdf = illustratorShapedPdf(input);
    expect(() => readIllustratorContainer(pdf, decompress)).toThrow(error);
  });
});

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });

// Deterministic bytes from a seed, so a payload of a hundred kilobytes costs one draw.
const seededBytes = (length: number, seed: number): Uint8Array => {
  let state = seed;
  return Uint8Array.from({ length }, () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state >>> 24;
  });
};

const payload = fc.oneof(
  fc.uint8Array({ maxLength: 300 }),
  fc.tuple(fc.integer({ min: 65_000, max: 200_000 }), fc.nat()).map(([length, seed]) => seededBytes(length, seed)),
);

describe('properties', () => {
  it('reads back the native bytes, metadata prefix and 65,536-byte blocks the container writer stored', () => {
    fc.assert(
      fc.property(
        payload,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom('zstandard' as const, 'zstandard-raw-blocks' as const),
        (bytes, fraction, compression) => {
          const metaDataLength = Math.floor(fraction * bytes.length);
          const document = createDocument();
          const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
          attachPrivateData(document, page, { native: { bytes, metaDataLength }, lastModified: date, options: { compression } });
          const facts = readIllustratorContainer(document.save().toBytes(), decompress);
          const frame = compression === 'zstandard' ? encodeZstandardFrame(bytes) : encodeRawFrame(bytes);
          const total = 20 + frame.length;
          const lengths = Array.from({ length: Math.ceil(total / 65_536) }, (_, index) => Math.min(65_536, total - index * 65_536));
          expect([facts.native, facts.metaData, facts.blockLengths]).toStrictEqual([bytes, bytes.slice(0, metaDataLength), lengths]);
        },
      ),
    );
  });
});
