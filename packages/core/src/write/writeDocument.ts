import type { PdfObject } from '../object/pdfObject.ts';
import type { BufferedSavedPdf } from './savedPdf.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfString } from '../object/pdfObject.ts';
import { serializeObject, writePdfObject } from '../serialize/serializeObject.ts';

import { fileIdentifier } from './fileIdentifier.ts';
import { savedPdf } from './savedPdf.ts';

export interface IndirectObject {
  readonly objectNumber: number;
  readonly generation: number;
  readonly value: PdfObject;
}

export interface WriteOptions {
  readonly fractionDigits: number;
  readonly fileIdentifier?: [Uint8Array, Uint8Array] | undefined;
}

const xrefEntry = (offset: number, generation: number, use: 'n' | 'f'): string =>
  `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${use} \n`;

export const writeDocument = (objects: readonly IndirectObject[], trailer: PdfDictionaryEntries, options: WriteOptions): BufferedSavedPdf => {
  const ordered = objects.toSorted((left, right) => left.objectNumber - right.objectNumber);
  for (let index = 0; index < ordered.length; index++) {
    const object = ordered[index];
    if (object?.objectNumber !== index + 1 || !Number.isInteger(object.generation) || object.generation < 0 || object.generation > 65535) {
      throw new InvalidArgumentError('indirect objects must have contiguous positive numbers and valid generations');
    }
  }

  let writer = new ByteWriter();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const finishChunk = (): void => {
    const chunk = writer.toUint8Array();
    chunks.push(chunk);
    byteLength += chunk.length;
    writer = new ByteWriter();
  };
  // ISO 32000-1:2008, 7.5.2 requires a PDF header and a comment with four bytes whose values are at least 128 when the file contains binary data.
  writer.writeAscii('%PDF-1.7\n%');
  writer.writeBytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]));
  writer.writeByte(0x0a);
  finishChunk();
  const offsets: number[] = [];
  for (const object of ordered) {
    offsets.push(byteLength);
    writer.writeAscii(`${object.objectNumber} ${object.generation} obj\n`);
    writePdfObject(writer, object.value, options);
    writer.writeAscii('\nendobj\n');
    finishChunk();
  }
  const xrefOffset = byteLength;
  // ISO 32000-1:2008, 7.5.4 requires one subsection beginning at object 0 for an initial xref section and exactly 20 bytes per entry.
  writer.writeAscii(`xref\n0 ${ordered.length + 1}\n`);
  writer.writeAscii(xrefEntry(0, 65535, 'f'));
  for (let index = 0; index < ordered.length; index++) {
    const offset = offsets[index] ?? 0;
    const generation = ordered[index]?.generation ?? 0;
    writer.writeAscii(xrefEntry(offset, generation, 'n'));
  }

  const entries = new PdfDictionaryEntries(trailer.entries());
  entries.set(pdfName('Size').bytes, pdfInteger(ordered.length + 1));
  entries.delete(pdfName('ID').bytes);
  const trailerWithoutId = serializeObject({ kind: 'dictionary', entries }, options);
  const identifiers = fileIdentifier(chunks, trailerWithoutId, options.fileIdentifier);
  entries.set(pdfName('ID').bytes, pdfArray([pdfString(identifiers[0], 'hex'), pdfString(identifiers[1], 'hex')]));
  writer.writeAscii('trailer\n');
  writePdfObject(writer, { kind: 'dictionary', entries }, options);
  writer.writeAscii(`\nstartxref\n${xrefOffset}\n%%EOF\n`);
  finishChunk();
  return savedPdf(chunks);
};
