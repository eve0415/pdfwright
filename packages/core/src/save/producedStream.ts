import type { StreamProducer } from '../document/editedObjects.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { PdfEmitter } from './emitter.ts';
import type { MergeContext } from './mergeSerialize.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';

import { mergeSerialize } from './mergeSerialize.ts';

const LENGTH = pdfName('Length').bytes;

export interface MeasuredStream {
  readonly length: number;
  readonly produce: StreamProducer;
  readonly lengthNumber: number;
}

export const measureStreams = (streams: ReadonlyMap<number, StreamProducer>, firstNumber: number): ReadonlyMap<number, MeasuredStream> => {
  const measured = new Map<number, MeasuredStream>();
  let number = firstNumber;
  for (const [objectNumber, produce] of [...streams].toSorted((left, right) => left[0] - right[0])) {
    let length = 0;
    for (const chunk of produce()) length += chunk.length;
    measured.set(objectNumber, { length, produce, lengthNumber: number++ });
  }
  return measured;
};

/** ISO 32000-1:2008, 7.3.10, Example 3: the unknown stream length is an indirect integer object following its data. */
export const writeProducedStream = (emitter: PdfEmitter, value: PdfObject, input: { stream: MeasuredStream; context: MergeContext }): void => {
  if (value.kind !== 'stream') throw new Error('a produced object must be a stream');
  const dictionary = new PdfDictionaryEntries(value.dictionary.entries());
  dictionary.set(LENGTH, pdfReference(input.stream.lengthNumber, 0));
  const writer = new ByteWriter();
  mergeSerialize(writer, { kind: 'dictionary', entries: dictionary }, input.context);
  writer.writeAscii('\nstream\n');
  emitter.view(writer.toUint8Array());
  emitter.produced(input.stream.length, input.stream.produce);
  emitter.writer.writeAscii('\nendstream');
};

export const writeLengthObject = (emitter: PdfEmitter, stream: MeasuredStream): void => {
  emitter.writer.writeAscii(`${String(stream.lengthNumber)} 0 obj\n${String(stream.length)}\nendobj\n`);
};
