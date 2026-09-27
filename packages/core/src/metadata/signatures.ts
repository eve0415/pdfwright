import type { DocumentInternals } from '../document/documentInternals.ts';

import { ParseError } from '../error/parseError.ts';
import { pdfName } from '../object/pdfObject.ts';

const ROOT = pdfName('Root').bytes;
const ACRO_FORM = pdfName('AcroForm').bytes;
const SIG_FLAGS = pdfName('SigFlags').bytes;
const PERMS = pdfName('Perms').bytes;

/**
 * Whether signatures in the document could be invalidated by writing it in full rather than as an update: 'append-only' when the interactive form sets SigFlags bit 2, 'permissions' when the catalog has a permissions dictionary, else undefined.
 * ISO 32000-1:2008, Table 219, AppendOnly: "If set, the document contains signatures that may be invalidated if the file is saved (written) in a way that alters its previous contents, as opposed to an incremental update."
 * Table 28, Perms: "A permissions dictionary that shall specify user access permissions for the document"; its signatures (12.8.4) are treated the same way.
 */
export const signatureProtection = (document: DocumentInternals): 'append-only' | 'permissions' | undefined => {
  const { objects, structure } = document;
  try {
    const catalog = objects.deref(structure.trailer.get(ROOT));
    if (catalog?.kind !== 'dictionary') return undefined;
    const form = objects.deref(catalog.entries.get(ACRO_FORM));
    const flags = form?.kind === 'dictionary' ? objects.deref(form.entries.get(SIG_FLAGS)) : undefined;
    // Table 219 numbers bits from 1 for the low-order bit, so AppendOnly is the value 2.
    if (flags?.kind === 'integer' && Math.floor(flags.value / 2) % 2 === 1) return 'append-only';
    return objects.deref(catalog.entries.get(PERMS))?.kind === 'dictionary' ? 'permissions' : undefined;
  } catch (error: unknown) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
};
