import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

import { EncryptedDocumentError } from '../error/encryptedDocumentError.ts';
import { pdfName } from '../object/pdfObject.ts';

const ENCRYPT = pdfName('Encrypt').bytes;

/**
 * Throws EncryptedDocumentError when any trailer or cross-reference stream dictionary has an Encrypt entry.
 * ISO 32000-1:2008, 7.6.1: "The absence of this entry from the trailer dictionary means that a conforming reader shall consider the document to be not encrypted."
 * Every trailer is checked, not only the newest, so that an update which dropped the entry does not expose older encrypted objects; a null value counts as absent (7.3.7).
 */
export const refuseEncryption = (trailers: Iterable<PdfDictionaryEntries>): void => {
  for (const trailer of trailers) {
    if (trailer.has(ENCRYPT)) throw new EncryptedDocumentError('the document is encrypted; pdfwright does not decrypt documents');
  }
};
