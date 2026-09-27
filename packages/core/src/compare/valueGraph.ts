import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ValuePath, ValueSummary } from './pdfDifference.ts';

import { ParseError } from '../error/parseError.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { readOperations } from './contentTokens.ts';
import { duplicateKeys } from './duplicateKeys.ts';
import { decodeForComparison } from './pageContent.ts';
import { encodingText, sameEncoding } from './resolvedText.ts';

export interface Mismatch {
  readonly path: ValuePath;
  readonly a: ValueSummary;
  readonly b: ValueSummary;
}

export interface GraphReport {
  readonly mismatch: (mismatch: Mismatch) => void;
  readonly undecodable: (where: ValuePath, side: 'a' | 'b', reason: string) => void;
  /** A key that a dictionary holds more than once in one document and not in the other. */
  readonly duplicateKey: (where: ValuePath, key: Uint8Array, side: 'a' | 'b') => void;
}

type Value = PdfObject | PdfDirectObject | undefined;

export interface DictionaryPair {
  readonly left: PdfDictionaryEntries;
  readonly right: PdfDictionaryEntries;
  readonly path: ValuePath;
  readonly skip?: ReadonlySet<string>;
}

const referenceKey = (reference: Extract<PdfDirectObject, { kind: 'reference' }>): string =>
  `${String(reference.objectNumber)}.${String(reference.generation)}`;

const pageNumbers = (document: DocumentInternals): Map<string, number> => new Map(document.pages.map((page, index) => [referenceKey(page.reference), index]));

const STREAM_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);
const SUBTYPE = pdfName('Subtype').bytes;

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

// A view of the same bytes, as unchanged stream data is after a save that shares the source buffer, is equal without a byte comparison.
const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  ((left.buffer === right.buffer && left.byteOffset === right.byteOffset) || left.every((byte, index) => byte === right[index]));

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

/** What every value graph of one comparison shares: the documents, where their pages are, and the reference pairs already found equal. */
export interface GraphContext {
  readonly a: DocumentInternals;
  readonly b: DocumentInternals;
  readonly pagesA: ReadonlyMap<string, number>;
  readonly pagesB: ReadonlyMap<string, number>;
  /** Reference pairs whose whole graphs compared equal, by value and by stored bytes, so that an object many pages share is compared once. */
  readonly settled: { readonly value: Set<string>; readonly raw: Set<string> };
}

export const graphContext = (a: DocumentInternals, b: DocumentInternals): GraphContext => ({
  a,
  b,
  pagesA: pageNumbers(a),
  pagesB: pageNumbers(b),
  settled: { value: new Set(), raw: new Set() },
});

type StreamObject = Extract<PdfObject, { kind: 'stream' }>;

// A path is built as links to its parent and spelled out only when a difference is reported, so that a deep walk does not copy long paths.
interface PathLink {
  readonly parent: Where;
  readonly key: string | number;
}

type Where = ValuePath | PathLink;

const pathOf = (where: Where): ValuePath => {
  const keys: (string | number)[] = [];
  let at = where;
  while ('key' in at) {
    keys.push(at.key);
    at = at.parent;
  }
  return [...at, ...keys.toReversed()];
};

interface EntryPair {
  readonly left: PdfDictionaryEntries;
  readonly right: PdfDictionaryEntries;
  readonly path: Where;
  readonly skip?: ReadonlySet<string>;
}

type Task =
  | { readonly kind: 'compare'; readonly left: Value; readonly right: Value; readonly path: Where }
  | { readonly kind: 'data'; readonly left: StreamObject; readonly right: StreamObject; readonly path: Where }
  | { readonly kind: 'close' };

interface Frame {
  readonly key: string;
  /** The count of reported differences when the pair was opened. */
  readonly reported: number;
  /** The lowest open frame that the pair's graph leads back to. */
  lowest: number;
}

const UNREADABLE = Symbol('unreadable');

const pairKey = (left: Value, right: Value): string | undefined =>
  left?.kind === 'reference' && right?.kind === 'reference' ? `${referenceKey(left)}|${referenceKey(right)}` : undefined;

/**
 * Compares two value graphs after resolving references, never by object number; dictionaries compare as key sets with null values absent.
 * A pair of objects already under comparison counts as equal, which ends cycles; a pair whose graph compared equal without leading back into an open pair is recorded in the shared context and not compared again.
 * The walk keeps its own work list, so deep reference chains such as long outlines need no call stack.
 */
export class ValueGraph {
  private readonly context: GraphContext;
  private readonly report: GraphReport;
  private readonly raw: boolean;
  private readonly settled: Set<string>;
  private readonly tasks: Task[] = [];
  private readonly open: Frame[] = [];
  private readonly openAt = new Map<string, number>();
  /** Pairs finished in this walk, with whether they were found equal. */
  private readonly done = new Map<string, boolean>();
  private reported = 0;

  /** With `raw`, only stream data is compared, by its stored bytes and never decoded, as private application data must survive byte for byte. */
  constructor(context: GraphContext, report: GraphReport, raw = false) {
    this.context = context;
    this.raw = raw;
    this.settled = raw ? context.settled.raw : context.settled.value;
    this.report = {
      mismatch: mismatch => {
        this.reported++;
        report.mismatch(mismatch);
      },
      undecodable: (where, side, reason) => {
        this.reported++;
        report.undecodable(where, side, reason);
      },
      duplicateKey: (where, key, side) => {
        this.reported++;
        report.duplicateKey(where, key, side);
      },
    };
  }

  compare(left: Value, right: Value, path: ValuePath): void {
    this.tasks.push({ kind: 'compare', left, right, path });
    this.run();
  }

  /** Compares two dictionaries entry by entry, leaving out keys listed in `skip`. */
  entries(pair: DictionaryPair): void {
    this.pushEntries(pair);
    this.run();
  }

  private run(): void {
    for (let task = this.tasks.pop(); task !== undefined; task = this.tasks.pop()) {
      if (task.kind === 'close') this.close();
      else if (task.kind === 'data') this.data([task.left, task.right], task.path);
      else this.step(task.left, task.right, task.path);
    }
  }

  // Entries are pushed in reverse so that they are compared, and reported, in order.
  private pushEntries({ left, right, path, skip = new Set() }: EntryPair): void {
    const keys = new Map<string, Uint8Array>();
    for (const [key] of left.entries()) keys.set(latin1(key), key);
    for (const [key] of right.entries()) keys.set(latin1(key), key);
    const tasks: Task[] = [];
    for (const [name, key] of keys) {
      if (!skip.has(name)) tasks.push({ kind: 'compare', left: left.get(key), right: right.get(key), path: { parent: path, key: name } });
    }
    this.tasks.push(...tasks.toReversed());
  }

  // Pages are compared page by page elsewhere, so a reference to a page, from an outline, an annotation or the structure tree, compares by the page's position.
  private samePage(left: Value, right: Value, path: Where): boolean {
    const pageA = left?.kind === 'reference' ? this.context.pagesA.get(referenceKey(left)) : undefined;
    const pageB = right?.kind === 'reference' ? this.context.pagesB.get(referenceKey(right)) : undefined;
    if (pageA === undefined && pageB === undefined) return false;
    if (pageA !== pageB) {
      const summary = (page: number | undefined, value: Value): ValueSummary =>
        page === undefined ? summarize(value) : { kind: 'page', text: `page ${String(page)}` };
      this.mismatch({ path: pathOf(path), a: summary(pageA, left), b: summary(pageB, right) });
    }
    return true;
  }

  private mismatch(mismatch: Mismatch): void {
    if (this.raw) return;
    this.report.mismatch(mismatch);
  }

  // Whether the pair needs comparing; a pair that does is opened, and closed once everything it leads to has been compared.
  private enter(left: Value, right: Value): boolean {
    const key = pairKey(left, right);
    if (key === undefined) return true;
    if (this.settled.has(key)) return false;
    const openAt = this.openAt.get(key);
    const top = this.open.at(-1);
    if (openAt !== undefined) {
      if (top !== undefined) top.lowest = Math.min(top.lowest, openAt);
      return false;
    }
    const equal = this.done.get(key);
    if (equal !== undefined) {
      // A pair already reported unequal in this walk makes the pairs that lead to it unequal too.
      if (!equal) this.reported++;
      return false;
    }
    this.openAt.set(key, this.open.length);
    this.open.push({ key, reported: this.reported, lowest: this.open.length });
    this.tasks.push({ kind: 'close' });
    return true;
  }

  private close(): void {
    const frame = this.open.pop();
    if (frame === undefined) return;
    const index = this.open.length;
    this.openAt.delete(frame.key);
    const equal = frame.reported === this.reported && frame.lowest >= index;
    this.done.set(frame.key, equal);
    if (equal) this.settled.add(frame.key);
    const parent = this.open.at(-1);
    if (parent !== undefined) parent.lowest = Math.min(parent.lowest, frame.lowest);
  }

  // A reference to a missing object reads as null, which is the same as absent (ISO 32000-1:2008, 7.3.10); an object that cannot be parsed is reported.
  private resolve(side: 'a' | 'b', value: Value, path: Where): Value | typeof UNREADABLE {
    if (value?.kind !== 'reference') return value;
    try {
      const resolved = this.context[side].objects.deref(value);
      return resolved?.kind === 'null' ? undefined : resolved;
    } catch (error: unknown) {
      if (!(error instanceof ParseError)) throw error;
      // The comparison by value reports it; the comparison by stored bytes walks the same objects.
      if (this.raw) this.reported++;
      else this.report.undecodable(pathOf(path), side, error.message);
      return UNREADABLE;
    }
  }

  private step(left: Value, right: Value, path: Where): void {
    if (this.samePage(left, right, path) || !this.enter(left, right)) return;
    const a = this.resolve('a', left, path);
    const b = this.resolve('b', right, path);
    if (a === UNREADABLE || b === UNREADABLE) return;
    if (!this.raw) this.duplicates(left, right, path);
    if (a?.kind === 'dictionary' && b?.kind === 'dictionary') this.pushEntries({ left: a.entries, right: b.entries, path });
    else if (a?.kind === 'array' && b?.kind === 'array') this.items([a.items, b.items], path);
    else if (a?.kind === 'stream' && b?.kind === 'stream') {
      // Streams compare by dictionary, apart from the keys that describe the encoding, then by data.
      this.tasks.push({ kind: 'data', left: a, right: b, path });
      this.pushEntries({ left: a.dictionary, right: b.dictionary, path, skip: STREAM_KEYS });
    } else if (!scalarEqual(a, b)) this.mismatch({ path: pathOf(path), a: summarize(a), b: summarize(b) });
  }

  // Readers disagree about which value a key held more than once has, so a duplicate in one document only is a difference (ISO 32000-1:2008, 7.3.7).
  private duplicates(left: Value, right: Value, path: Where): void {
    const duplicatesA = left?.kind === 'reference' ? duplicateKeys(this.context.a, left.objectNumber) : undefined;
    const duplicatesB = right?.kind === 'reference' ? duplicateKeys(this.context.b, right.objectNumber) : undefined;
    for (const [place, { where, key }] of duplicatesA ?? []) {
      if (duplicatesB?.has(place) !== true) this.report.duplicateKey([...pathOf(path), ...where], key, 'a');
    }
    for (const [place, { where, key }] of duplicatesB ?? []) {
      if (duplicatesA?.has(place) !== true) this.report.duplicateKey([...pathOf(path), ...where], key, 'b');
    }
  }

  private items([left, right]: readonly [readonly PdfDirectObject[], readonly PdfDirectObject[]], path: Where): void {
    if (left.length !== right.length) {
      this.mismatch({
        path: pathOf(path),
        a: { kind: 'array', text: `${String(left.length)} items` },
        b: { kind: 'array', text: `${String(right.length)} items` },
      });
      return;
    }
    const tasks = left.map((item, index): Task => ({ kind: 'compare', left: item, right: right[index], path: { parent: path, key: index } }));
    this.tasks.push(...tasks.toReversed());
  }

  // Stream data is equal as raw bytes under the same resolved filters, else as decoded bytes; a form's content compares operation by operation (ISO 32000-1:2008, 8.10).
  private data([left, right]: readonly [StreamObject, StreamObject], path: Where): void {
    const { a, b } = this.context;
    if (sameBytes(left.data, right.data) && sameEncoding(encodingText(a, left), encodingText(b, right))) return;
    if (this.raw) {
      this.report.mismatch({
        path: pathOf(path),
        a: { kind: 'stream', text: `${String(left.data.length)} stored bytes` },
        b: { kind: 'stream', text: `${String(right.data.length)} stored bytes` },
      });
      return;
    }
    const decodedA = decodeForComparison(a, left);
    const decodedB = decodeForComparison(b, right);
    if (!decodedA.ok) this.report.undecodable(pathOf(path), 'a', decodedA.reason);
    if (!decodedB.ok) this.report.undecodable(pathOf(path), 'b', decodedB.reason);
    if (!decodedA.ok || !decodedB.ok || sameBytes(decodedA.bytes, decodedB.bytes)) return;
    const subtype = left.dictionary.get(SUBTYPE);
    if (subtype?.kind === 'name' && latin1(subtype.bytes) === 'Form') {
      const operationsA = readOperations(decodedA.bytes, a.maxNesting);
      const operationsB = readOperations(decodedB.bytes, b.maxNesting);
      if (!operationsA.ok) this.report.undecodable(pathOf(path), 'a', operationsA.reason);
      if (!operationsB.ok) this.report.undecodable(pathOf(path), 'b', operationsB.reason);
      if (!operationsA.ok || !operationsB.ok) return;
      const [listA, listB] = [operationsA.operations, operationsB.operations];
      if (listA.length === listB.length && listA.every((operation, index) => operation === listB[index])) return;
    }
    this.report.mismatch({
      path: pathOf(path),
      a: { kind: 'stream', text: `${String(decodedA.bytes.length)} decoded bytes` },
      b: { kind: 'stream', text: `${String(decodedB.bytes.length)} decoded bytes` },
    });
  }
}
