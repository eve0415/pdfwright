import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ValuePath, ValueSummary } from './pdfDifference.ts';

import { deepEqual } from '../object/deepEqual.ts';
import { pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';
import { IN_FILE } from '../xref/objectIndex.ts';

import { operationHashes } from './contentTokens.ts';
import { decodeForComparison } from './pageContent.ts';

export interface Mismatch {
  readonly path: ValuePath;
  readonly a: ValueSummary;
  readonly b: ValueSummary;
}

export interface GraphReport {
  readonly mismatch: (mismatch: Mismatch) => void;
  readonly undecodable: (where: ValuePath, side: 'a' | 'b', reason: string) => void;
}

type Value = PdfObject | PdfDirectObject | undefined;

export interface DictionaryPair {
  readonly left: PdfDictionaryEntries;
  readonly right: PdfDictionaryEntries;
  readonly path: ValuePath;
  readonly skip?: ReadonlySet<string>;
}

const STREAM_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);
const SUBTYPE = pdfName('Subtype').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

const serializedText = (value: PdfDirectObject): string => {
  try {
    return latin1(serializeObject(value, { fractionDigits: 6 }));
  } catch {
    // Parsed names that the serializer refuses, such as ones with a null byte, are described by their kind.
    return value.kind;
  }
};

/** A short description of a value for a difference report. */
export const summarize = (value: Value): ValueSummary => {
  if (value === undefined) return { kind: 'absent', text: '' };
  if (value.kind === 'stream') return { kind: 'stream', text: `stream of ${String(value.data.length)} bytes` };
  const text = serializedText(value);
  return { kind: value.kind, text: text.length > 120 ? `${text.slice(0, 117)}...` : text };
};

const numberOf = (value: Value): number | undefined => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind !== 'real') return undefined;
  return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
};

// Scalars compare by value: numbers whether integer or real (ISO 32000-1:2008, 7.3.3, NOTE 2), names, strings and invalid tokens by bytes, strings in either form.
const scalarEqual = (left: Value, right: Value): boolean => {
  const leftNumber = numberOf(left);
  if (leftNumber !== undefined) return leftNumber === numberOf(right);
  if (left?.kind === 'string' && right?.kind === 'string') return sameBytes(left.bytes, right.bytes);
  if (left === undefined || right === undefined) return left === right;
  return deepEqual(left, right, 'strict');
};

/**
 * Compares two value graphs after resolving references, never by object number.
 * A pair of objects already under comparison counts as equal, which ends cycles and compares a shared object once; dictionaries compare as key sets with null values absent.
 */
export class ValueGraph {
  private readonly a: DocumentInternals;
  private readonly b: DocumentInternals;
  private readonly report: GraphReport;
  private readonly visited = new Set<string>();

  private readonly raw: boolean;

  /** With `raw`, streams compare by their stored bytes only, never decoded, as private application data must survive byte for byte. */
  constructor(sides: { readonly a: DocumentInternals; readonly b: DocumentInternals; readonly raw?: boolean }, report: GraphReport) {
    this.a = sides.a;
    this.b = sides.b;
    this.raw = sides.raw === true;
    this.report = report;
  }

  // Two unchanged objects at the same position of the same buffer are equal without being parsed.
  private sameSource(left: Value, right: Value): boolean {
    if (left?.kind !== 'reference' || right?.kind !== 'reference' || left.objectNumber !== right.objectNumber || left.generation !== right.generation) {
      return false;
    }
    if (this.a.objects.changes.has(left.objectNumber) || this.b.objects.changes.has(right.objectNumber)) return false;
    const entryA = this.a.objects.store.index.get(left.objectNumber);
    const entryB = this.b.objects.store.index.get(right.objectNumber);
    if (entryA.type !== IN_FILE || entryB.type !== IN_FILE) return false;
    const windowA = this.a.objects.store.source.window(entryA.location);
    const windowB = this.b.objects.store.source.window(entryB.location);
    return (
      windowA.bytes.buffer === windowB.bytes.buffer &&
      windowA.bytes.byteOffset + entryA.location - windowA.base === windowB.bytes.byteOffset + entryB.location - windowB.base
    );
  }

  // A pair of references already under comparison counts as equal.
  private seen(left: Value, right: Value): boolean {
    if (left?.kind !== 'reference' || right?.kind !== 'reference') return false;
    const key = `${String(left.objectNumber)}.${String(left.generation)}|${String(right.objectNumber)}.${String(right.generation)}`;
    if (this.visited.has(key)) return true;
    this.visited.add(key);
    return false;
  }

  private resolveA(value: Value): Value {
    const resolved = value?.kind === 'reference' ? this.a.objects.deref(value) : value;
    return resolved?.kind === 'null' ? undefined : resolved;
  }

  private resolveB(value: Value): Value {
    const resolved = value?.kind === 'reference' ? this.b.objects.deref(value) : value;
    return resolved?.kind === 'null' ? undefined : resolved;
  }

  compare(left: Value, right: Value, path: ValuePath): void {
    if (this.sameSource(left, right) || this.seen(left, right)) return;
    const a = this.resolveA(left);
    const b = this.resolveB(right);
    if (a?.kind === 'dictionary' && b?.kind === 'dictionary') this.entries({ left: a.entries, right: b.entries, path });
    else if (a?.kind === 'array' && b?.kind === 'array') this.items([a.items, b.items], path);
    else if (a?.kind === 'stream' && b?.kind === 'stream') this.stream([a, b], path);
    else if (!scalarEqual(a, b)) this.report.mismatch({ path, a: summarize(a), b: summarize(b) });
  }

  /** Compares two dictionaries entry by entry, leaving out keys listed in `skip`. */
  entries({ left, right, path, skip = new Set() }: DictionaryPair): void {
    const keys = new Map<string, Uint8Array>();
    for (const [key] of left.entries()) keys.set(latin1(key), key);
    for (const [key] of right.entries()) keys.set(latin1(key), key);
    for (const [name, key] of keys) if (!skip.has(name)) this.compare(left.get(key), right.get(key), [...path, name]);
  }

  private items([left, right]: readonly [readonly PdfDirectObject[], readonly PdfDirectObject[]], path: ValuePath): void {
    if (left.length !== right.length) {
      this.report.mismatch({ path, a: { kind: 'array', text: `${String(left.length)} items` }, b: { kind: 'array', text: `${String(right.length)} items` } });
      return;
    }
    for (const [index, item] of left.entries()) this.compare(item, right[index], [...path, index]);
  }

  // Streams compare by dictionary, apart from the keys that describe the encoding, and by data: equal raw bytes under equal filters, else decoded bytes; a form's content compares operation by operation (ISO 32000-1:2008, 8.10).
  private stream([left, right]: readonly [Extract<PdfObject, { kind: 'stream' }>, Extract<PdfObject, { kind: 'stream' }>], path: ValuePath): void {
    this.entries({ left: left.dictionary, right: right.dictionary, path, skip: STREAM_KEYS });
    const sameEncoding =
      scalarEqual(left.dictionary.get(FILTER), right.dictionary.get(FILTER)) &&
      scalarEqual(left.dictionary.get(DECODE_PARMS), right.dictionary.get(DECODE_PARMS));
    if (sameEncoding && sameBytes(left.data, right.data)) return;
    if (this.raw) {
      this.report.mismatch({
        path,
        a: { kind: 'stream', text: `${String(left.data.length)} stored bytes` },
        b: { kind: 'stream', text: `${String(right.data.length)} stored bytes` },
      });
      return;
    }
    const decodedA = decodeForComparison(this.a, left);
    const decodedB = decodeForComparison(this.b, right);
    if (!decodedA.ok) this.report.undecodable(path, 'a', decodedA.reason);
    if (!decodedB.ok) this.report.undecodable(path, 'b', decodedB.reason);
    if (!decodedA.ok || !decodedB.ok || sameBytes(decodedA.bytes, decodedB.bytes)) return;
    const subtype = left.dictionary.get(SUBTYPE);
    if (subtype?.kind === 'name' && latin1(subtype.bytes) === 'Form') {
      const operationsA = operationHashes(decodedA.bytes);
      const operationsB = operationHashes(decodedB.bytes);
      if (operationsA.length === operationsB.length && operationsA.every((hash, index) => hash === operationsB[index])) return;
    }
    this.report.mismatch({
      path,
      a: { kind: 'stream', text: `${String(decodedA.bytes.length)} decoded bytes` },
      b: { kind: 'stream', text: `${String(decodedB.bytes.length)} decoded bytes` },
    });
  }
}
