// Builds small PDF files with computed offsets for parser, editor and comparison tests.

export interface TestObject {
  readonly number: number;
  readonly generation?: number;
  /** The text between "obj" and "endobj". */
  readonly body: string;
}

export interface TestObjectStream {
  readonly number: number;
  readonly members: readonly TestObject[];
  /** Extra entries for the object stream dictionary, such as "/Extends 9 0 R". */
  readonly dictionary?: string;
}

export interface TestSection {
  readonly objects: readonly TestObject[];
  /** A hybrid section writes top-level objects to a classic section whose XRefStm entry names a cross-reference stream for object-stream members. */
  readonly xref: 'classic' | 'stream' | 'hybrid';
  /** Trailer entries other than Size and Prev, such as "/Root 1 0 R". */
  readonly trailer?: string;
  /** Object streams, which need a cross-reference stream to index their members. */
  readonly objectStreams?: readonly TestObjectStream[];
  /** Object number of the cross-reference stream; defaults to one above every other number. */
  readonly xrefStreamNumber?: number;
}

export interface TestPdf {
  readonly bytes: Uint8Array;
  readonly text: string;
  /** Offset of each top-level object's header, by object number, for the newest copy. */
  readonly offsets: ReadonlyMap<number, number>;
  /** Offset of each cross-reference section, oldest first. */
  readonly sections: readonly number[];
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

export const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

export const latin1Text = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

/** A stream object body whose Length matches its data. */
export const streamBody = (dictionary: string, data: string): string => `<<${dictionary}/Length ${String(data.length)}>>\nstream\n${data}\nendstream`;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const classicTable = (entries: ReadonlyMap<number, Entry>, first: boolean): string => {
  const numbers = [...entries.keys()].toSorted((left, right) => left - right);
  if (first) {
    const highest = numbers.at(-1) ?? 0;
    let text = `xref\n0 ${String(highest + 1)}\n`;
    for (let number = 0; number <= highest; number++) {
      const entry = entries.get(number);
      text += entry?.type === 1 ? `${pad(entry.second, 10)} ${pad(entry.third, 5)} n \n` : `0000000000 65535 f \n`;
    }
    return text;
  }
  let text = 'xref\n';
  for (let index = 0; index < numbers.length;) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === (numbers[end] ?? 0) + 1) end++;
    text += `${String(numbers[index])} ${String(end - index + 1)}\n`;
    for (let run = index; run <= end; run++) {
      const entry = entries.get(numbers[run] ?? 0);
      text += entry?.type === 1 ? `${pad(entry.second, 10)} ${pad(entry.third, 5)} n \n` : `0000000000 65535 f \n`;
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
  const pairs: number[] = [];
  for (const number of numbers) {
    const last = pairs.length - 2;
    if (last >= 0 && (pairs[last] ?? 0) + (pairs[last + 1] ?? 0) === number) pairs[last + 1] = (pairs[last + 1] ?? 0) + 1;
    else pairs.push(number, 1);
    const entry = entries.get(number) ?? { type: 0, second: 0, third: 0 };
    const second = [24, 16, 8, 0].map(shift => Math.floor(entry.second / 2 ** shift) % 256);
    data += String.fromCodePoint(entry.type, ...second, Math.floor(entry.third / 256), entry.third % 256);
  }
  return { index: pairs.join(' '), data };
};

const highestNumber = (sections: readonly TestSection[]): number => {
  let highest = 0;
  for (const section of sections) {
    for (const object of [...section.objects, ...(section.objectStreams ?? [])]) highest = Math.max(highest, object.number);
    for (const stream of section.objectStreams ?? []) for (const member of stream.members) highest = Math.max(highest, member.number);
  }
  return highest;
};

class TestPdfWriter {
  text: string;
  size: number;
  private xrefNumber: number;
  readonly offsets = new Map<number, number>();
  readonly sections: number[] = [];

  constructor(sections: readonly TestSection[], options: BuildOptions) {
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
    return entries;
  }

  private xrefStream(number: number, entries: ReadonlyMap<number, Entry>, trailer: string): void {
    const table = streamTable(entries);
    this.text += `${String(number)} 0 obj\n${streamBody(`/Type/XRef/Size ${String(this.size)}/W[1 4 2]/Index[${table.index}]${trailer}`, table.data)}\nendobj\n`;
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
      this.xrefStream(number, new Map([...entries].filter(([, entry]) => entry.type === 2)), '');
      const visible = new Map([...[...entries].filter(([, entry]) => entry.type === 1), [number, { type: 1, second: streamOffset, third: 0 }] as const]);
      offset = this.text.length;
      this.text += `${classicTable(visible, first)}trailer\n<</Size ${String(this.size)}${prev}/XRefStm ${String(streamOffset)}${trailer}>>\n`;
    } else if (section.xref === 'classic') {
      this.text += `${classicTable(entries, first)}trailer\n<</Size ${String(this.size)}${prev}${trailer}>>\n`;
    } else {
      const number = this.streamNumber(section);
      entries.set(number, { type: 1, second: offset, third: 0 });
      if (first) entries.set(0, { type: 0, second: 0, third: 65535 });
      this.xrefStream(number, entries, `${prev}${trailer}`);
    }
    this.text += `startxref\n${String(offset)}\n%%EOF\n`;
    this.sections.push(offset);
  }
}

/** Writes one PDF: the first section is the original file and each further section an incremental update whose Prev points at the one before. */
export const buildPdf = (sections: readonly TestSection[], options: BuildOptions = {}): TestPdf => {
  const writer = new TestPdfWriter(sections, options);
  for (const [index, section] of sections.entries()) writer.section(section, index === 0);
  return { bytes: latin1Bytes(writer.text), text: writer.text, offsets: writer.offsets, sections: writer.sections, size: writer.size };
};
