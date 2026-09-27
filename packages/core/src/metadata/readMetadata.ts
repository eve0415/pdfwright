import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { InfoValue } from './documentInfo.ts';
import type { MappedProperty, MetadataMapping } from './mapping.ts';
import type { MetadataFinding } from './metadataFinding.ts';
import type { ScannedPackets } from './packetScan.ts';
import type { ReadPacket, ReadXmp, XmpPacket } from './xmp/readXmp.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

import { readInfoValues } from './documentInfo.ts';
import { mapMetadata } from './mapping.ts';
import { scanPackets } from './packetScan.ts';
import { readXmp } from './xmp/readXmp.ts';

/** A metadata stream reached through the Metadata entry of an object other than the catalog (ISO 32000-1:2008, Table 316). */
export interface ComponentPacket {
  /** The indirect object whose value holds the Metadata entry, directly or in a nested dictionary such as a marked-content property list. */
  readonly owner: PdfReference;
  readonly reference: PdfReference;
}

export interface DocumentMetadata {
  /** The document information dictionary: its reference when it is an indirect object, and its values by key. */
  readonly info: { readonly reference: PdfReference | undefined; readonly values: ReadonlyMap<string, InfoValue> } | undefined;
  /** The stream the catalog's Metadata entry names, as a packet, or why it cannot be read. */
  readonly xmp:
    | { readonly reference: PdfReference; readonly packet: XmpPacket }
    | { readonly reference: PdfReference; readonly unreadable: string }
    | undefined;
  /** One entry per row of XMP Part 3 Table 20. */
  readonly properties: readonly MappedProperty[];
  readonly authority: 'xmp' | 'info' | 'indeterminate';
  readonly packets: {
    readonly components: readonly ComponentPacket[];
    readonly orphans: readonly PdfReference[];
    /** The packet headers a byte scan of the source finds, by where each lies. */
    readonly scanned: ScannedPackets;
  };
  readonly findings: readonly MetadataFinding[];
}

const INFO = pdfName('Info').bytes;
const ROOT = pdfName('Root').bytes;
const METADATA = pdfName('Metadata').bytes;
const TYPE = pdfName('Type').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const FILTER = pdfName('Filter').bytes;

const nameIs = (value: PdfDirectObject | undefined, expected: string): boolean =>
  value?.kind === 'name' && new TextDecoder('latin1').decode(value.bytes) === expected;

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  return value?.kind === 'stream' ? value.dictionary : undefined;
};

const ignore = (): void => {
  // Decoding warnings for a packet are reported by the packet's own findings.
};

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

/** The document packet as read: the packet with what an edit needs, or why it cannot be read, and the stream that holds it. */
export type DocumentPacket =
  | { readonly reference: PdfReference; readonly packet: ReadPacket; readonly stream: PdfStream }
  | { readonly reference: PdfReference; readonly unreadable: string; readonly stream: PdfStream | undefined };

/** Reads the parts of the document's metadata, collecting findings as it goes. */
export class MetadataReader {
  private readonly document: DocumentInternals;
  readonly findings: MetadataFinding[] = [];

  constructor(document: DocumentInternals) {
    this.document = document;
  }

  report(code: MetadataFinding['code'], detail: string): void {
    this.findings.push({ code, detail });
  }

  // Objects that cannot be parsed read as absent here; loading already reported them.
  private resolve(value: PdfDirectObject | undefined): PdfObject | undefined {
    try {
      return this.document.objects.deref(value);
    } catch (error: unknown) {
      if (error instanceof ParseError) return undefined;
      throw error;
    }
  }

  // ISO 32000-1:2008, Table 15, Info: "(Optional; shall be an indirect reference)".
  info(): (NonNullable<DocumentMetadata['info']> & { readonly entries: PdfDictionaryEntries }) | undefined {
    const stored = this.document.objects.trailer(this.document.structure.trailer).get(INFO);
    const value = this.resolve(stored);
    if (value?.kind !== 'dictionary') {
      this.report('info-missing', 'the trailer has no document information dictionary');
      return undefined;
    }
    const reference = stored?.kind === 'reference' ? stored : undefined;
    if (reference === undefined) this.report('info-not-indirect', 'the trailer holds the document information dictionary directly, not by reference');
    return { reference, entries: value.entries, values: readInfoValues(value.entries, item => this.resolve(item)) };
  }

  private packetOf(reference: PdfReference, value: PdfStream): ReadXmp {
    // ISO 32000-1:2008, Table 315: Type "shall be Metadata for a metadata stream", and Subtype "shall be XML".
    if (!nameIs(value.dictionary.get(TYPE), 'Metadata') || !nameIs(value.dictionary.get(SUBTYPE), 'XML')) {
      this.report('metadata-dictionary', `the metadata stream ${String(reference.objectNumber)} lacks Type Metadata or Subtype XML`);
    }
    // ISO 32000-1:2008, 14.3.2, NOTE 2: the metadata "is visible as plain text to tools that are not PDF-aware only if the metadata stream is both unfiltered and unencrypted".
    if (value.dictionary.has(FILTER)) this.report('metadata-filtered', `the metadata stream ${String(reference.objectNumber)} is filtered`);
    try {
      return readXmp(decodeStream(value, { maxDecodedBytes: this.document.maxDecodedBytes, warn: ignore, deref: item => this.document.objects.deref(item) }));
    } catch (error: unknown) {
      if (error instanceof ParseError || error instanceof UnsupportedFeatureError || error instanceof ResourceLimitError) {
        return { ok: false, reason: 'undecodable' };
      }
      throw error;
    }
  }

  // ISO 32000-1:2008, Table 28, Metadata: "(Optional; PDF 1.4; shall be an indirect reference) A metadata stream that shall contain metadata for the document".
  xmp(catalog: PdfDictionaryEntries | undefined): DocumentPacket | undefined {
    const stored = catalog?.get(METADATA);
    const value = this.resolve(stored);
    if (stored?.kind !== 'reference' || value === undefined) {
      this.report(value === undefined ? 'xmp-missing' : 'metadata-not-stream', 'the catalog has no metadata stream');
      return undefined;
    }
    if (value.kind !== 'stream') {
      this.report(
        'metadata-not-stream',
        `the catalog Metadata entry names ${value.kind === 'dictionary' ? 'a dictionary' : `an object of type ${value.kind}`}, not a stream`,
      );
      return { reference: stored, unreadable: 'not-a-stream', stream: undefined };
    }
    const read = this.packetOf(stored, value);
    if (!read.ok) {
      this.report(read.reason === 'doctype' ? 'xmp-doctype' : 'xmp-unreadable', `the document packet cannot be read: ${read.reason}`);
      return { reference: stored, unreadable: read.reason, stream: value };
    }
    for (const finding of read.packet.findings) this.report(finding.code, finding.detail);
    return { reference: stored, packet: read.packet, stream: value };
  }

  // Every Metadata entry of every reachable object, looking into direct dictionaries and arrays, such as marked-content property lists in a page's Resources.
  components(reachable: ReadonlyMap<number, number>, catalogNumber: number | undefined): ComponentPacket[] {
    const components: ComponentPacket[] = [];
    for (const [objectNumber, generation] of reachable) {
      const work: PdfObject[] = [];
      const value = this.resolve({ kind: 'reference', objectNumber, generation });
      if (objectNumber === catalogNumber && value?.kind === 'dictionary') {
        for (const [, entry] of value.entries.entries()) if (entry.kind === 'dictionary' || entry.kind === 'array') work.push(entry);
      } else if (value !== undefined) work.push(value);
      for (let item = work.pop(); item !== undefined; item = work.pop()) {
        if (item.kind === 'array') for (const element of item.items) work.push(element);
        const entries = entriesOf(item);
        if (entries === undefined) continue;
        for (const [key, entry] of entries.entries()) {
          if (entry.kind === 'reference' && nameIs({ kind: 'name', bytes: key }, 'Metadata')) {
            components.push({ owner: { kind: 'reference', objectNumber, generation }, reference: entry });
          } else if (entry.kind === 'dictionary' || entry.kind === 'array') work.push(entry);
        }
      }
    }
    return components.toSorted(
      (left, right) => left.owner.objectNumber - right.owner.objectNumber || left.reference.objectNumber - right.reference.objectNumber,
    );
  }

  // An in-use object whose value has Type Metadata and that nothing reachable from the trailer references.
  orphans(reachable: ReadonlyMap<number, number>): PdfReference[] {
    const { objects } = this.document;
    const numbers = new Set([...objects.store.index.inUse(), ...objects.changes.keys()]);
    const orphans: PdfReference[] = [];
    for (const objectNumber of [...numbers].toSorted((left, right) => left - right)) {
      const generation = objects.generationOf(objectNumber);
      if (generation === undefined || reachable.has(objectNumber)) continue;
      const reference: PdfReference = { kind: 'reference', objectNumber, generation };
      if (!nameIs(entriesOf(this.resolve(reference))?.get(TYPE), 'Metadata')) continue;
      orphans.push(reference);
      this.report('orphan-metadata', `the metadata object ${String(objectNumber)} is in use but nothing reachable from the trailer references it`);
    }
    return orphans;
  }
}

/**
 * Reads the document's metadata: the document information dictionary, the catalog's XMP packet, their agreement row by row of XMP Part 3 Table 20 and the authority ISO 32000-1:2008, 14.3.2 gives, the component and orphaned metadata streams, and the packet headers a byte scan finds.
 * It never throws for damaged metadata; what cannot be read is reported as a finding.
 * The reachability walk parses every object reachable from the trailer once, and the orphan check every object in use.
 */
const publicPacket = (xmp: DocumentPacket | undefined): DocumentMetadata['xmp'] => {
  if (xmp === undefined) return undefined;
  return 'packet' in xmp ? { reference: xmp.reference, packet: xmp.packet } : { reference: xmp.reference, unreadable: xmp.unreadable };
};

export interface MetadataState {
  readonly reader: MetadataReader;
  readonly info: ReturnType<MetadataReader['info']>;
  readonly catalog: { readonly reference: PdfReference; readonly entries: PdfDictionaryEntries } | undefined;
  readonly xmp: DocumentPacket | undefined;
  readonly mapping: MetadataMapping;
}

/** Info, the document packet and their mapping, read from the document as edited; the reader has their findings. */
export const readMetadataState = (internals: DocumentInternals): MetadataState => {
  const reader = new MetadataReader(internals);
  const info = reader.info();
  const root = internals.objects.trailer(internals.structure.trailer).get(ROOT);
  const catalogValue = internals.objects.deref(root);
  const catalog = root?.kind === 'reference' && catalogValue?.kind === 'dictionary' ? { reference: root, entries: catalogValue.entries } : undefined;
  const xmp = reader.xmp(catalog?.entries);
  const mapping = mapMetadata(info?.values, xmp !== undefined && 'packet' in xmp ? xmp.packet : undefined);
  for (const finding of mapping.findings) reader.report(finding.code, finding.detail);
  return { reader, info, catalog, xmp, mapping };
};

/**
 * Reads the document's metadata: the document information dictionary, the catalog's XMP packet, their agreement row by row of XMP Part 3 Table 20 and the authority ISO 32000-1:2008, 14.3.2 gives, the component and orphaned metadata streams, and the packet headers a byte scan finds.
 * It never throws for damaged metadata; what cannot be read is reported as a finding.
 * The reachability walk parses every object reachable from the trailer once, and the orphan check every object in use.
 */
export const readMetadata = (document: LoadedDocument): DocumentMetadata => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new InvalidArgumentError('readMetadata needs a document from loadDocument');
  const { reader, info, catalog, xmp, mapping } = readMetadataState(internals);
  const { objects: reachable } = reachableObjects(internals);
  const components = reader.components(reachable, catalog?.reference.objectNumber);
  const orphans = reader.orphans(reachable);
  const scanned = scanPackets(internals, {
    document: xmp?.reference.objectNumber,
    components: new Set(components.map(component => component.reference.objectNumber)),
    orphans: new Set(orphans.map(orphan => orphan.objectNumber)),
  });
  if (scanned.superseded > 0) {
    reader.report('superseded-packets', `${String(scanned.superseded)} packet headers lie in earlier revisions or outside any object in use`);
  }
  const publicInfo = info === undefined ? undefined : { reference: info.reference, values: info.values };
  const publicXmp = publicPacket(xmp);
  return {
    info: publicInfo,
    xmp: publicXmp,
    properties: mapping.properties,
    authority: mapping.authority,
    packets: { components, orphans, scanned },
    findings: reader.findings,
  };
};
