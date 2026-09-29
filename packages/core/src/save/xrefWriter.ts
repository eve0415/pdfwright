import type { ByteWriter } from '../bytes/byteWriter.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

import { ZlibDeflater } from '../flate/deflate.ts';
import { pdfArray, pdfInteger, pdfString } from '../object/pdfObject.ts';

/** A cross-reference entry to write: type 0 free (next free number, generation), 1 in use (offset, generation), 2 compressed (object stream number, index). */
export interface Entry {
  readonly objectNumber: number;
  readonly type: 0 | 1 | 2;
  readonly field: number;
  readonly generation: number;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// ISO 32000-1:2008, 7.5.4: "nnnnnnnnnn ggggg n eol", each entry exactly 20 bytes; the end-of-line here is SP LF.
const tableLine = (entry: Omit<Entry, 'objectNumber'>): string => `${pad(entry.field, 10)} ${pad(entry.generation, 5)} ${entry.type === 1 ? 'n' : 'f'} \n`;

// 7.5.4: "the table may contain other free entries that link back to object number 0 and have a generation number of 65,535, even though these entries are not in the linked list itself."
const UNUSED = { type: 0, field: 0, generation: 65_535 } as const;
const UNUSED_LINE = tableLine(UNUSED);

export const writeTable = (writer: ByteWriter, entries: readonly Entry[]): void => {
  writer.writeAscii('xref\n');
  // "Following this line shall be one or more cross-reference subsections"; an update that changes no object has one without entries.
  if (entries.length === 0) writer.writeAscii('0 0\n');
  for (let index = 0; index < entries.length;) {
    let end = index;
    while (end + 1 < entries.length && entries[end + 1]?.objectNumber === (entries[end]?.objectNumber ?? 0) + 1) end++;
    writer.writeAscii(`${String(entries[index]?.objectNumber ?? 0)} ${String(end - index + 1)}\n`);
    for (let run = index; run <= end; run++) {
      const entry = entries[run];
      if (entry !== undefined) writer.writeAscii(tableLine(entry));
    }
    index = end + 1;
  }
};

/**
 * Writes a table of one subsection holding an entry for every object number from 0 to size - 1, where a number without an entry gets an unused free entry as it is written.
 * ISO 32000-1:2008, 7.5.4: the table "shall contain one entry for each object number from 0 to the maximum object number defined in the file, even if one or more of the object numbers in this range do not actually occur in the file."
 */
export const writeCoveringTable = (writer: ByteWriter, entries: ReadonlyMap<number, Entry>, size: number): void => {
  writer.writeAscii(`xref\n0 ${String(size)}\n`);
  for (let objectNumber = 0; objectNumber < size; objectNumber++) {
    const entry = entries.get(objectNumber);
    writer.writeAscii(entry === undefined ? UNUSED_LINE : tableLine(entry));
  }
};

export const idArray = ([first, second]: readonly [Uint8Array, Uint8Array]): PdfDirectObject => pdfArray([pdfString(first, 'hex'), pdfString(second, 'hex')]);

export const byteWidth = (value: number): number => {
  let width = 1;
  while (value >= 256 ** width) width++;
  return width;
};

/** The field widths a cross-reference stream needs for these entries: the second field and the third. */
export const fieldWidths = (entries: readonly Entry[]): readonly [number, number] => {
  let field = 0;
  let generation = 0;
  for (const entry of entries) {
    field = Math.max(field, entry.field);
    generation = Math.max(generation, entry.generation);
  }
  return [byteWidth(field), byteWidth(generation)];
};

// ISO 32000-1:2008, 7.5.8.3, Table 18: type 0 entries hold the next free object number and a generation, type 1 entries an offset and a generation, high-order byte first.
class RowWriter {
  readonly data: Uint8Array;
  position = 0;
  private readonly widths: readonly [number, number];

  constructor(data: Uint8Array, widths: readonly [number, number]) {
    this.data = data;
    this.widths = widths;
  }

  put(entry: Omit<Entry, 'objectNumber'>): void {
    const { data, widths } = this;
    data[this.position++] = entry.type;
    for (let index = widths[0] - 1; index >= 0; index--) data[this.position++] = Math.floor(entry.field / 256 ** index) % 256;
    for (let index = widths[1] - 1; index >= 0; index--) data[this.position++] = Math.floor(entry.generation / 256 ** index) % 256;
  }
}

export const streamData = (entries: readonly Entry[], widths: readonly [number, number]): Uint8Array => {
  const rows = new RowWriter(new Uint8Array(entries.length * (1 + widths[0] + widths[1])), widths);
  for (const entry of entries) rows.put(entry);
  return rows.data;
};

// Rows are generated and compressed this many bytes at a time, so a table of millions of numbers never exists uncompressed.
const PIECE_BYTES = 64 * 1024;

/**
 * The Flate-compressed data of a cross-reference stream holding an entry for every object number from 0 to size - 1, where a number without an entry gets an unused free entry.
 * The widths must hold a generation of 65,535.
 */
export const coveringStreamData = (entries: ReadonlyMap<number, Entry>, size: number, widths: readonly [number, number]): Uint8Array => {
  const rowBytes = 1 + widths[0] + widths[1];
  const rows = new RowWriter(new Uint8Array(Math.floor(PIECE_BYTES / rowBytes) * rowBytes), widths);
  const deflater = new ZlibDeflater();
  for (let objectNumber = 0; objectNumber < size; objectNumber++) {
    rows.put(entries.get(objectNumber) ?? UNUSED);
    if (rows.position === rows.data.length) {
      deflater.write(rows.data);
      rows.position = 0;
    }
  }
  deflater.write(rows.data.subarray(0, rows.position));
  return deflater.finish();
};

export const indexRuns = (entries: readonly Entry[]): PdfDirectObject => {
  const pairs: number[] = [];
  for (const entry of entries) {
    const last = pairs.length - 2;
    if (last >= 0 && (pairs[last] ?? 0) + (pairs[last + 1] ?? 0) === entry.objectNumber) pairs[last + 1] = (pairs[last + 1] ?? 0) + 1;
    else pairs.push(entry.objectNumber, 1);
  }
  return pdfArray(pairs.map(value => pdfInteger(value)));
};
