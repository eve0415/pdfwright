import type { DocumentInternals } from '../document/documentInternals.ts';
import type { StreamProducer } from '../document/editedObjects.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { createMd5, md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';

const hex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
};

const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, character => character.codePointAt(0) ?? 0);

const numberText = (value: Extract<PdfObject, { kind: 'integer' | 'real' }>): string =>
  String(typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator));

const scalarText = (value: Exclude<PdfObject, { kind: 'array' | 'dictionary' | 'stream' | 'reference' }>): string => {
  switch (value.kind) {
    case 'integer':
    case 'real': {
      return `n${numberText(value)}`;
    }
    case 'name': {
      return `/${hex(value.bytes)}`;
    }
    case 'string': {
      return `(${hex(value.bytes)})`;
    }
    case 'invalid': {
      return `?${hex(value.bytes)}`;
    }
    case 'boolean': {
      return value.value ? 'true' : 'false';
    }
    case 'null': {
      return 'null';
    }
    default: {
      return 'null';
    }
  }
};

/** How many references deep a described value may lead. */
const MAX_DEPTH = 64;

/** Texts of referenced objects longer than this are replaced by their digest, so that shared objects do not multiply a text's length. */
const DIGEST_ABOVE = 64;

const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const LENGTH = pdfName('Length').bytes;

type Task =
  | { readonly kind: 'visit'; readonly value: PdfObject | undefined; readonly producer: StreamProducer | undefined }
  | { readonly kind: 'array'; readonly count: number }
  | { readonly kind: 'dictionary'; readonly keys: ReadonlyArray<Uint8Array>; readonly dataDigest?: Uint8Array }
  | { readonly kind: 'reference'; readonly key: string };

const referenceKey = (value: Extract<PdfDirectObject, { kind: 'reference' }>): string => `${String(value.objectNumber)}.${String(value.generation)}`;

const kept = (text: string): string => (text.length > DIGEST_ABOVE ? `#${hex(md5(latin1Bytes(text)))}` : text);

/** A referenced object being described. */
interface Frame {
  readonly key: string;
  /** The order in which the walk entered it. */
  readonly index: number;
  /** The lowest index of an object still being described that it leads back to. */
  lowest: number;
  /** Where the objects of its cycle that close before it start in the walk's members. */
  readonly members: number;
}

interface Walk {
  readonly tasks: Array<Task>;
  readonly results: Array<string>;
  /** The referenced objects being described, innermost last. */
  readonly frames: Array<Frame>;
  /** Objects entered in this walk whose description is not yet known, with their index. */
  readonly open: Map<string, number>;
  /** Objects whose own text is done but whose cycle is still open. */
  readonly members: Array<{ readonly key: string; readonly text: string }>;
  entered: number;
}

// Dictionaries compare regardless of key order, and an entry whose value is null is the same as an absent one (ISO 32000-1:2008, 7.3.7); a stream adds the digest of its data.
const dictionaryText = (keys: ReadonlyArray<Uint8Array>, parts: ReadonlyArray<string>, dataDigest: Uint8Array | undefined): string => {
  const texts: Array<string> = [];
  for (const [index, key] of keys.entries()) {
    const text = parts[index] ?? 'null';
    if (text !== 'null') {
      texts.push(`/${hex(key)} ${text}`);
    }
  }
  const dictionary = `<<${texts.toSorted().join(' ')}>>`;
  return dataDigest === undefined ? dictionary : `${dictionary}stream${hex(dataDigest)}`;
};

const producedDigest = (produce: StreamProducer): Uint8Array => {
  const hash = createMd5();
  for (const chunk of produce()) {
    hash.update(chunk);
  }
  return hash.digest();
};

// Resolved text, or undefined when an object the value leads to cannot be read.
const readable = (read: () => string): string | undefined => {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ParseError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Canonical texts for values with their references followed, for comparing values that two documents may number, order or spell differently: numbers by value, strings and names by bytes, dictionaries by sorted keys, stream data by digest.
 * The text of each referenced object is worked out once and kept, and the walk keeps its own work list, so shared objects and deep nesting cost neither repeated work nor call stack.
 * Objects that lead back to each other through references are found as one cycle while the walk runs. Each is described by its own text, in which a reference to an object of the same cycle reads as `cycle`, followed by the sorted own texts of every object of the cycle, so that the description is the same whichever object of the cycle a walk meets first. Two cycles of the same objects that refer to each other in another order therefore read the same.
 * ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
 */
export class ResolvedTexts {
  private readonly document: DocumentInternals;
  private readonly known = new Map<string, string>();

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  /** The text of a value; throws ParseError when an object it leads to cannot be read. */
  text(value: PdfObject | undefined): string {
    const walk: Walk = { tasks: [{ kind: 'visit', value, producer: undefined }], results: [], frames: [], open: new Map(), members: [], entered: 0 };
    const { tasks, results } = walk;
    for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
      if (task.kind === 'visit') {
        this.visit(task.value, task.producer, walk);
      } else if (task.kind === 'reference') {
        this.close(walk);
      } else {
        const parts = results.splice(results.length - (task.kind === 'array' ? task.count : task.keys.length));
        results.push(task.kind === 'array' ? `[${parts.join(' ')}]` : dictionaryText(task.keys, parts, task.dataDigest));
      }
    }
    return results.pop() ?? 'null';
  }

  // The innermost referenced object has its own text: an object in a cycle that is still open reads as `cycle` to the object that referenced it, and the object that closes its cycle describes every object of it.
  private close(walk: Walk): void {
    const frame = walk.frames.pop();
    const text = walk.results.pop() ?? 'null';
    if (frame === undefined) {
      return;
    }
    const parent = walk.frames.at(-1);
    if (frame.lowest < frame.index && parent !== undefined) {
      walk.members.push({ key: frame.key, text });
      parent.lowest = Math.min(parent.lowest, frame.lowest);
      walk.results.push('cycle');
      return;
    }
    const cycle = [{ key: frame.key, text }, ...walk.members.splice(frame.members)];
    const ownTexts = cycle.map(member => member.text).toSorted();
    const shared = ownTexts.length === 1 ? '' : `~${kept(ownTexts.join(' '))}`;
    for (const member of cycle) {
      this.known.set(member.key, kept(`${member.text}${shared}`));
      walk.open.delete(member.key);
    }
    walk.results.push(this.known.get(frame.key) ?? 'null');
  }

  private visit(value: PdfObject | undefined, producer: StreamProducer | undefined, walk: Walk): void {
    const { tasks, results, frames, open } = walk;
    if (value === undefined) {
      results.push('null');
      return;
    }
    if (value.kind === 'reference') {
      const key = referenceKey(value);
      const known = this.known.get(key);
      if (known !== undefined) {
        results.push(known);
        return;
      }
      const index = open.get(key);
      if (index !== undefined) {
        const top = frames.at(-1);
        if (top !== undefined) {
          top.lowest = Math.min(top.lowest, index);
        }
        results.push('cycle');
        return;
      }
      if (frames.length >= MAX_DEPTH) {
        throw new ResourceLimitError(`a compared value leads through more than ${String(MAX_DEPTH)} references`);
      }
      const entered = walk.entered++;
      open.set(key, entered);
      frames.push({ key, index: entered, lowest: entered, members: walk.members.length });
      tasks.push(
        { kind: 'reference', key },
        { kind: 'visit', value: this.document.objects.deref(value), producer: this.document.objects.producedStreams.get(value.objectNumber) },
      );
      return;
    }
    if (value.kind === 'array') {
      tasks.push(
        { kind: 'array', count: value.items.length },
        ...value.items.map((item): Task => ({ kind: 'visit', value: item, producer: undefined })).toReversed(),
      );
      return;
    }
    if (value.kind === 'dictionary' || value.kind === 'stream') {
      const entries = [...(value.kind === 'stream' ? value.dictionary : value.entries).entries()].filter(
        ([key]) => value.kind !== 'stream' || key.length !== LENGTH.length || key.some((byte, index) => byte !== LENGTH[index]),
      );
      const keys = entries.map(([key]) => key);
      tasks.push(
        value.kind === 'stream'
          ? { kind: 'dictionary', keys, dataDigest: producer === undefined ? md5(value.data) : producedDigest(producer) }
          : { kind: 'dictionary', keys },
        ...entries.map(([, item]): Task => ({ kind: 'visit', value: item, producer: undefined })).toReversed(),
      );
      return;
    }
    results.push(scalarText(value));
  }

  /** The filters and their parameters that a stream's data is encoded with (ISO 32000-1:2008, 7.3.8.2, Table 5); undefined when an object they lead to cannot be read. */
  encoding(stream: Extract<PdfObject, { kind: 'stream' }>): string | undefined {
    return readable(() => `${this.text(stream.dictionary.get(FILTER))} ${this.text(stream.dictionary.get(DECODE_PARMS))}`);
  }

  /** A value's text; undefined when an object it leads to cannot be read. */
  value(value: PdfObject | undefined): string | undefined {
    return readable(() => this.text(value));
  }
}

/** Whether two resolved texts are known to be the same. */
export const sameText = (left: string | undefined, right: string | undefined): boolean => left !== undefined && left === right;
