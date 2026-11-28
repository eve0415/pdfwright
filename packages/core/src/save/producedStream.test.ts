import type { StreamProducer } from '../document/editedObjects.ts';

import { describe, expect, it } from 'vitest';

import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';
import { latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { emittedChunks, PdfEmitter } from './emitter.ts';
import { measureStreams, writeLengthObject, writeProducedStream } from './producedStream.ts';

const producer = (...chunks: ReadonlyArray<string>): StreamProducer =>
  function* () {
    for (const chunk of chunks) {
      yield latin1Bytes(chunk);
    }
  };

const context = {
  original: undefined,
  bytes: new Uint8Array(),
  fractionDigits: 5,
  warn: (): void => {
    // A new dictionary has no duplicate keys to report.
  },
};

describe('produced streams', () => {
  it('measures each producer and numbers the Length objects in ascending object-number order', () => {
    // Registered in descending order, with lengths that differ from the chunk counts.
    const measured = measureStreams(
      new Map([
        [9, producer('abc', 'de')],
        [5, producer('x', '', 'yz', 'w')],
      ]),
      20,
    );
    expect([...measured].map(([objectNumber, stream]) => [objectNumber, stream.length, stream.lengthNumber])).toStrictEqual([
      [5, 4, 20],
      [9, 5, 21],
    ]);
  });

  // ISO 32000-1:2008, 7.3.10, Example 3: the stream's Length is an indirect reference to an integer object written after it.
  it('writes the stream with an indirect Length and the Length object with the measured count', () => {
    const [stream] = measureStreams(new Map([[5, producer('first', 'second')]]), 7).values();
    if (stream === undefined) {
      throw new Error('missing measured stream');
    }
    const emitter = new PdfEmitter();
    const value = { kind: 'stream', dictionary: new PdfDictionaryEntries([[pdfName('Type').bytes, pdfName('Example')]]), data: new Uint8Array() } as const;
    writeProducedStream(emitter, value, { stream, context });
    emitter.writer.writeAscii('\n');
    writeLengthObject(emitter, stream);
    const written = [...emittedChunks(emitter.finishParts())].map(chunk => latin1Text(chunk)).join('');
    expect([written, emitter.offset]).toStrictEqual(['<</Type/Example/Length 7 0 R>>\nstream\nfirstsecond\nendstream\n7 0 obj\n11\nendobj\n', written.length]);
  });

  it('refuses a produced object that is not a stream', () => {
    const [stream] = measureStreams(new Map([[5, producer('data')]]), 7).values();
    if (stream === undefined) {
      throw new Error('missing measured stream');
    }
    const write = (): void => {
      writeProducedStream(new PdfEmitter(), pdfInteger(1), { stream, context });
    };
    expect(write).toThrow(Error);
    expect(write).toThrow(/must be a stream/u);
  });
});
