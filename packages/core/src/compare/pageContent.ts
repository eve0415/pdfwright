import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { PdfDifference } from './pdfDifference.ts';

import { ParseError } from '../error/parseError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';

import { operationHashes } from './contentTokens.ts';

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
const joinedContent = (document: DocumentInternals, references: readonly PdfDirectObject[]): Decoded => {
  const parts: Uint8Array[] = [];
  for (const reference of references) {
    const decoded = decodeForComparison(document, document.objects.deref(reference));
    if (!decoded.ok) return decoded;
    parts.push(decoded.bytes, Uint8Array.of(0x0a));
  }
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return { ok: true, bytes: joined };
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

interface PageSides {
  readonly a: DocumentInternals;
  readonly b: DocumentInternals;
  readonly pageA: PageEntry;
  readonly pageB: PageEntry;
}

/**
 * Compares the content of one page, however it is split across streams or compressed: by decoded bytes, then operation by operation.
 */
export const comparePageContent = (page: number, sides: PageSides, differences: PdfDifference[]): void => {
  const left = contentReferences(sides.a, sides.pageA);
  const right = contentReferences(sides.b, sides.pageB);
  const decoded: Record<Side, Decoded> = { a: joinedContent(sides.a, left), b: joinedContent(sides.b, right) };
  for (const side of ['a', 'b'] as const) {
    const result = decoded[side];
    if (!result.ok) differences.push({ kind: 'undecodable', where: ['page', page, 'Contents'], document: side, reason: result.reason });
  }
  if (!decoded.a.ok || !decoded.b.ok || sameBytes(decoded.a.bytes, decoded.b.bytes)) return;
  const operationsA = operationHashes(decoded.a.bytes);
  const operationsB = operationHashes(decoded.b.bytes);
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
