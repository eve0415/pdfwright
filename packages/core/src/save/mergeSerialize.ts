import type { ByteWriter } from '../bytes/byteWriter.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { SourceEntry, SourceNode } from '../parse/parseObject.ts';
import type { SaveWarning } from './saveWarning.ts';

import { deepEqual } from '../object/deepEqual.ts';
import { parsedDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfInteger, pdfName } from '../object/pdfObject.ts';
import { needsSpace, writeName, writePdfObject } from '../serialize/serializeObject.ts';

export interface MergeContext {
  /** The value as it was parsed, with the spans of its parts; undefined for a new value. */
  readonly original: SourceNode | undefined;
  /** The bytes the original's spans index. */
  readonly bytes: Uint8Array;
  readonly fractionDigits: number;
  readonly warn: (warning: SaveWarning) => void;
}

const LENGTH = pdfName('Length').bytes;

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

/**
 * Writes a changed value so that every part equal to the original is copied from the original's bytes: spellings such as 792.0 or #20 in names, six-digit reals and the spacing inside unchanged values survive.
 * Dictionaries are matched by key, arrays by index; a key the original held more than once is written once, with the last value, and reported.
 */
class MergeWriter {
  private readonly writer: ByteWriter;
  private readonly context: MergeContext;

  constructor(writer: ByteWriter, context: MergeContext) {
    this.writer = writer;
    this.context = context;
  }

  private copy(start: number, end: number): void {
    this.writer.writeBytes(this.context.bytes.subarray(start, end));
  }

  value(value: PdfDirectObject, original: SourceNode | undefined): void {
    if (original !== undefined && deepEqual(value, original.value, 'strict')) this.copy(original.start, original.end);
    else if (value.kind === 'dictionary' && original?.entries !== undefined) this.dictionary(value.entries, original);
    else if (value.kind === 'array' && original?.items !== undefined) this.array(value.items, original);
    else writePdfObject(this.writer, value, this.context);
  }

  dictionary(entries: PdfDictionaryEntries, original: SourceNode | undefined): void {
    const occurrences = new Map<string, SourceEntry[]>();
    for (const entry of original?.entries ?? []) {
      const key = latin1(entry.key);
      occurrences.set(key, [...(occurrences.get(key) ?? []), entry]);
    }
    this.writer.writeAscii('<<');
    for (const [key, value] of entries.entries()) {
      const found = occurrences.get(latin1(key)) ?? [];
      const last = found.at(-1);
      if (found.length > 1) {
        this.context.warn({
          code: 'duplicate-key-resolved',
          detail: `a changed dictionary had the key /${latin1(key)} more than once; only the last value is written`,
        });
      }
      if (last === undefined) {
        writeName(this.writer, key);
        if (needsSpace(value)) this.writer.writeByte(0x20);
      } else {
        // The key's own spelling and the bytes between it and its value are kept.
        this.copy(last.keyStart, last.node.start);
      }
      this.value(value, last?.node);
    }
    this.writer.writeAscii('>>');
  }

  private array(items: readonly PdfDirectObject[], original: SourceNode): void {
    const originals = original.items ?? [];
    const [first] = originals;
    const last = originals.at(-1);
    this.writer.writeByte(0x5b);
    if (first !== undefined && items.length > 0) this.copy(original.start + 1, first.start);
    for (const [index, item] of items.entries()) {
      const previous = originals[index - 1];
      const current = originals[index];
      if (index > 0) {
        if (previous !== undefined && current !== undefined) this.copy(previous.end, current.start);
        else this.writer.writeByte(0x20);
      }
      this.value(item, current);
    }
    if (last !== undefined && items.length === originals.length) this.copy(last.end, original.end - 1);
    this.writer.writeByte(0x5d);
  }
}

/** Serializes `value` against its original (ISO 32000-1:2008, 7.3.8.1: a stream's dictionary is followed by the keyword stream, its data and endstream). */
export const mergeSerialize = (writer: ByteWriter, value: PdfObject, context: MergeContext): void => {
  const merger = new MergeWriter(writer, context);
  if (value.kind !== 'stream') {
    merger.value(value, context.original);
    return;
  }
  const entries = parsedDictionaryEntries([...value.dictionary.entries()]);
  // Table 5, Length: "The number of bytes from the beginning of the line following the keyword stream to the last byte just before the keyword endstream".
  entries.set(LENGTH, pdfInteger(value.data.length));
  if (context.original !== undefined && deepEqual({ kind: 'dictionary', entries }, context.original.value, 'strict')) {
    writer.writeBytes(context.bytes.subarray(context.original.start, context.original.end));
  } else merger.dictionary(entries, context.original);
  writer.writeAscii('\nstream\n');
  writer.writeBytes(value.data);
  writer.writeAscii('\nendstream');
};
