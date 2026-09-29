import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { ByteSource } from '../parse/byteSource.ts';
import type { IndirectObjectContext } from '../parse/indirectObject.ts';
import type { XrefEntry, XrefSection } from './xrefSection.ts';

import { ParseError } from '../error/parseError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';
import { parseIndirectObject } from '../parse/indirectObject.ts';

import { MAX_GENERATION, MAX_OBJECT_NUMBER } from './xrefSection.ts';

export interface StreamSection extends XrefSection {
  readonly kind: 'stream';
  readonly objectNumber: number;
}

export interface XrefContext extends IndirectObjectContext {
  readonly maxDecodedBytes: number;
}

const TYPE = pdfName('Type').bytes;
const SIZE = pdfName('Size').bytes;
const INDEX = pdfName('Index').bytes;
const W = pdfName('W').bytes;
const XREF = pdfName('XRef').bytes;

const isName = (value: PdfDirectObject | undefined, name: Uint8Array): boolean =>
  value?.kind === 'name' && value.bytes.length === name.length && value.bytes.every((byte, index) => byte === name[index]);

// ISO 32000-1:2008, 7.5.8.2: "The values of all entries shown in Table 17 shall be direct objects; indirect references shall not be permitted. For arrays (the Index and W entries), all of their elements shall be direct objects as well."
const integers = (value: PdfDirectObject | undefined, key: string, offset: number): number[] => {
  if (value?.kind !== 'array') throw new ParseError(`the cross-reference stream ${key} entry is not an array`, offset);
  return value.items.map(item => {
    if (item.kind !== 'integer' || item.value < 0) {
      throw new ParseError(`the cross-reference stream ${key} entry holds a value that is not a non-negative integer`, offset);
    }
    return item.value;
  });
};

const readField = (data: Uint8Array, start: number, width: number): number => {
  // ISO 32000-1:2008, 7.5.8.3: "Fields requiring more than one byte are stored with the high-order byte first."
  let value = 0;
  for (let index = 0; index < width; index++) value = value * 256 + (data[start + index] ?? 0);
  return value;
};

interface Layout {
  readonly widths: readonly [number, number, number];
  readonly index: readonly number[];
  readonly total: number;
}

const layout = (dictionary: PdfDictionaryEntries, at: number): Layout => {
  const size = dictionary.get(SIZE);
  if (size?.kind !== 'integer' || size.value < 0) throw new ParseError('the cross-reference stream has no valid Size', at);
  const widths = integers(dictionary.get(W), 'W', at);
  // Table 17, W: "For PDF 1.5, W always contains three integers". Fields wider than 8 bytes cannot hold values within the exact range of a number.
  const [typeWidth = 0, secondWidth = 0, thirdWidth = 0] = widths;
  if (widths.length !== 3 || widths.some(width => width > 8)) {
    throw new ParseError('the cross-reference stream W entry must hold three widths of at most 8 bytes', at);
  }
  // Table 17, Index: "Default value: [0 Size]."
  const index = dictionary.has(INDEX) ? integers(dictionary.get(INDEX), 'Index', at) : [0, size.value];
  if (index.length % 2 !== 0) throw new ParseError('the cross-reference stream Index entry must hold pairs', at);
  let total = 0;
  for (let pair = 1; pair < index.length; pair += 2) {
    total += index[pair] ?? 0;
    if ((index[pair - 1] ?? 0) + (index[pair] ?? 0) - 1 > MAX_OBJECT_NUMBER) {
      throw new ParseError('the cross-reference stream Index names object numbers beyond the supported range', at);
    }
  }
  return { widths: [typeWidth, secondWidth, thirdWidth], index, total };
};

interface EntryReader {
  readonly data: Uint8Array;
  readonly widths: readonly [number, number, number];
  readonly at: number;
  readonly warn: XrefContext['warn'];
}

const readEntry = (reader: EntryReader, position: number, objectNumber: number): XrefEntry => {
  const [typeWidth, secondWidth, thirdWidth] = reader.widths;
  // Table 17, W: "If the first element is zero, the type field shall not be present, and shall default to type 1."
  const type = typeWidth === 0 ? 1 : readField(reader.data, position, typeWidth);
  const second = readField(reader.data, position + typeWidth, secondWidth);
  const third = readField(reader.data, position + typeWidth + secondWidth, thirdWidth);
  if (!Number.isSafeInteger(second) || !Number.isSafeInteger(third) || (type === 1 && third > MAX_GENERATION)) {
    throw new ParseError('a cross-reference stream field exceeds the exact range of a number', reader.at);
  }
  if (type === 1 || type === 2) return { objectNumber, type: type === 1 ? 'file' : 'compressed', location: second, generation: third };
  if (type === 0) return { objectNumber, type: 'free', location: second, generation: third };
  // 7.5.8.3: "In PDF 1.5 through PDF 1.7, only types 0, 1, and 2 are allowed. Any other value shall be interpreted as a reference to the null object".
  reader.warn({ code: 'unknown-xref-entry-type', detail: `cross-reference entry type ${String(type)} read as a free entry`, offset: reader.at, objectNumber });
  return { objectNumber, type: 'free', location: 0, generation: 0 };
};

const readEntries = (reader: EntryReader, { index, total }: Layout): XrefEntry[] => {
  const [typeWidth, secondWidth, thirdWidth] = reader.widths;
  const entryWidth = typeWidth + secondWidth + thirdWidth;
  const { data, at } = reader;
  if (data.length < entryWidth * total) {
    throw new ParseError(`the cross-reference stream holds ${String(data.length)} bytes, fewer than its ${String(total)} entries need`, at);
  }
  if (data.length > entryWidth * total) {
    reader.warn({ code: 'xref-stream-trailing-data', detail: 'the cross-reference stream holds bytes after its last entry', offset: at });
  }
  const entries: XrefEntry[] = [];
  let position = 0;
  let previousEnd = 0;
  for (let pair = 0; pair < index.length; pair += 2) {
    const first = index[pair] ?? 0;
    const count = index[pair + 1] ?? 0;
    // Table 17, Index: "The array shall be sorted in ascending order by object number. Subsections cannot overlap". Unsorted subsections are read in the given order.
    if (first < previousEnd) {
      reader.warn({ code: 'xref-stream-index-order', detail: 'the cross-reference stream Index subsections are unsorted or overlap', offset: at });
    }
    previousEnd = first + count;
    for (let entry = 0; entry < count; entry++) {
      entries.push(readEntry(reader, position, first + entry));
      position += entryWidth;
    }
  }
  return entries;
};

/** Reads the cross-reference stream whose object header is at `offset` (ISO 32000-1:2008, 7.5.8). */
export const readXrefStream = (source: ByteSource, offset: number, context: XrefContext): StreamSection => {
  const object = source.parseAt(offset, context, (window, local, lexContext) =>
    parseIndirectObject(window, local, { ...lexContext, maxNesting: context.maxNesting }),
  );
  const { value, source: extent } = object;
  const at = extent.objectStart;
  if (value.kind !== 'stream' || !isName(value.dictionary.get(TYPE), XREF)) throw new ParseError('not a cross-reference stream', at);
  const { dictionary } = value;
  const structure = layout(dictionary, at);
  const entryWidth = structure.widths[0] + structure.widths[1] + structure.widths[2];
  // Each entry takes W bytes of the decoded data, so entries of zero width cannot be told apart; and a section that lists more objects than the file has bytes does not describe this file.
  if (structure.total > 0 && entryWidth === 0) throw new ParseError('the cross-reference stream W entry gives entries no width', at);
  if (structure.total > source.length + 1024) {
    throw new ParseError(`the cross-reference stream lists ${String(structure.total)} entries, more than the file has bytes`, at);
  }
  const data = decodeStream(value, { maxDecodedBytes: context.maxDecodedBytes, warn: context.warn });
  const entries = readEntries({ data, widths: structure.widths, at, warn: context.warn }, structure);
  return {
    kind: 'stream',
    offset: at,
    objectNumber: object.objectNumber,
    entries,
    trailer: dictionary,
    trailerStart: extent.valueStart,
    trailerEnd: extent.stream?.dictionaryEnd ?? extent.valueEnd,
  };
};
