import type { DocumentInternals } from '../document/documentInternals.ts';
import type { StreamProducer } from '../document/editedObjects.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { createMd5, md5 } from '../hash/md5.ts';
import { pdfName } from '../object/pdfObject.ts';

const hex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
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
  | { readonly kind: 'dictionary'; readonly keys: readonly Uint8Array[]; readonly dataDigest?: Uint8Array }
  | { readonly kind: 'reference'; readonly key: string };

const referenceKey = (value: Extract<PdfDirectObject, { kind: 'reference' }>): string => `${String(value.objectNumber)}.${String(value.generation)}`;

// Dictionaries compare regardless of key order, and an entry whose value is null is the same as an absent one (ISO 32000-1:2008, 7.3.7); a stream adds the digest of its data.
const dictionaryText = (keys: readonly Uint8Array[], parts: readonly string[], dataDigest: Uint8Array | undefined): string => {
  const texts: string[] = [];
  for (const [index, key] of keys.entries()) {
    const text = parts[index] ?? 'null';
    if (text !== 'null') texts.push(`/${hex(key)} ${text}`);
  }
  const dictionary = `<<${texts.toSorted().join(' ')}>>`;
  return dataDigest === undefined ? dictionary : `${dictionary}stream${hex(dataDigest)}`;
};

const producedDigest = (produce: StreamProducer): Uint8Array => {
  const hash = createMd5();
  for (const chunk of produce()) hash.update(chunk);
  return hash.digest();
};

// Resolved text, or undefined when an object the value leads to cannot be read.
const readable = (read: () => string): string | undefined => {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
};

/**
 * Canonical texts for values with their references followed, for comparing values that two documents may number, order or spell differently: numbers by value, strings and names by bytes, dictionaries by sorted keys, stream data by digest.
 * The text of each referenced object is worked out once and kept, and the walk keeps its own work list, so shared objects and deep nesting cost neither repeated work nor call stack.
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
    const tasks: Task[] = [{ kind: 'visit', value, producer: undefined }];
    const results: string[] = [];
    const path = new Set<string>();
    for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
      if (task.kind === 'visit') this.visit(task.value, task.producer, { tasks, results, path });
      else if (task.kind === 'reference') {
        path.delete(task.key);
        const text = results.pop() ?? 'null';
        const kept = text.length > DIGEST_ABOVE ? `#${hex(md5(latin1Bytes(text)))}` : text;
        this.known.set(task.key, kept);
        results.push(kept);
      } else {
        const parts = results.splice(results.length - (task.kind === 'array' ? task.count : task.keys.length));
        results.push(task.kind === 'array' ? `[${parts.join(' ')}]` : dictionaryText(task.keys, parts, task.dataDigest));
      }
    }
    return results.pop() ?? 'null';
  }

  private visit(
    value: PdfObject | undefined,
    producer: StreamProducer | undefined,
    walk: { readonly tasks: Task[]; readonly results: string[]; readonly path: Set<string> },
  ): void {
    const { tasks, results, path } = walk;
    if (value === undefined) {
      results.push('null');
      return;
    }
    if (value.kind === 'reference') {
      const key = referenceKey(value);
      const known = this.known.get(key);
      if (known !== undefined || path.has(key)) {
        results.push(known ?? 'cycle');
        return;
      }
      if (path.size >= MAX_DEPTH) throw new ResourceLimitError(`a compared value leads through more than ${String(MAX_DEPTH)} references`);
      path.add(key);
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
