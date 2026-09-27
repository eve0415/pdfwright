import type { DocumentInternals } from '../document/documentInternals.ts';
import type { EditedObjects, ObjectChange } from '../document/editedObjects.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { MetadataFinding } from './metadataFinding.ts';
import type { ComponentPacket, DocumentPacket, MetadataState } from './readMetadata.ts';
import type { MetadataInput, ReconciledValue, ResolvedInput } from './resolveMetadata.ts';
import type { SignatureProtection } from './signatures.ts';
import type { ReadPacket } from './xmp/readXmp.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ValidationError } from '../error/validationError.ts';
import { createMd5 } from '../hash/md5.ts';
import { DEFAULT_FRACTION_DIGITS } from '../number/formatNumber.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';
import { changedObjectBytes } from '../save/mergeSerialize.ts';

import { changesDigest, deriveInstanceId, resolveDocumentId } from './identifiers.ts';
import { XMP_MM_NAMESPACE } from './mapping.ts';
import { scanPackets } from './packetScan.ts';
import { MetadataReader, readMetadataState } from './readMetadata.ts';
import { infoDictionary, managedValues, resolveValues } from './resolveMetadata.ts';
import { signatureProtection } from './signatures.ts';
import { splicePacket } from './xmp/splicePacket.ts';
import { newPacket } from './xmp/writeXmp.ts';
import { xmpDateString } from './xmp/xmpDate.ts';

export interface SetMetadataOptions {
  /** 'keep' (the default) keeps the packet's xmpMM:DocumentID, else derives it from the first file identifier; a value is written as given. */
  documentId?: 'keep' | { readonly value: string };
  /** 'remove' (the default) requires the next save to rewrite the file, so that it holds one document packet; 'keep' allows an incremental update that leaves earlier packets in earlier revisions. */
  revisions?: 'remove' | 'keep';
  /** 'refuse' (the default) throws for a packet that cannot be read or edited; 'replace' writes a new packet and discards the old content. */
  unreadableXmp?: 'refuse' | 'replace';
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
  /** What the edit did that a caller may need to know beyond the values: a direct Info dictionary made indirect, a packet re-encoded as UTF-8, values it left as they were stored. */
  readonly findings: readonly MetadataFinding[];
}

type PdfStream = Extract<PdfObject, { kind: 'stream' }>;

const INFO = pdfName('Info').bytes;
const METADATA = pdfName('Metadata').bytes;
const TYPE = pdfName('Type').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
// ISO 32000-1:2008, Table 5: these entries describe how a stream's data is encoded or where it is kept, and the new packet is written unfiltered in the file.
const STREAM_DATA_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms']);

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

// An identifier may be written as text or, as XMP Part 1 7.5 allows for a URI simple value, as rdf:resource.
const packetText = (packet: ReadPacket | undefined, name: string): string | undefined => {
  const value = packet?.properties.find(property => property.namespace === XMP_MM_NAMESPACE && property.localName === name)?.value;
  if (value?.kind === 'uri') return value.uri;
  return value?.kind === 'text' ? value.text : undefined;
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
  readonly transcoded: boolean;
}

type PacketWriter = (values: ManagedValues) => WrittenPacket;

const writeNew: PacketWriter = values => ({ bytes: newPacket(values), removedLegacy: [], transcoded: false });

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
  readonly written: WrittenPacket;
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
  // Every edit is made on a fork of the document's edits, and adopted only once all of them, and the packet, have been made without an error.
  const objects = internals.objects.fork();
  const staged: DocumentInternals = { ...internals, objects };
  const placement = placeObjects(staged, state, plan);
  const deletedOrphans = deleteOrphans(staged);
  if (!keep) objects.requireFullRewrite('metadata-history');
  const excluded = new Set([placement.packet.objectNumber]);
  const metadataDate = xmpDateString(input.modificationDate);
  // The digest covers every other object the save writes, the Info dictionary included, and the packet as written with a placeholder of the InstanceID's fixed width, so that edits setting different values get different InstanceIDs.
  const produce = (changes: ReadonlyMap<number, ObjectChange>, fractionDigits: number): ProducedPacket => {
    const serializeOptions = { store: objects.store, maxNesting: internals.maxNesting, fractionDigits };
    const serialize = ({ objectNumber, value }: { readonly objectNumber: number; readonly value: PdfObject }): Uint8Array =>
      changedObjectBytes(objectNumber, value, serializeOptions);
    const draft = write(managedValues(resolved.values, input, { documentId, instanceId: SAMPLE_INSTANCE_ID }));
    const digest = createMd5()
      .update(changesDigest(changes, excluded, serialize))
      .update(draft.bytes)
      .digest();
    const instanceId = deriveInstanceId({ documentId, metadataDate, previous, changes: digest });
    const written = write(managedValues(resolved.values, input, { documentId, instanceId }));
    return { value: { kind: 'stream', dictionary: placement.dictionary, data: written.bytes }, instanceId, written };
  };
  const current = produce(objects.changes, DEFAULT_FRACTION_DIGITS);
  objects.set(placement.packet, current.value);
  objects.setSaveHook((changes, context) => {
    changes.set(placement.packet.objectNumber, { generation: placement.packet.generation, value: produce(changes, context.fractionDigits).value });
  });
  const findings: MetadataFinding[] = [];
  // ISO 32000-1:2008, Table 15, Info: "(Optional; shall be an indirect reference)".
  if (state.info !== undefined && state.info.reference === undefined) {
    findings.push({ code: 'info-not-indirect', detail: 'the direct document information dictionary was replaced by an indirect one' });
  }
  // XMP Part 3 1.6.1: "The XMP must be encoded as UTF-8".
  if (current.written.transcoded) findings.push({ code: 'xmp-transcoded', detail: 'the packet was re-encoded as UTF-8' });
  internals.objects.adopt(objects);
  previousInstanceIds.set(internals.objects, previous);
  return {
    reconciled: resolved.reconciled,
    removedLegacy: current.written.removedLegacy,
    deletedOrphans,
    documentId,
    instanceId: current.instanceId,
    saveMode: keep ? 'any' : 'full-required',
    supersededPackets,
    findings,
  };
};
