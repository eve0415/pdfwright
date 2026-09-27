import type { ByteWriter } from '../bytes/byteWriter.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';

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
      if (entry !== undefined) writer.writeAscii(`${pad(entry.field, 10)} ${pad(entry.generation, 5)} ${entry.type === 1 ? 'n' : 'f'} \n`);
    }
    index = end + 1;
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
export const streamData = (entries: readonly Entry[], widths: readonly [number, number]): Uint8Array => {
  const data = new Uint8Array(entries.length * (1 + widths[0] + widths[1]));
  let position = 0;
  const put = (value: number, width: number): void => {
    for (let index = width - 1; index >= 0; index--) data[position++] = Math.floor(value / 256 ** index) % 256;
  };
  for (const entry of entries) {
    put(entry.type, 1);
    put(entry.field, widths[0]);
    put(entry.generation, widths[1]);
  }
  return data;
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
