// Builds small PDF files with computed offsets for parser, editor and comparison tests.

import { deflateZlib } from '../flate/deflate.ts';

export interface TestObject {
  readonly number: number;
  readonly generation?: number;
  /** The text between "obj" and "endobj". */
  readonly body: string;
}

export interface TestObjectStream {
  readonly number: number;
  readonly members: ReadonlyArray<TestObject>;
  /** Extra entries for the object stream dictionary, such as "/Extends 9 0 R". */
  readonly dictionary?: string;
}

/** A free cross-reference entry. */
export interface TestFreeObject {
  readonly number: number;
  /** The generation the object number takes when it is next used. */
  readonly generation: number;
}

export interface TestSection {
  readonly objects: ReadonlyArray<TestObject>;
  /** Free entries, linked in ascending order from the head at object 0 under ISO 32000-1:2008, 7.5.4; omitted, every free entry points at object 0 with generation 65535. */
  readonly free?: ReadonlyArray<TestFreeObject>;
  /** A hybrid section writes top-level objects to a classic section whose XRefStm entry names a cross-reference stream for object-stream members. */
  readonly xref: 'classic' | 'stream' | 'hybrid';
  /** Trailer entries other than Size and Prev, such as "/Root 1 0 R". */
  readonly trailer?: string;
  /** Object streams, which need a cross-reference stream to index their members. */
  readonly objectStreams?: ReadonlyArray<TestObjectStream>;
  /** Object number of the cross-reference stream; defaults to one above every other number. */
  readonly xrefStreamNumber?: number;
  /** How the cross-reference stream's data is encoded: unfiltered by default, Flate, or Flate after the PNG Up predictor over rows of 7 bytes, as most writers do. */
  readonly xrefStreamEncoding?: 'none' | 'flate' | 'flate-up';
}

export interface TestPdf {
  readonly bytes: Uint8Array;
  readonly text: string;
  /** Offset of each top-level object's header, by object number, for the newest copy. */
  readonly offsets: ReadonlyMap<number, number>;
  /** Offset of each cross-reference section, oldest first. */
  readonly sections: ReadonlyArray<number>;
  readonly size: number;
}

export interface BuildOptions {
  readonly header?: string;
  readonly prefix?: string;
}

interface Entry {
  readonly type: 0 | 1 | 2;
  readonly second: number;
  readonly third: number;
}

/** One byte per character; a character above U+00FF has no single byte and would wrap, so it is refused. */
export const latin1Bytes = (text: string): Uint8Array =>
  Uint8Array.from(text, character => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0xff) {
      throw new RangeError(`U+${codePoint.toString(16).toUpperCase()} is not a Latin-1 character`);
    }
    return codePoint;
  });

export const latin1Text = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += String.fromCodePoint(byte);
  }
  return text;
};

/** A stream object body whose Length matches its data. */
export const streamBody = (dictionary: string, data: string): string => `<<${dictionary}/Length ${String(data.length)}>>\nstream\n${data}\nendstream`;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

// ISO 32000-1:2008, 7.5.4: an in-use entry gives a byte offset and a free entry the next free object number, each with a generation.
const classicLine = (entry: Entry | undefined): string => {
  if (entry === undefined) {
    return `0000000000 65535 f \n`;
  }
  return `${pad(entry.second, 10)} ${pad(entry.third, 5)} ${entry.type === 1 ? 'n' : 'f'} \n`;
};

const classicTable = (entries: ReadonlyMap<number, Entry>, first: boolean): string => {
  const numbers = [...entries.keys()].toSorted((left, right) => left - right);
  if (first) {
    const highest = numbers.at(-1) ?? 0;
    let text = `xref\n0 ${String(highest + 1)}\n`;
    for (let number = 0; number <= highest; number++) {
      text += classicLine(entries.get(number));
    }
    return text;
  }
  let text = 'xref\n';
  for (let index = 0; index < numbers.length;) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === (numbers[end] ?? 0) + 1) {
      end++;
    }
    text += `${String(numbers[index])} ${String(end - index + 1)}\n`;
    for (let run = index; run <= end; run++) {
      text += classicLine(entries.get(numbers[run] ?? 0));
    }
    index = end + 1;
  }
  return text;
};

interface StreamTable {
  readonly index: string;
  readonly data: string;
}

const streamTable = (entries: ReadonlyMap<number, Entry>): StreamTable => {
  const numbers = [...entries.keys()].toSorted((left, right) => left - right);
  let data = '';
  const pairs: Array<number> = [];
  for (const number of numbers) {
    const last = pairs.length - 2;
    if (last >= 0 && (pairs[last] ?? 0) + (pairs[last + 1] ?? 0) === number) {
      pairs[last + 1] = (pairs[last + 1] ?? 0) + 1;
    } else {
      pairs.push(number, 1);
    }
    const entry = entries.get(number) ?? { type: 0, second: 0, third: 0 };
    const second = [24, 16, 8, 0].map(shift => Math.floor(entry.second / 2 ** shift) % 256);
    data += String.fromCodePoint(entry.type, ...second, Math.floor(entry.third / 256), entry.third % 256);
  }
  return { index: pairs.join(' '), data };
};

const ROW = 7;

// ISO 32000-1:2008, 7.4.4.4 and Table 8: Predictor 12 prefixes each row with PNG filter type 2 (Up) and stores each byte less the byte above it, modulo 256.
const pngUp = (data: Uint8Array): Uint8Array => {
  const rows = data.length / ROW;
  const encoded = new Uint8Array(rows * (ROW + 1));
  for (let row = 0; row < rows; row++) {
    encoded[row * (ROW + 1)] = 2;
    for (let column = 0; column < ROW; column++) {
      const above = row === 0 ? 0 : (data[(row - 1) * ROW + column] ?? 0);
      encoded[row * (ROW + 1) + 1 + column] = ((data[row * ROW + column] ?? 0) - above + 256) % 256;
    }
  }
  return encoded;
};

// The filter entries and data of a cross-reference stream (ISO 32000-1:2008, 7.5.8.2) whose raw rows are W[1 4 2].
const encodedXrefData = (data: string, encoding: NonNullable<TestSection['xrefStreamEncoding']>): readonly [string, string] => {
  if (encoding === 'none') {
    return ['', data];
  }
  if (encoding === 'flate') {
    return ['/Filter/FlateDecode', latin1Text(deflateZlib(latin1Bytes(data)))];
  }
  return [`/Filter/FlateDecode/DecodeParms<</Columns ${String(ROW)}/Predictor 12>>`, latin1Text(deflateZlib(pngUp(latin1Bytes(data))))];
};

const highestNumber = (sections: ReadonlyArray<TestSection>): number => {
  let highest = 0;
  for (const section of sections) {
    for (const object of [...section.objects, ...(section.objectStreams ?? []), ...(section.free ?? [])]) {
      highest = Math.max(highest, object.number);
    }
    for (const stream of section.objectStreams ?? []) {
      for (const member of stream.members) {
        highest = Math.max(highest, member.number);
      }
    }
  }
  return highest;
};

class TestPdfWriter {
  text: string;
  size: number;
  private xrefNumber: number;
  readonly offsets = new Map<number, number>();
  readonly sections: Array<number> = [];

  constructor(sections: ReadonlyArray<TestSection>, options: BuildOptions) {
    this.text = `${options.prefix ?? ''}${options.header ?? '%PDF-1.7'}\n%\u00E2\u00E3\u00CF\u00D3\n`;
    this.size = highestNumber(sections) + 1;
    this.xrefNumber = this.size;
  }

  private streamNumber(section: TestSection): number {
    const number = section.xrefStreamNumber ?? this.xrefNumber++;
    this.size = Math.max(this.size, number + 1);
    return number;
  }

  private body(section: TestSection): Map<number, Entry> {
    const entries = new Map<number, Entry>();
    for (const object of section.objects) {
      this.offsets.set(object.number, this.text.length);
      entries.set(object.number, { type: 1, second: this.text.length, third: object.generation ?? 0 });
      this.text += `${String(object.number)} ${String(object.generation ?? 0)} obj\n${object.body}\nendobj\n`;
    }
    for (const stream of section.objectStreams ?? []) {
      let header = '';
      let body = '';
      for (const [position, member] of stream.members.entries()) {
        header += `${String(member.number)} ${String(body.length)} `;
        body += `${member.body}\n`;
        entries.set(member.number, { type: 2, second: stream.number, third: position });
      }
      this.offsets.set(stream.number, this.text.length);
      entries.set(stream.number, { type: 1, second: this.text.length, third: 0 });
      const dictionary = `/Type/ObjStm/N ${String(stream.members.length)}/First ${String(header.length + 1)}${stream.dictionary ?? ''}`;
      this.text += `${String(stream.number)} 0 obj\n${streamBody(dictionary, `${header}\n${body}`)}\nendobj\n`;
    }
    const free = (section.free ?? []).toSorted((left, right) => left.number - right.number);
    if (free.length > 0) {
      entries.set(0, { type: 0, second: free[0]?.number ?? 0, third: 65_535 });
      for (const [index, object] of free.entries()) {
        entries.set(object.number, { type: 0, second: free[index + 1]?.number ?? 0, third: object.generation });
      }
    }
    return entries;
  }

  private xrefStream(number: number, entries: ReadonlyMap<number, Entry>, trailer: string, encoding: TestSection['xrefStreamEncoding']): void {
    const table = streamTable(entries);
    const [filter, data] = encodedXrefData(table.data, encoding ?? 'none');
    this.text += `${String(number)} 0 obj\n${streamBody(`/Type/XRef/Size ${String(this.size)}/W[1 4 2]/Index[${table.index}]${filter}${trailer}`, data)}\nendobj\n`;
  }

  section(section: TestSection, first: boolean): void {
    const entries = this.body(section);
    const previous = this.sections.at(-1);
    const prev = previous === undefined ? '' : `/Prev ${String(previous)}`;
    const trailer = section.trailer ?? '';
    let offset = this.text.length;
    if (section.xref === 'hybrid') {
      const number = this.streamNumber(section);
      const streamOffset = this.text.length;
      this.xrefStream(number, new Map([...entries].filter(([, entry]) => entry.type === 2)), '', section.xrefStreamEncoding);
      const visible = new Map([...[...entries].filter(([, entry]) => entry.type !== 2), [number, { type: 1, second: streamOffset, third: 0 }] as const]);
      offset = this.text.length;
      if (first) {
        // A classic entry, even a free one, hides the stream entry from qpdf, MuPDF and this library, so the original table leaves the members out rather than covering every number.
        for (let number = 0; number <= Math.max(...visible.keys()); number++) {
          if (!entries.has(number) && !visible.has(number)) {
            visible.set(number, { type: 0, second: 0, third: 65_535 });
          }
        }
      }
      this.text += `${classicTable(visible, false)}trailer\n<</Size ${String(this.size)}${prev}/XRefStm ${String(streamOffset)}${trailer}>>\n`;
    } else if (section.xref === 'classic') {
      this.text += `${classicTable(entries, first)}trailer\n<</Size ${String(this.size)}${prev}${trailer}>>\n`;
    } else {
      const number = this.streamNumber(section);
      entries.set(number, { type: 1, second: offset, third: 0 });
      if (first && !entries.has(0)) {
        entries.set(0, { type: 0, second: 0, third: 65_535 });
      }
      this.xrefStream(number, entries, `${prev}${trailer}`, section.xrefStreamEncoding);
    }
    this.text += `startxref\n${String(offset)}\n%%EOF\n`;
    this.sections.push(offset);
  }
}

// A section the writer cannot express is refused rather than written as something else. A number may still appear twice in one section, which tests of duplicate objects rely on.
const checkSection = (section: TestSection, index: number): void => {
  // ISO 32000-1:2008, 7.5.8.3: only a cross-reference stream has type 2 entries for object-stream members; a classic table would list them as free.
  if (section.xref === 'classic' && (section.objectStreams?.length ?? 0) > 0) {
    throw new RangeError(`section ${String(index)} has object streams but a classic cross-reference table`);
  }
  const objects = [...section.objects, ...(section.objectStreams ?? []).flatMap(stream => [stream, ...stream.members])];
  // ISO 32000-1:2008, 7.3.10: object numbers are positive integers and generations are non-negative; 7.5.4 limits a generation to five digits, at most 65535.
  for (const object of objects) {
    const generation = 'generation' in object ? (object.generation ?? 0) : 0;
    if (!Number.isSafeInteger(object.number) || object.number < 1 || !Number.isInteger(generation) || generation < 0 || generation > 65_535) {
      throw new RangeError(`section ${String(index)} has object ${String(object.number)} ${String(generation)}, which a cross-reference entry cannot hold`);
    }
  }
  const free = section.free ?? [];
  for (const [position, object] of free.entries()) {
    const taken = objects.some(other => other.number === object.number) || free.findIndex(other => other.number === object.number) !== position;
    if (
      !Number.isSafeInteger(object.number) ||
      object.number < 1 ||
      !Number.isInteger(object.generation) ||
      object.generation < 0 ||
      object.generation > 65_535 ||
      taken
    ) {
      throw new RangeError(`section ${String(index)} cannot list object ${String(object.number)} ${String(object.generation)} as free`);
    }
  }
  const stream = section.xrefStreamNumber;
  if (
    stream !== undefined &&
    (section.xref === 'classic' || !Number.isSafeInteger(stream) || stream < 1 || [...objects, ...free].some(object => object.number === stream))
  ) {
    throw new RangeError(`section ${String(index)} cannot number its cross-reference stream ${String(stream)}`);
  }
};

/** Writes one PDF: the first section is the original file and each further section an incremental update whose Prev points at the one before. */
export const buildPdf = (sections: ReadonlyArray<TestSection>, options: BuildOptions = {}): TestPdf => {
  for (const [index, section] of sections.entries()) {
    checkSection(section, index);
  }
  const writer = new TestPdfWriter(sections, options);
  for (const [index, section] of sections.entries()) {
    writer.section(section, index === 0);
  }
  return { bytes: latin1Bytes(writer.text), text: writer.text, offsets: writer.offsets, sections: writer.sections, size: writer.size };
};
