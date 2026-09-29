import type { Length } from '../length/length.ts';
import type { PdfDictionaryEntries } from './pdfDictionaryEntries.ts';
import type { PdfObject } from './pdfObject.ts';

/**
 * `strict`: kinds must match (integer 1 differs from real 1) and strings must share their literal or hexadecimal form.
 * `lenient`: numbers compare by value, as ISO 32000-1:2008, 7.3.3, NOTE 2 allows ("Wherever a real number is expected, an integer may be used instead"), and strings by bytes alone.
 */
export type EqualityMode = 'strict' | 'lenient';

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

// An exact length is compared through the double nearest to it, which is the value a parsed real holds.
const numeric = (value: number | Length): number => (typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator));

const numberOf = (value: PdfObject): number | undefined => {
  if (value.kind === 'integer') return value.value;
  return value.kind === 'real' ? numeric(value.value) : undefined;
};

type PdfString = Extract<PdfObject, { kind: 'string' }>;
type PdfReference = Extract<PdfObject, { kind: 'reference' }>;

const sameString = (left: PdfString, right: PdfString, mode: EqualityMode): boolean =>
  sameBytes(left.bytes, right.bytes) && (mode === 'lenient' || left.encoding === right.encoding);

const sameReference = (left: PdfReference, right: PdfReference): boolean => left.objectNumber === right.objectNumber && left.generation === right.generation;

const scalarEqual = (left: PdfObject, right: PdfObject, mode: EqualityMode): boolean => {
  if (left.kind === 'string') return right.kind === 'string' && sameString(left, right, mode);
  if (left.kind === 'reference') return right.kind === 'reference' && sameReference(left, right);
  if (left.kind === 'name' || left.kind === 'invalid') {
    return (right.kind === 'name' || right.kind === 'invalid') && right.kind === left.kind && sameBytes(left.bytes, right.bytes);
  }
  if (left.kind === 'real') return right.kind === 'real' && numeric(left.value) === numeric(right.value);
  if (left.kind === 'boolean') return right.kind === 'boolean' && left.value === right.value;
  if (left.kind === 'integer') return right.kind === 'integer' && left.value === right.value;
  return left.kind === 'null' && right.kind === 'null';
};

class Equality {
  private readonly mode: EqualityMode;

  constructor(mode: EqualityMode) {
    this.mode = mode;
  }

  equal(left: PdfObject, right: PdfObject): boolean {
    if (this.mode === 'lenient' && numberOf(left) !== undefined) return numberOf(left) === numberOf(right);
    if (left.kind === 'array') {
      return (
        right.kind === 'array' &&
        left.items.length === right.items.length &&
        left.items.every((item, index) => this.equal(item, right.items[index] ?? { kind: 'null' }))
      );
    }
    if (left.kind === 'dictionary') return right.kind === 'dictionary' && this.entries(left.entries, right.entries);
    if (left.kind === 'stream') return right.kind === 'stream' && this.entries(left.dictionary, right.dictionary) && sameBytes(left.data, right.data);
    return scalarEqual(left, right, this.mode);
  }

  private entries(left: PdfDictionaryEntries, right: PdfDictionaryEntries): boolean {
    if (left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      const other = right.get(key);
      if (other === undefined || !this.equal(value, other)) return false;
    }
    return true;
  }
}

/** Structural equality of two values without following references; dictionaries compare as key sets, treating null values as absent (7.3.7). */
export const deepEqual = (left: PdfObject, right: PdfObject, mode: EqualityMode): boolean => new Equality(mode).equal(left, right);
