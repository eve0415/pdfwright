import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { PdfDifference, PieceOwner, ValuePath } from './pdfDifference.ts';
import type { GraphContext } from './valueGraph.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';
import { originalValue } from '../save/originalValue.ts';

import { duplicatesOf, reportDuplicates } from './duplicateKeys.ts';
import { ValueGraph } from './valueGraph.ts';

const PIECE_INFO = pdfName('PieceInfo').bytes;
const LAST_MODIFIED = pdfName('LastModified').bytes;
const PIECE_INFO_NAME = 'PieceInfo';
const SKIP_LAST_MODIFIED = new Set(['LastModified']);

export interface Owner {
  readonly owner: PieceOwner;
  /** The owner's dictionary in each document. */
  readonly a: PdfDictionaryEntries | undefined;
  readonly b: PdfDictionaryEntries | undefined;
  /** The owner's object in each document, for reading the source bytes of a direct PieceInfo. */
  readonly referenceA: PdfReference | undefined;
  readonly referenceB: PdfReference | undefined;
}

const latin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCodePoint(byte);
  return text;
};

const dictionaryOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

// An object that cannot be parsed reads as absent here; the value graph walks the same values and reports it.
const read = (document: DocumentInternals, value: PdfDirectObject | undefined): PdfObject | undefined => {
  try {
    return document.objects.deref(value);
  } catch (error: unknown) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
};

const dateBytes = (document: DocumentInternals, value: PdfDirectObject | undefined): Uint8Array | undefined => {
  const resolved = read(document, value);
  return resolved?.kind === 'string' ? resolved.bytes : undefined;
};

const ownerPath = (owner: PieceOwner): ValuePath => {
  if (owner.kind === 'catalog') return ['Root'];
  return owner.kind === 'page' ? ['page', owner.page] : ['page', owner.page, ...owner.path];
};

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && left.length === right.length && left.every((byte, index) => byte === right[index]));

// The source bytes of a PieceInfo written directly in the owner's dictionary; undefined when it is indirect or the owner has no source bytes.
const directSource = (document: DocumentInternals, reference: PdfReference | undefined): Uint8Array | undefined => {
  if (reference === undefined || document.objects.changes.has(reference.objectNumber)) return undefined;
  const original = originalValue(document.objects.store, reference.objectNumber, document.maxNesting);
  const node = original?.node.entries?.findLast(entry => latin1(entry.key) === PIECE_INFO_NAME)?.node;
  if (original === undefined || node === undefined || node.value.kind === 'reference') return undefined;
  return original.bytes.subarray(node.start, node.end);
};

/**
 * Compares page-piece data (ISO 32000-1:2008, 14.5) three ways: as a value graph, stream by stream by stored bytes, and, where PieceInfo is a direct object, by its source bytes.
 * The LastModified dates of the owner and of each data dictionary compare by bytes, since "modification dates shall be compared only for equality and not for sequential ordering" (14.5).
 */
export const comparePieceInfo = (sides: GraphContext, owner: Owner, differences: PdfDifference[]): void => {
  const pieceA = owner.a?.get(PIECE_INFO);
  const pieceB = owner.b?.get(PIECE_INFO);
  const path: ValuePath = [PIECE_INFO_NAME];
  const report = (aspect: 'value' | 'stream-bytes'): ConstructorParameters<typeof ValueGraph>[1] => ({
    mismatch: mismatch => {
      differences.push({ kind: 'piece-info', owner: owner.owner, aspect, ...mismatch });
    },
    undecodable: (where, document, reason) => {
      differences.push({ kind: 'undecodable', where: [...ownerPath(owner.owner), ...where], document, reason });
    },
    duplicateKey: (where, key, document) => {
      differences.push({ kind: 'ambiguous-duplicate-key', where: [...ownerPath(owner.owner), ...where], key, document });
    },
  });
  const where = ownerPath(owner.owner);
  reportDuplicates([...where, PIECE_INFO_NAME], [duplicatesOf(sides.a, pieceA), duplicatesOf(sides.b, pieceB)], differences);
  const dataA = dictionaryOf(read(sides.a, pieceA));
  const dataB = dictionaryOf(read(sides.b, pieceB));
  const values = new ValueGraph(sides, report('value'));
  if (dataA === undefined || dataB === undefined) values.compare(pieceA, pieceB, path);
  else {
    const applications = new Set([...dataA.entries(), ...dataB.entries()].map(([key]) => latin1(key)));
    for (const application of applications) {
      const key = pdfName(application).bytes;
      reportDuplicates([...where, PIECE_INFO_NAME, application], [duplicatesOf(sides.a, dataA.get(key)), duplicatesOf(sides.b, dataB.get(key))], differences);
      const appA = dictionaryOf(read(sides.a, dataA.get(key)));
      const appB = dictionaryOf(read(sides.b, dataB.get(key)));
      if (appA === undefined || appB === undefined) values.compare(dataA.get(key), dataB.get(key), [...path, application]);
      else {
        values.entries({ left: appA, right: appB, path: [...path, application], skip: SKIP_LAST_MODIFIED });
        const dateA = dateBytes(sides.a, appA.get(LAST_MODIFIED));
        const dateB = dateBytes(sides.b, appB.get(LAST_MODIFIED));
        if (!sameBytes(dateA, dateB)) {
          differences.push({ kind: 'last-modified', owner: owner.owner, path: [...path, application, 'LastModified'], a: dateA, b: dateB });
        }
      }
    }
  }
  new ValueGraph(sides, report('stream-bytes'), true).compare(pieceA, pieceB, path);
  const sourceA = directSource(sides.a, owner.referenceA);
  const sourceB = directSource(sides.b, owner.referenceB);
  if (sourceA !== undefined && sourceB !== undefined && !sameBytes(sourceA, sourceB)) {
    differences.push({
      kind: 'piece-info',
      owner: owner.owner,
      path,
      aspect: 'source-bytes',
      a: { kind: 'bytes', text: latin1(sourceA) },
      b: { kind: 'bytes', text: latin1(sourceB) },
    });
  }
  const dateA = dateBytes(sides.a, owner.a?.get(LAST_MODIFIED));
  const dateB = dateBytes(sides.b, owner.b?.get(LAST_MODIFIED));
  if (!sameBytes(dateA, dateB)) differences.push({ kind: 'last-modified', owner: owner.owner, path: ['LastModified'], a: dateA, b: dateB });
};
