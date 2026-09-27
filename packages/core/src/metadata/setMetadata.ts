import type { PdfDate } from '../date/pdfDate.ts';
import type { DocumentInternals } from '../document/documentInternals.ts';
import type { EditedObjects, ObjectChange } from '../document/editedObjects.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { MappedKey, MappedProperty, MetadataMapping } from './mapping.ts';
import type { ComponentPacket, DocumentPacket, MetadataState } from './readMetadata.ts';
import type { SignatureProtection } from './signatures.ts';
import type { ReadPacket } from './xmp/readXmp.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { parsePdfDate, pdfDateObject } from '../date/pdfDate.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

import { pdfTextString } from './documentInfo.ts';
import { changesDigest, deriveInstanceId, resolveDocumentId } from './identifiers.ts';
import { XMP_MM_NAMESPACE, comparableText } from './mapping.ts';
import { scanPackets } from './packetScan.ts';
import { MetadataReader, readMetadataState } from './readMetadata.ts';
import { signatureProtection } from './signatures.ts';
import { splicePacket } from './xmp/splicePacket.ts';
import { newPacket } from './xmp/writeXmp.ts';
import { parseXmpDate, xmpDateString } from './xmp/xmpDate.ts';

export interface MetadataInput {
  /** Info Title and dc:title; left out, the document's value is kept, taken from the authoritative side where Info and XMP disagree; null removes it. */
  title?: string | null;
  /** Info Author and dc:creator, written as one creator. */
  author?: string | null;
  /** Info Subject and dc:description. */
  subject?: string | null;
  /** Info Keywords and pdf:Keywords. */
  keywords?: string | null;
  /** Info Creator and xmp:CreatorTool. */
  creator?: string | null;
  /** Info Producer and pdf:Producer. */
  producer?: string | null;
  /** Info CreationDate and xmp:CreateDate. */
  creationDate?: PdfDate | null;
  /** Info ModDate, xmp:ModifyDate and xmp:MetadataDate, which are never read from a clock. */
  modificationDate: PdfDate;
  /** Info Trapped and pdf:Trapped; Unknown has no XMP form, since pdf:Trapped is Boolean (XMP Part 2 3.1). */
  trapped?: 'True' | 'False' | 'Unknown' | null;
}

export interface SetMetadataOptions {
  /** 'keep' (the default) keeps the packet's xmpMM:DocumentID, else derives it from the first file identifier; a value is written as given. */
  documentId?: 'keep' | { readonly value: string };
  /** 'remove' (the default) requires the next save to rewrite the file, so that it holds one document packet; 'keep' allows an incremental update that leaves earlier packets in earlier revisions. */
  revisions?: 'remove' | 'keep';
  /** 'refuse' (the default) throws for a packet that cannot be read or edited; 'replace' writes a new packet and discards the old content. */
  unreadableXmp?: 'refuse' | 'replace';
}

/** A key whose Info and XMP values differed and whose value was taken from one side. */
export interface ReconciledValue {
  readonly key: MappedKey;
  readonly from: 'info' | 'xmp';
  readonly discarded: string;
}

export interface MetadataChange {
  readonly reconciled: readonly ReconciledValue[];
  /** Legacy properties removed from the packet, as their conventional prefix and name. */
  readonly removedLegacy: readonly string[];
  /** Metadata objects nothing reachable from the trailer referenced, which were deleted. */
  readonly deletedOrphans: readonly PdfReference[];
  readonly documentId: string;
  /** The xmpMM:InstanceID a save of the document as it is now writes; an edit made before saving, or a catalog Version the save raises, changes what the save writes. */
  readonly instanceId: string;
  readonly saveMode: 'full-required' | 'any';
  /** With revisions 'keep', how many packets an incremental update leaves in earlier revisions or in deleted objects; undefined when a full rewrite removes them. */
  readonly supersededPackets: number | undefined;
}

interface ResolvedValues {
  readonly title: string | undefined;
  readonly author: string | undefined;
  readonly subject: string | undefined;
  readonly keywords: string | undefined;
  readonly creator: string | undefined;
  readonly producer: string | undefined;
  readonly creationDate: PdfDate | undefined;
  readonly trapped: 'True' | 'False' | 'Unknown' | undefined;
}

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const INFO = pdfName('Info').bytes;
const METADATA = pdfName('Metadata').bytes;
const TYPE = pdfName('Type').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
// ISO 32000-1:2008, Table 5: these entries describe how a stream's data is encoded or where it is kept, and the new packet is written unfiltered in the file.
const STREAM_DATA_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms']);

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

interface Sides<T> {
  readonly info: T | undefined;
  readonly xmp: T | undefined;
}

const trappedName = (value: string | undefined): ResolvedValues['trapped'] =>
  value === 'True' || value === 'False' || value === 'Unknown' ? value : undefined;

class Resolver {
  readonly reconciled: ReconciledValue[] = [];
  private readonly mapping: MetadataMapping;

  constructor(mapping: MetadataMapping) {
    this.mapping = mapping;
  }

  private row(key: MappedKey): MappedProperty | undefined {
    return this.mapping.properties.find(property => property.key === key);
  }

  // Where both sides have a value and they disagree, ISO 32000-1:2008, 14.3.2 decides; where it cannot, Info wins, as XMP Part 3 2.1 prefers the native form when the most recent cannot be determined.
  private pick<T>(key: MappedKey, sides: Sides<T>, shown: (value: T) => string): T | undefined {
    const row = this.row(key);
    const { info, xmp } = sides;
    if (info === undefined || xmp === undefined || row?.agreement === 'agree') return info ?? xmp;
    const from = this.mapping.authority === 'xmp' ? 'xmp' : 'info';
    this.reconciled.push({ key, from, discarded: shown(from === 'xmp' ? info : xmp) });
    return from === 'xmp' ? xmp : info;
  }

  text(key: MappedKey, input: string | null | undefined): string | undefined {
    if (input !== undefined) return input ?? undefined;
    const row = this.row(key);
    const xmp = row?.xmp === undefined ? undefined : comparableText(row.xmp);
    return this.pick(key, { info: row?.info, xmp }, value => value);
  }

  trapped(input: MetadataInput['trapped']): ResolvedValues['trapped'] {
    if (input !== undefined) return input ?? undefined;
    const row = this.row('Trapped');
    return this.pick(
      'Trapped',
      { info: trappedName(row?.info), xmp: trappedName(row?.xmp === undefined ? undefined : comparableText(row.xmp)) },
      value => value,
    );
  }

  creationDate(input: PdfDate | null | undefined): PdfDate | undefined {
    if (input !== undefined) return input ?? undefined;
    const row = this.row('CreationDate');
    const infoDate = row?.info === undefined ? undefined : parsePdfDate(row.info)?.date;
    const xmpText = row?.xmp === undefined ? undefined : comparableText(row.xmp);
    const xmpDate = xmpText === undefined ? undefined : parseXmpDate(xmpText);
    // An XMP time without a time zone designator names no instant (XMP Part 1 8.2.1.2), so it cannot become a PDF date.
    const usable = xmpDate !== undefined && (xmpDate.zone === 'explicit' || ['year', 'month', 'day'].includes(xmpDate.precision)) ? xmpDate.date : undefined;
    return this.pick('CreationDate', { info: infoDate, xmp: usable }, value => (value === infoDate ? (row?.info ?? '') : (xmpText ?? '')));
  }
}

interface ResolvedInput {
  readonly values: ResolvedValues;
  readonly reconciled: readonly ReconciledValue[];
}

const resolveValues = (state: MetadataState, input: MetadataInput): ResolvedInput => {
  const resolver = new Resolver(state.mapping);
  const values: ResolvedValues = {
    title: resolver.text('Title', input.title),
    author: resolver.text('Author', input.author),
    subject: resolver.text('Subject', input.subject),
    keywords: resolver.text('Keywords', input.keywords),
    creator: resolver.text('Creator', input.creator),
    producer: resolver.text('Producer', input.producer),
    creationDate: resolver.creationDate(input.creationDate),
    trapped: resolver.trapped(input.trapped),
  };
  return { values, reconciled: resolver.reconciled };
};

// An identifier may be written as text or, as XMP Part 1 7.5 allows for a URI simple value, as rdf:resource.
const packetText = (packet: ReadPacket | undefined, name: string): string | undefined => {
  const value = packet?.properties.find(property => property.namespace === XMP_MM_NAMESPACE && property.localName === name)?.value;
  if (value?.kind === 'uri') return value.uri;
  return value?.kind === 'text' ? value.text : undefined;
};

interface Identifiers {
  readonly documentId: string;
  readonly instanceId: string;
}

const managedValues = (values: ResolvedValues, input: MetadataInput, identifiers: Identifiers): ManagedValues => ({
  title: values.title,
  author: values.author,
  subject: values.subject,
  keywords: values.keywords,
  creator: values.creator,
  producer: values.producer,
  trapped: values.trapped === 'Unknown' ? undefined : values.trapped,
  createDate: values.creationDate === undefined ? undefined : xmpDateString(values.creationDate),
  modifyDate: xmpDateString(input.modificationDate),
  metadataDate: xmpDateString(input.modificationDate),
  documentId: identifiers.documentId,
  instanceId: identifiers.instanceId,
});

// ISO 32000-1:2008, 14.3.3: unmanaged keys stay; each managed key gets the resolved value or, with none, is removed, since "Any entry whose value is not known should be omitted".
const infoDictionary = (existing: PdfDictionaryEntries | undefined, values: ResolvedValues, input: MetadataInput): PdfDictionaryEntries => {
  const entries = new PdfDictionaryEntries(existing === undefined ? [] : [...existing.entries()]);
  const texts = [
    ['Title', values.title],
    ['Author', values.author],
    ['Subject', values.subject],
    ['Keywords', values.keywords],
    ['Creator', values.creator],
    ['Producer', values.producer],
  ] as const;
  const set = (key: string, value: PdfDirectObject | undefined): void => {
    if (value === undefined) entries.delete(pdfName(key).bytes);
    else entries.set(pdfName(key).bytes, value);
  };
  for (const [key, value] of texts) set(key, value === undefined ? undefined : pdfTextString(value));
  set('CreationDate', values.creationDate === undefined ? undefined : pdfDateObject(values.creationDate));
  set('ModDate', pdfDateObject(input.modificationDate));
  set('Trapped', values.trapped === undefined ? undefined : pdfName(values.trapped));
  return entries;
};

const streamDictionary = (existing: PdfStream | undefined): PdfDictionaryEntries => {
  const entries = new PdfDictionaryEntries(
    existing === undefined ? [] : [...existing.dictionary.entries()].filter(([key]) => !STREAM_DATA_KEYS.has(latin1(key))),
  );
  // ISO 32000-1:2008, Table 315: Type "shall be Metadata for a metadata stream", and Subtype "shall be XML".
  entries.set(TYPE, pdfName('Metadata'));
  entries.set(SUBTYPE, pdfName('XML'));
  return entries;
};

interface WrittenPacket {
  readonly bytes: Uint8Array;
  readonly removedLegacy: readonly string[];
}

type PacketWriter = (values: ManagedValues) => WrittenPacket;

const writeNew: PacketWriter = values => ({ bytes: newPacket(values), removedLegacy: [] });

// The packet is spliced when it can be read; one that cannot be read, or whose edit does not read back, is replaced only when the caller allows it.
const packetWriter = (xmp: DocumentPacket | undefined, options: SetMetadataOptions, sample: ManagedValues): PacketWriter => {
  if (xmp === undefined || (xmp.stream === undefined && !('packet' in xmp))) {
    writeNew(sample);
    return writeNew;
  }
  const replace = options.unreadableXmp === 'replace';
  if (!('packet' in xmp)) {
    if (replace) {
      writeNew(sample);
      return writeNew;
    }
    throw new ValidationError(`the document packet cannot be read (${xmp.unreadable}); pass unreadableXmp 'replace' to discard it`, 'xmp-unreadable');
  }
  const { packet } = xmp;
  const splice: PacketWriter = values => splicePacket(packet, values);
  try {
    splice(sample);
    return splice;
  } catch (error: unknown) {
    if (!(error instanceof ValidationError) || error.reason !== 'xmp-unreadable' || !replace) throw error;
    writeNew(sample);
    return writeNew;
  }
};

// The packet keeps its object number when the catalog names a stream no component also uses; otherwise it becomes a new object (ISO 32000-1:2008, Table 316 lets any stream or dictionary have metadata, and a component's packet stays its own).
const packetTarget = (state: MetadataState, components: readonly ComponentPacket[]): PdfReference | undefined => {
  const { xmp } = state;
  if (xmp?.stream === undefined) return undefined;
  return components.some(component => component.reference.objectNumber === xmp.reference.objectNumber) ? undefined : xmp.reference;
};

// Any InstanceID of the derived form serves to check that the values can be written; the real one is derived when the document is saved.
const SAMPLE_INSTANCE_ID = 'uuid:00000000-0000-0000-0000-000000000000';

const previousInstanceIds = new WeakMap<EditedObjects, string | undefined>();

interface Placement {
  readonly packet: PdfReference;
  readonly info: PdfReference;
  readonly dictionary: PdfDictionaryEntries;
}

// ISO 32000-1:2008, Table 15, Info, and Table 28, Metadata: both "shall be an indirect reference", so a direct Info becomes an object and the trailer names it.
interface Plan {
  readonly info: PdfDictionaryEntries;
  /** The existing stream the packet replaces in place, or undefined for a new object. */
  readonly target: PdfReference | undefined;
}

const placeObjects = (document: DocumentInternals, state: MetadataState, plan: Plan): Placement => {
  const { info, target } = plan;
  const { objects } = document;
  let infoReference = state.info?.reference;
  if (infoReference === undefined) {
    infoReference = objects.add({ kind: 'dictionary', entries: info });
    objects.setTrailerEntry(INFO, infoReference);
  } else objects.set(infoReference, { kind: 'dictionary', entries: info });
  const dictionary = streamDictionary(target === undefined ? undefined : state.xmp?.stream);
  let packet = target;
  if (packet === undefined) {
    const { catalog } = state;
    if (catalog === undefined) throw new InvalidArgumentError('the document catalog is not a dictionary');
    packet = objects.add({ kind: 'stream', dictionary, data: new Uint8Array() });
    const entries = new PdfDictionaryEntries([...catalog.entries.entries()]);
    entries.set(METADATA, packet);
    objects.set(catalog.reference, { kind: 'dictionary', entries });
  }
  return { packet, info: infoReference, dictionary };
};

const deleteOrphans = (document: DocumentInternals): PdfReference[] => {
  const orphans = new MetadataReader(document).orphans(reachableObjects(document).objects);
  for (const orphan of orphans) document.objects.delete(orphan);
  return orphans;
};

interface Graph {
  readonly reachable: ReadonlyMap<number, number>;
  readonly components: readonly ComponentPacket[];
  readonly target: PdfReference | undefined;
}

const supersededCount = (document: DocumentInternals, state: MetadataState, graph: Graph): number => {
  const { reader, xmp } = state;
  const { components, target } = graph;
  const orphans = reader.orphans(graph.reachable);
  const scanned = scanPackets(document, {
    document: xmp?.reference.objectNumber,
    components: new Set(components.map(component => component.reference.objectNumber)),
    orphans: new Set(orphans.map(orphan => orphan.objectNumber)),
  });
  // The document packet is superseded when it is replaced in place; a new object leaves the old one to the component that shares it. Deleted orphans stay in the earlier revision.
  return scanned.superseded + (target === undefined ? 0 : scanned.document) + scanned.orphans;
};

/**
 * Sets the document information dictionary and the document's XMP packet from one input, so that they agree (XMP Part 3 Table 20), and deletes orphaned metadata streams.
 * The packet replaces the catalog's metadata stream in place, splicing the managed properties into it and keeping every other byte; xmpMM:DocumentID is kept, and xmpMM:InstanceID is derived when the document is saved from the DocumentID, the metadata date, the previous InstanceID and everything else the save writes.
 * By default the next save must rewrite the file, so that it holds exactly one document packet; documents whose signatures a rewrite could invalidate are then refused (ValidationError signed-document).
 * Everything is validated before anything changes. The reachability walk parses every object reachable from the trailer, and a rewrite unpacks any object stream holding a changed object, such as a compressed catalog.
 */
const refuseSigned = (document: DocumentInternals, keep: boolean): void => {
  const protection = signatureProtection(document);
  if (keep || protection === undefined) return;
  const what = {
    'signatures-exist': 'signature fields',
    'append-only': 'AppendOnly signatures',
    permissions: 'a permissions dictionary',
    'unreadable-flags': 'signature flags that cannot be read',
  } as const satisfies Record<SignatureProtection, string>;
  throw new ValidationError(
    `the document has ${what[protection]} that a full rewrite could invalidate; pass revisions 'keep' to append an update`,
    'signed-document',
  );
};

// ISO 32000-1:2008, Table 15, ID: "If there is an Encrypt entry this array and the two byte-strings shall be direct objects"; otherwise either may be a reference. One that cannot be read gives no identifier.
const fileIdentifierOf = (document: DocumentInternals): Uint8Array | undefined => {
  const { objects } = document;
  try {
    const trailerId = objects.deref(document.structure.trailer.get(pdfName('ID').bytes));
    const first = trailerId?.kind === 'array' ? objects.deref(trailerId.items[0]) : undefined;
    return first?.kind === 'string' ? first.bytes : undefined;
  } catch (error: unknown) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
};

const documentIdOf = (document: DocumentInternals, packet: ReadPacket | undefined, option: SetMetadataOptions['documentId']): string =>
  resolveDocumentId({
    existing: option === undefined || option === 'keep' ? packetText(packet, 'DocumentID') : undefined,
    fileIdentifier: fileIdentifierOf(document),
    supplied: typeof option === 'object' ? option.value : undefined,
  });

interface ProducedPacket {
  readonly value: PdfStream;
  readonly instanceId: string;
  readonly removedLegacy: readonly string[];
}

interface Prepared {
  readonly state: MetadataState;
  readonly resolved: ResolvedInput;
  readonly documentId: string;
  readonly previous: string | undefined;
  readonly write: PacketWriter;
  readonly plan: Plan;
  readonly graph: Graph;
}

// Everything is read, resolved and checked, and the packet and Info built, before anything changes.
const prepare = (document: DocumentInternals, input: MetadataInput, options: SetMetadataOptions): Prepared => {
  refuseSigned(document, options.revisions === 'keep');
  const state = readMetadataState(document);
  const resolved = resolveValues(state, input);
  const packet = state.xmp !== undefined && 'packet' in state.xmp ? state.xmp.packet : undefined;
  const { objects } = document;
  const previous = previousInstanceIds.has(objects) ? previousInstanceIds.get(objects) : packetText(packet, 'InstanceID');
  const documentId = documentIdOf(document, packet, options.documentId);
  const write = packetWriter(state.xmp, options, managedValues(resolved.values, input, { documentId, instanceId: SAMPLE_INSTANCE_ID }));
  const info = infoDictionary(state.info?.entries, resolved.values, input);
  const reachable = reachableObjects(document).objects;
  const components = state.reader.components(reachable, state.catalog?.reference.objectNumber);
  const target = packetTarget(state, components);
  return { state, resolved, documentId, previous, write, plan: { info, target }, graph: { reachable, components, target } };
};

/**
 * Sets the document information dictionary and the document's XMP packet from one input, so that they agree (XMP Part 3 Table 20), and deletes orphaned metadata streams.
 * The packet replaces the catalog's metadata stream in place, splicing the managed properties into it and keeping every other byte; xmpMM:DocumentID is kept, and xmpMM:InstanceID is derived when the document is saved from the DocumentID, the metadata date, the previous InstanceID and everything else the save writes.
 * By default the next save must rewrite the file, so that it holds exactly one document packet; documents whose signatures a rewrite could invalidate are then refused (ValidationError signed-document).
 * Everything is validated before anything changes. The reachability walk parses every object reachable from the trailer, and a rewrite unpacks any object stream holding a changed object, such as a compressed catalog.
 */
export const setMetadata = (document: LoadedDocument, input: MetadataInput, options: SetMetadataOptions = {}): MetadataChange => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new InvalidArgumentError('setMetadata needs a document from loadDocument');
  const keep = options.revisions === 'keep';
  const { state, resolved, documentId, previous, write, plan, graph } = prepare(internals, input, options);
  const supersededPackets = keep ? supersededCount(internals, state, graph) : undefined;
  const { objects } = internals;
  const placement = placeObjects(internals, state, plan);
  const deletedOrphans = deleteOrphans(internals);
  if (!keep) objects.requireFullRewrite('metadata-history');
  previousInstanceIds.set(objects, previous);
  const excluded = new Set([placement.packet.objectNumber, placement.info.objectNumber]);
  const metadataDate = xmpDateString(input.modificationDate);
  const produce = (changes: ReadonlyMap<number, ObjectChange>): ProducedPacket => {
    const instanceId = deriveInstanceId({ documentId, metadataDate, previous, changes: changesDigest(changes, excluded) });
    const written = write(managedValues(resolved.values, input, { documentId, instanceId }));
    return { value: { kind: 'stream', dictionary: placement.dictionary, data: written.bytes }, instanceId, removedLegacy: written.removedLegacy };
  };
  const current = produce(objects.changes);
  objects.set(placement.packet, current.value);
  objects.setSaveHook(changes => {
    changes.set(placement.packet.objectNumber, { generation: placement.packet.generation, value: produce(changes).value });
  });
  return {
    reconciled: resolved.reconciled,
    removedLegacy: current.removedLegacy,
    deletedOrphans,
    documentId,
    instanceId: current.instanceId,
    saveMode: keep ? 'any' : 'full-required',
    supersededPackets,
  };
};
