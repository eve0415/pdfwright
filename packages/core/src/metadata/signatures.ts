import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

const ROOT = pdfName('Root').bytes;
const ACRO_FORM = pdfName('AcroForm').bytes;
const SIG_FLAGS = pdfName('SigFlags').bytes;
const PERMS = pdfName('Perms').bytes;
const FIELDS = pdfName('Fields').bytes;
const KIDS = pdfName('Kids').bytes;
const FT = pdfName('FT').bytes;
const V = pdfName('V').bytes;

/** Why a full rewrite could invalidate signatures in a document. */
export type SignatureProtection = 'signatures-exist' | 'append-only' | 'permissions' | 'unreadable-flags';

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

const populatedSignatureField = (document: DocumentInternals, catalog: PdfDictionaryEntries): boolean => {
  // ISO 32000-1:2008, 12.7.3.1, Table 220: FT is inheritable; 12.7.4.5 gives a signature field FT Sig and its V the signature dictionary.
  const { objects } = document;
  try {
    const form = objects.deref(catalog.get(ACRO_FORM));
    const fields = form?.kind === 'dictionary' ? objects.deref(form.entries.get(FIELDS)) : undefined;
    if (fields?.kind !== 'array') return false;
    const pending = fields.items.map(value => ({ value, signature: false }));
    const visited = new Set<number>();
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (next.value.kind === 'reference') {
        if (visited.has(next.value.objectNumber)) continue;
        visited.add(next.value.objectNumber);
      }
      const field = objects.deref(next.value);
      if (field?.kind !== 'dictionary') continue;
      const type = objects.deref(field.entries.get(FT));
      const signature = type?.kind === 'name' ? new TextDecoder('latin1').decode(type.bytes) === 'Sig' : next.signature;
      const value = objects.deref(field.entries.get(V));
      if (signature && value !== undefined && value.kind !== 'null') return true;
      const kids = objects.deref(field.entries.get(KIDS));
      if (kids?.kind === 'array') for (const child of kids.items) pending.push({ value: child, signature });
    }
    return false;
  } catch (error: unknown) {
    if (error instanceof ParseError) return true;
    throw error;
  }
};

/**
 * Whether signatures in the document could be invalidated by writing it in full rather than as an update: 'append-only' when the interactive form sets SigFlags bit 2, 'signatures-exist' when it sets bit 1 or has a populated signature field, 'unreadable-flags' when SigFlags is not an integer, 'permissions' when the catalog has a permissions dictionary, else undefined.
 * ISO 32000-1:2008, Table 219, AppendOnly: "If set, the document contains signatures that may be invalidated if the file is saved (written) in a way that alters its previous contents, as opposed to an incremental update."
 * SignaturesExist: "If set, the document contains at least one signature field"; a full rewrite moves the bytes each signature covers, which the ByteRange entry of Table 252 (12.8.1) gives as "the exact byte range for the digest calculation", so that flag alone is protection too.
 * Table 28, Perms: "A permissions dictionary that shall specify user access permissions for the document"; its signatures (12.8.4) are treated the same way.
 * Flags that cannot be read fail safe, as protection.
 */
export const signatureProtection = (document: DocumentInternals): SignatureProtection | undefined => {
  const { objects, structure } = document;
  const catalog = readOrUndefined(() => objects.deref(structure.trailer.get(ROOT)));
  if (catalog?.kind !== 'dictionary') return undefined;
  const flags = sigFlags(document, catalog.entries);
  if (flags === 'unknown') return 'unreadable-flags';
  // Table 219 numbers bits from 1 for the low-order bit, so AppendOnly is the value 2 and SignaturesExist the value 1.
  if (flags !== undefined && Math.floor(flags / 2) % 2 === 1) return 'append-only';
  if (flags !== undefined && flags % 2 === 1) return 'signatures-exist';
  if (readOrUndefined(() => objects.deref(catalog.entries.get(PERMS)))?.kind === 'dictionary') return 'permissions';
  return populatedSignatureField(document, catalog.entries) ? 'signatures-exist' : undefined;
};
