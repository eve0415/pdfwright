import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ContentOperations } from './contentTokens.ts';
import type { PdfDifference } from './pdfDifference.ts';
import type { ResolvedTexts } from './resolvedText.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';

import { readOperations } from './contentTokens.ts';
import { duplicatesOf, reportDuplicates } from './duplicateKeys.ts';
import { sameText } from './resolvedText.ts';

const CONTENTS = pdfName('Contents').bytes;

const ignore = (): void => {
  // Decoding for comparison reports nothing; the documents' own warnings were given when they were loaded.
};

type Side = 'a' | 'b';

/** The content stream references of a page, read through an indirect array (ISO 32000-1:2008, 7.7.3.3, Table 30, Contents). */
const contentReferences = (document: DocumentInternals, page: PageEntry): PdfDirectObject[] => {
  const dictionary = document.objects.resolve(page.reference.objectNumber, page.reference.generation);
  const contents = dictionary.kind === 'dictionary' ? dictionary.entries.get(CONTENTS) : undefined;
  if (contents === undefined) return [];
  const resolved = document.objects.deref(contents);
  const references = resolved?.kind === 'array' ? [...resolved.items] : [contents];
  // ISO 32000-1:2008, 7.3.10: a reference to a missing object is a reference to null, which contributes no content.
  return references.filter(reference => document.objects.deref(reference)?.kind !== 'null');
};

type Decoded = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

/** Decodes a stream for comparison; data that cannot be decoded is reported rather than skipped, and resource limits propagate. */
export const decodeForComparison = (document: DocumentInternals, stream: PdfObject | undefined): Decoded => {
  if (stream?.kind !== 'stream') return { ok: false, reason: 'not a stream' };
  try {
    return {
      ok: true,
      bytes: decodeStream(stream, { maxDecodedBytes: document.maxDecodedBytes, warn: ignore, deref: value => document.objects.deref(value) }),
    };
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof UnsupportedFeatureError) return { ok: false, reason: error.message };
    throw error;
  }
};

// Streams in a Contents array behave "as if all of the streams in the array were concatenated, in order" (Table 30); the division falls between tokens, so joining them with a line end changes nothing.
// The joined content is held under the document's maxDecodedBytes, and a stream the array names more than once is decoded once.
const joinedContent = (document: DocumentInternals, references: readonly PdfDirectObject[]): Decoded => {
  const parts: Uint8Array[] = [];
  const decodedStreams = new Map<string, Uint8Array>();
  let total = 0;
  for (const reference of references) {
    const key = reference.kind === 'reference' ? `${String(reference.objectNumber)}.${String(reference.generation)}` : undefined;
    let bytes = key === undefined ? undefined : decodedStreams.get(key);
    if (bytes === undefined) {
      const decoded = decodeForComparison(document, document.objects.deref(reference));
      if (!decoded.ok) return decoded;
      ({ bytes } = decoded);
      if (key !== undefined) decodedStreams.set(key, bytes);
    }
    total += bytes.length + 1;
    if (total > document.maxDecodedBytes) {
      throw new ResourceLimitError(`the content of a page decodes to more than maxDecodedBytes (${String(document.maxDecodedBytes)} bytes)`);
    }
    parts.push(bytes, Uint8Array.of(0x0a));
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return { ok: true, bytes: joined };
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length &&
  ((left.buffer === right.buffer && left.byteOffset === right.byteOffset) || left.every((byte, index) => byte === right[index]));

// Streams with the same stored bytes under the same resolved filters hold the same content, without decoding.
const sameStored = (sides: Pick<PageSides, 'a' | 'b' | 'texts'>, [left, right]: readonly [PdfDirectObject, PdfDirectObject | undefined]): boolean => {
  const streamA = sides.a.objects.deref(left);
  const streamB = sides.b.objects.deref(right);
  // Table 30 allows only streams; two identical values of another kind contribute the same, whatever a reader makes of them.
  if (streamA?.kind !== 'stream' && streamB?.kind !== 'stream') return sameText(sides.texts.a.value(streamA), sides.texts.b.value(streamB));
  return (
    streamA?.kind === 'stream' &&
    streamB?.kind === 'stream' &&
    sameBytes(streamA.data, streamB.data) &&
    sameText(sides.texts.a.encoding(streamA), sides.texts.b.encoding(streamB))
  );
};

// The content stream references of a page, or undefined with a difference when an object on the way cannot be parsed.
const readReferences = (
  page: number,
  [document, entry, side]: readonly [DocumentInternals, PageEntry, Side],
  differences: PdfDifference[],
): PdfDirectObject[] | undefined => {
  try {
    return contentReferences(document, entry);
  } catch (error: unknown) {
    if (!(error instanceof ParseError)) throw error;
    differences.push({ kind: 'undecodable', where: ['page', page, 'Contents'], document: side, reason: error.message });
    return undefined;
  }
};

interface PageSides {
  readonly a: DocumentInternals;
  readonly b: DocumentInternals;
  readonly pageA: PageEntry;
  readonly pageB: PageEntry;
  readonly texts: { readonly a: ResolvedTexts; readonly b: ResolvedTexts };
}

// Operations compare as exact text; a difference records how many operations each side has and how many they share at the start and at the end.
const reportOperations = (page: number, [operationsA, operationsB]: readonly [readonly string[], readonly string[]], differences: PdfDifference[]): void => {
  let prefix = 0;
  while (prefix < operationsA.length && prefix < operationsB.length && operationsA[prefix] === operationsB[prefix]) prefix++;
  if (prefix === operationsA.length && prefix === operationsB.length) return;
  let suffix = 0;
  while (suffix < operationsA.length - prefix && suffix < operationsB.length - prefix && operationsA.at(-1 - suffix) === operationsB.at(-1 - suffix)) suffix++;
  differences.push({
    kind: 'page-content',
    page,
    operationsA: operationsA.length,
    operationsB: operationsB.length,
    commonPrefix: prefix,
    commonSuffix: suffix,
  });
};

/**
 * Compares the content of one page, however it is split across streams or compressed: by stored bytes under the same filters, then by decoded bytes, then operation by operation.
 */
export const comparePageContent = (page: number, sides: PageSides, differences: PdfDifference[]): void => {
  const left = readReferences(page, [sides.a, sides.pageA, 'a'], differences);
  const right = readReferences(page, [sides.b, sides.pageB, 'b'], differences);
  if (left === undefined || right === undefined) return;
  // A content stream's dictionary is read like any other (ISO 32000-1:2008, 7.3.7).
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    reportDuplicates(['page', page, 'Contents', index], [duplicatesOf(sides.a, left[index]), duplicatesOf(sides.b, right[index])], differences);
  }
  if (left.length === right.length && left.every((reference, index) => sameStored(sides, [reference, right[index]]))) return;
  const decoded: Record<Side, Decoded> = { a: joinedContent(sides.a, left), b: joinedContent(sides.b, right) };
  for (const side of ['a', 'b'] as const) {
    const result = decoded[side];
    if (!result.ok) differences.push({ kind: 'undecodable', where: ['page', page, 'Contents'], document: side, reason: result.reason });
  }
  if (!decoded.a.ok || !decoded.b.ok || sameBytes(decoded.a.bytes, decoded.b.bytes)) return;
  const read: Record<Side, ContentOperations> = {
    a: readOperations(decoded.a.bytes, sides.a.maxNesting),
    b: readOperations(decoded.b.bytes, sides.b.maxNesting),
  };
  for (const side of ['a', 'b'] as const) {
    const result = read[side];
    if (!result.ok) differences.push({ kind: 'undecodable', where: ['page', page, 'Contents'], document: side, reason: result.reason });
  }
  if (!read.a.ok || !read.b.ok) return;
  reportOperations(page, [read.a.operations, read.b.operations], differences);
};
