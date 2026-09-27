import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

const ROOT = pdfName('Root').bytes;
const ACRO_FORM = pdfName('AcroForm').bytes;
const SIG_FLAGS = pdfName('SigFlags').bytes;
const PERMS = pdfName('Perms').bytes;

/** Why a full rewrite could invalidate signatures in a document. */
export type SignatureProtection = 'append-only' | 'permissions' | 'unreadable-flags';

const readOrUndefined = (read: () => PdfObject | undefined): PdfObject | undefined => {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
};

// Table 218, SigFlags: "(Optional; PDF 1.3) A set of flags specifying various document-level characteristics related to signature fields"; an integral real is read as its integer, and any other value, or one that cannot be parsed, as unknown.
const sigFlags = (document: DocumentInternals, catalog: PdfDictionaryEntries): number | 'unknown' | undefined => {
  const { objects } = document;
  try {
    const form = objects.deref(catalog.get(ACRO_FORM));
    const flags = form?.kind === 'dictionary' ? objects.deref(form.entries.get(SIG_FLAGS)) : undefined;
    if (flags === undefined || flags.kind === 'null') return undefined;
    const value = flags.kind === 'integer' || flags.kind === 'real' ? flags.value : undefined;
    return typeof value === 'number' && Number.isInteger(value) ? value : 'unknown';
  } catch (error: unknown) {
    if (error instanceof ParseError) return 'unknown';
    throw error;
  }
};

/**
 * Whether signatures in the document could be invalidated by writing it in full rather than as an update: 'append-only' when the interactive form sets SigFlags bit 2, 'unreadable-flags' when SigFlags is not an integer, 'permissions' when the catalog has a permissions dictionary, else undefined.
 * ISO 32000-1:2008, Table 219, AppendOnly: "If set, the document contains signatures that may be invalidated if the file is saved (written) in a way that alters its previous contents, as opposed to an incremental update."
 * Table 28, Perms: "A permissions dictionary that shall specify user access permissions for the document"; its signatures (12.8.4) are treated the same way.
 * Flags that cannot be read fail safe, as protection.
 */
export const signatureProtection = (document: DocumentInternals): SignatureProtection | undefined => {
  const { objects, structure } = document;
  const catalog = readOrUndefined(() => objects.deref(structure.trailer.get(ROOT)));
  if (catalog?.kind !== 'dictionary') return undefined;
  const flags = sigFlags(document, catalog.entries);
  if (flags === 'unknown') return 'unreadable-flags';
  // Table 219 numbers bits from 1 for the low-order bit, so AppendOnly is the value 2.
  if (flags !== undefined && Math.floor(flags / 2) % 2 === 1) return 'append-only';
  return readOrUndefined(() => objects.deref(catalog.entries.get(PERMS)))?.kind === 'dictionary' ? 'permissions' : undefined;
};
