import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { IndirectObject } from '../write/writeDocument.ts';
import type { DocumentInfo } from './documentInfo.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { ValidationError } from '../error/validationError.ts';
import { createMd5 } from '../hash/md5.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { deriveInstanceId, resolveDocumentId } from './identifiers.ts';
import { checkRepresentable, newPacket } from './xmp/writeXmp.ts';
import { xmpDateString } from './xmp/xmpDate.ts';

/** Requests an agreeing XMP packet for new Info metadata; xmp is true, DocumentID comes from the first file identifier and InstanceID from document bytes unless supplied, while missing modificationDate raises ValidationError reason `metadata-date-required` under ISO 32000-1:2008, 14.3–14.4 and XMP Part 3, Table 20. */
export interface CreatedMetadataOptions {
  /** Write an XMP packet that agrees with Info; info.modificationDate is then required. */
  xmp: true;
  /** The xmpMM:DocumentID to write; by default it is derived from the first file identifier. */
  documentId?: string;
  /** The xmpMM:InstanceID to write; by default it is derived deterministically from the document bytes. */
  instanceId?: string;
}

const requireMetadataDate = (info: DocumentInfo | undefined): PdfDate => {
  if (info?.modificationDate === undefined) {
    throw new ValidationError('an XMP packet needs info.modificationDate for xmp:ModifyDate and xmp:MetadataDate', 'metadata-date-required');
  }
  return info.modificationDate;
};

interface Identifiers {
  readonly documentId: string;
  readonly instanceId: string;
}

const managedValues = (info: DocumentInfo, modified: string, { documentId, instanceId }: Identifiers): ManagedValues => ({
  title: info.title,
  author: info.author,
  subject: info.subject,
  keywords: info.keywords,
  creator: info.creator,
  producer: info.producer,
  trapped: info.trapped === 'Unknown' ? undefined : info.trapped,
  createDate: info.creationDate === undefined ? undefined : xmpDateString(info.creationDate),
  modifyDate: modified,
  metadataDate: modified,
  documentId,
  instanceId,
});

// Any identifiers of the written form serve to check the values; the real ones are derived when the document is saved.
const SAMPLE_ID = 'uuid:00000000-0000-0000-0000-000000000000';

/**
 * Checks, when a document is created, what its packet needs: throws ValidationError metadata-date-required without the date the packet takes its dates from, since no metadata date is read from a clock, and xmp-unrepresentable for a value XML 1.0 cannot carry.
 */
export const validateCreatedMetadata = (info: DocumentInfo | undefined, options: CreatedMetadataOptions): void => {
  const modified = xmpDateString(requireMetadataDate(info));
  checkRepresentable(managedValues(info ?? {}, modified, { documentId: options.documentId ?? SAMPLE_ID, instanceId: options.instanceId ?? SAMPLE_ID }));
};

const ENCODER = new TextEncoder();

// ISO 32000-1:2008, 14.4 NOTE: "The calculation of the file identifier need not be reproducible"; this one hashes every object but the packet and the trailer without ID, so that the packet can carry an identifier derived from it.
const bodyDigest = (objects: readonly IndirectObject[], trailer: PdfDictionaryEntries, fractionDigits: number): Uint8Array => {
  const hash = createMd5();
  for (const object of objects.toSorted((left, right) => left.objectNumber - right.objectNumber)) {
    hash.update(ENCODER.encode(`${String(object.objectNumber)} ${String(object.generation)} obj\n`));
    hash.update(serializeObject(object.value, { fractionDigits }));
    hash.update(ENCODER.encode('\nendobj\n'));
  }
  return hash.update(serializeObject({ kind: 'dictionary', entries: trailer }, { fractionDigits })).digest();
};

export interface CreatedPacket {
  readonly packet: PdfObject;
  readonly fileIdentifier: [Uint8Array, Uint8Array];
}

export interface CreatedPacketInput {
  /** Every object of the document but the packet. */
  readonly objects: readonly IndirectObject[];
  /** The trailer without Size and ID. */
  readonly trailer: PdfDictionaryEntries;
  readonly info: DocumentInfo;
  readonly options: CreatedMetadataOptions;
  readonly fileIdentifier: [Uint8Array, Uint8Array] | undefined;
  readonly fractionDigits: number;
}

/**
 * The packet of a created document and the file identifier it is derived from: the caller's pair, or the MD5 of every other object and the trailer as both strings.
 * xmpMM:DocumentID is the first string formatted as a GUID (or its MD5 when it is not 16 bytes) unless the caller supplies one; xmpMM:InstanceID uses the caller's value or digests the same body in place of an edit's changes.
 */
export const createdPacket = (input: CreatedPacketInput): CreatedPacket => {
  const { info } = input;
  const modified = xmpDateString(requireMetadataDate(info));
  const digest = bodyDigest(input.objects, input.trailer, input.fractionDigits);
  const fileIdentifier = input.fileIdentifier ?? [digest, digest];
  const documentId = resolveDocumentId({ existing: undefined, fileIdentifier: fileIdentifier[0], supplied: input.options.documentId });
  const instanceId = input.options.instanceId ?? deriveInstanceId({ documentId, metadataDate: modified, previous: undefined, changes: digest });
  const data = newPacket(managedValues(info, modified, { documentId, instanceId }));
  // ISO 32000-1:2008, Table 315: Type "shall be Metadata for a metadata stream", and Subtype "shall be XML"; the packet is left unfiltered, so that it stays visible to tools that do not parse PDF (14.3.2, NOTE 2).
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('Metadata')],
    [pdfName('Subtype').bytes, pdfName('XML')],
  ]);
  return { packet: { kind: 'stream', dictionary, data }, fileIdentifier };
};
