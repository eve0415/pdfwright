import type { DocumentInternals } from '../document/documentInternals.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { decodeStream } from '../filter/decodeStream.ts';
import { pdfName } from '../object/pdfObject.ts';
import { IN_FILE } from '../xref/objectIndex.ts';

/** The objects that hold metadata packets, by object number. */
export interface PacketRoles {
  /** The stream the catalog's Metadata entry names. */
  readonly document: number | undefined;
  /** Metadata streams reached through another object's Metadata entry. */
  readonly components: ReadonlySet<number>;
  /** Metadata streams in use that nothing reachable from the trailer references. */
  readonly orphans: ReadonlySet<number>;
}

/** How many packet headers a byte scan finds, by where each lies. */
export interface ScannedPackets {
  readonly document: number;
  readonly components: number;
  readonly orphans: number;
  /** In no object the current cross-reference data gives, such as an earlier revision of an object an update replaced. */
  readonly superseded: number;
  /** In other objects, such as the XMP a JPEG image carries in its own data. */
  readonly insideOtherStreams: number;
}

// XMP Part 1 7.3.2, Figure 6: the header processing instruction starts with <?xpacket begin=.
const HEADER: readonly number[] = [...new TextEncoder().encode('<?xpacket begin=')];
const FILTER = pdfName('Filter').bytes;

const ignore = (): void => {
  // Warnings from decoding a packet do not change how many headers it holds.
};

const count = (bytes: Uint8Array): number => {
  let found = 0;
  for (let at = bytes.indexOf(HEADER[0] ?? 0); at !== -1; at = bytes.indexOf(HEADER[0] ?? 0, at + 1)) {
    if (HEADER.every((byte, offset) => bytes[at + offset] === byte)) found++;
  }
  return found;
};

type Role = 'document' | 'components' | 'orphans' | 'insideOtherStreams';

const roleOf = (objectNumber: number, roles: PacketRoles): Role => {
  if (objectNumber === roles.document) return 'document';
  if (roles.components.has(objectNumber)) return 'components';
  return roles.orphans.has(objectNumber) ? 'orphans' : 'insideOtherStreams';
};

// A filtered metadata stream's packet is found in its decoded data, where a reader looks for it; undefined when the stream is not filtered or cannot be decoded.
const decodedCount = (document: DocumentInternals, objectNumber: number): number | undefined => {
  const generation = document.objects.generationOf(objectNumber);
  if (generation === undefined) return undefined;
  try {
    const value = document.objects.resolve(objectNumber, generation);
    if (value.kind !== 'stream' || !value.dictionary.has(FILTER)) return undefined;
    return count(decodeStream(value, { maxDecodedBytes: document.maxDecodedBytes, warn: ignore, deref: item => document.objects.deref(item) }));
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof UnsupportedFeatureError || error instanceof ResourceLimitError) return 0;
    throw error;
  }
};

interface Extent {
  readonly objectNumber: number;
  readonly start: number;
}

const inFileObjects = (document: DocumentInternals): Extent[] => {
  const { index } = document.objects.store;
  const extents: Extent[] = [];
  for (const objectNumber of index.inUse()) {
    const entry = index.get(objectNumber);
    if (entry.type === IN_FILE) extents.push({ objectNumber, start: entry.location });
  }
  return extents.toSorted((left, right) => left.start - right.start);
};

// Where an object's bytes end: after endobj when it parses, else where the next object in the file starts.
const objectEnd = (document: DocumentInternals, extent: Extent, next: Extent | undefined): number | undefined => {
  try {
    const object = document.objects.store.load(extent.objectNumber);
    if (object?.source.kind === 'file') return object.source.objectEnd;
  } catch (error: unknown) {
    if (!(error instanceof ParseError)) throw error;
  }
  return next?.start ?? document.objects.store.source.length;
};

/**
 * Counts the packet headers a byte scan of the source finds, as a tool that does not parse PDF would, and attributes each to the object whose bytes hold it.
 * Filtered metadata streams are counted by their decoded data instead, since their packets are invisible to a byte scan.
 */
export const scanPackets = (document: DocumentInternals, roles: PacketRoles): ScannedPackets => {
  const counts = { document: 0, components: 0, orphans: 0, superseded: 0, insideOtherStreams: 0 };
  const decoded = new Map<number, number | undefined>();
  for (const objectNumber of [roles.document, ...roles.components, ...roles.orphans]) {
    if (objectNumber === undefined) continue;
    const found = decodedCount(document, objectNumber);
    decoded.set(objectNumber, found);
    if (found !== undefined) counts[roleOf(objectNumber, roles)] += found;
  }
  const { store } = document.objects;
  const extents = inFileObjects(document);
  for (const hit of store.source.indexesOf(HEADER)) {
    let low = -1;
    for (let high = extents.length - 1; low < high;) {
      const middle = Math.ceil((low + high) / 2);
      if ((extents[middle]?.start ?? 0) <= hit) low = middle;
      else high = middle - 1;
    }
    const extent = extents[low];
    const end = extent === undefined ? undefined : objectEnd(document, extent, extents[low + 1]);
    if (extent === undefined || end === undefined || hit >= end) counts.superseded++;
    else if (decoded.get(extent.objectNumber) === undefined) counts[roleOf(extent.objectNumber, roles)]++;
  }
  return counts;
};
