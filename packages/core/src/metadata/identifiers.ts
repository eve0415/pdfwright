import type { ObjectChange } from '../document/editedObjects.ts';

import { ValidationError } from '../error/validationError.ts';
import { createMd5, md5 } from '../hash/md5.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Formats 16 bytes as `uuid:` and lowercase hexadecimal in 8-4-4-4-12 groups.
 * XMP Part 1 8.2.2.3 "does not require any particular methodology for creating a GUID, nor does it require any specific means of formatting the GUID as a simple XMP value", and the value claims no RFC 9562 version.
 */
export const formatUuid = (bytes: Uint8Array): string => {
  const digits = hex(bytes);
  return `uuid:${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20, 32)}`;
};

export interface DocumentIdSources {
  /** The packet's xmpMM:DocumentID, if it has one. */
  readonly existing: string | undefined;
  /** The first string of the trailer's ID, if the file has one. */
  readonly fileIdentifier: Uint8Array | undefined;
  /** A value the caller supplies, which replaces any other. */
  readonly supplied: string | undefined;
}

/**
 * The DocumentID to write. XMP Part 1 Table 7 makes it "The common identifier for all versions and renditions of a resource", so an existing value is kept through every edit.
 * Without one it is derived from the first file identifier, which ISO 32000-1:2008, 14.4 keeps across updates: its 16 bytes as they are, or the MD5 of a first string of any other length.
 * Without either, a caller must supply one, since a new file identifier would be derived from a body that holds the packet.
 */
export const resolveDocumentId = (sources: DocumentIdSources): string => {
  if (sources.supplied !== undefined) return sources.supplied;
  if (sources.existing !== undefined && sources.existing !== '') return sources.existing;
  const id = sources.fileIdentifier;
  if (id === undefined) {
    throw new ValidationError('the document has neither an xmpMM:DocumentID nor a file identifier; supply documentId', 'document-id-required');
  }
  return formatUuid(id.length === 16 ? id : md5(id));
};

const ENCODER = new TextEncoder();

/**
 * The MD5 of every changed, new and deleted object other than the excluded ones, in object-number order: a set or new object as its number, generation and serialized value, a deleted one as its number and generation.
 * Two change sets that write different objects digest differently; the same change set always digests the same.
 */
export const changesDigest = (changes: ReadonlyMap<number, ObjectChange>, excluded: ReadonlySet<number>): Uint8Array => {
  const hash = createMd5();
  for (const objectNumber of [...changes.keys()].toSorted((left, right) => left - right)) {
    const change = changes.get(objectNumber);
    if (change === undefined || excluded.has(objectNumber)) continue;
    if ('deleted' in change) {
      hash.update(ENCODER.encode(`${String(objectNumber)} ${String(change.generation)} deleted\n`));
      continue;
    }
    hash.update(ENCODER.encode(`${String(objectNumber)} ${String(change.generation)} obj\n`));
    hash.update(serializeObject(change.value, { fractionDigits: 5 }));
    hash.update(ENCODER.encode('\nendobj\n'));
  }
  return hash.digest();
};

export interface InstanceIdInput {
  readonly documentId: string;
  /** The xmp:MetadataDate the packet carries. */
  readonly metadataDate: string;
  /** The packet's xmpMM:InstanceID before this save, if it had one. */
  readonly previous: string | undefined;
  /** The digest of the other objects the save writes. */
  readonly changes: Uint8Array;
}

/**
 * An xmpMM:InstanceID, which XMP Part 1 Table 7 describes as "An identifier for a specific incarnation of a resource, updated each time a file is saved".
 * It is the MD5 of the DocumentID, the metadata date, the previous InstanceID and the digest of the saved changes, so two different saves of one document get different values and the same save gets the same one.
 */
export const deriveInstanceId = (input: InstanceIdInput): string => {
  const hash = createMd5().update(ENCODER.encode('pdfwright-instance\0'));
  for (const text of [input.documentId, input.metadataDate, input.previous ?? '']) hash.update(ENCODER.encode(`${text}\0`));
  return formatUuid(hash.update(input.changes).digest());
};
