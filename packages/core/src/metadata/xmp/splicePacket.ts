import type { MappedKey } from '../mapping.ts';
import type { ReadPacket, XmpValue } from './readXmp.ts';
import type { ManagedValues } from './writeXmp.ts';

import { ValidationError } from '../../error/validationError.ts';
import { MAPPED_ROWS, XMP_MM_NAMESPACE, XMP_NAMESPACE } from '../mapping.ts';

import { readXmp } from './readXmp.ts';
import { managedDescription } from './writeXmp.ts';

export interface SplicedPacket {
  readonly bytes: Uint8Array;
  /** The legacy properties removed, as their conventional prefix and name. */
  readonly removedLegacy: readonly string[];
  /** Whether the packet was in an encoding other than UTF-8 and was re-encoded. */
  readonly transcoded: boolean;
}

const key = (namespace: string, name: string): string => `${namespace}\n${name}`;

const textValue = (value: string | undefined): XmpValue | undefined => (value === undefined ? undefined : { kind: 'text', text: value, language: undefined });

const arrayValue = (type: 'Alt' | 'Seq', value: string | undefined): XmpValue | undefined =>
  value === undefined ? undefined : { kind: 'array', type, items: [{ text: value, language: type === 'Alt' ? 'x-default' : undefined }] };

const sameValue = (left: XmpValue, right: XmpValue): boolean => {
  if (left.kind === 'text' && right.kind === 'text') return left.text === right.text && left.language === right.language;
  if (left.kind !== 'array' || right.kind !== 'array' || left.type !== right.type || left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index];
    return other !== undefined && item.text === other.text && item.language === other.language;
  });
};

/** Each managed property's key with the value the new rdf:Description gives it. */
const expectedValues = (values: ManagedValues): ReadonlyMap<string, XmpValue | undefined> => {
  const byKey = {
    Title: arrayValue('Alt', values.title),
    Author: arrayValue('Seq', values.author),
    Subject: arrayValue('Alt', values.subject),
    Keywords: textValue(values.keywords),
    Creator: textValue(values.creator),
    Producer: textValue(values.producer),
    CreationDate: textValue(values.createDate),
    ModDate: textValue(values.modifyDate),
    Trapped: textValue(values.trapped),
  } as const satisfies Record<MappedKey, XmpValue | undefined>;
  return new Map([
    ...MAPPED_ROWS.map(row => [key(row.namespace, row.name), byKey[row.key]] as const),
    [key(XMP_NAMESPACE, 'MetadataDate'), textValue(values.metadataDate)],
    [key(XMP_MM_NAMESPACE, 'DocumentID'), textValue(values.documentId)],
    [key(XMP_MM_NAMESPACE, 'InstanceID'), textValue(values.instanceId)],
  ]);
};

const LEGACY: ReadonlyMap<string, string> = new Map(
  MAPPED_ROWS.flatMap(row => row.legacy.map(([namespace, prefix, name]) => [key(namespace, name), `${prefix}:${name}`] as const)),
);

// The white space before a property goes with it, so that removing an attribute leaves no gap and removing an element no blank line.
const withSpaceBefore = (text: string, start: number): number => {
  let at = start;
  while (at > 0 && ' \t\r\n'.includes(text[at - 1] ?? '')) at--;
  return at;
};

// A splice defect must not ship a packet that disagrees with Info, so the result is read back and each managed property compared with its value.
const readsBack = (bytes: Uint8Array, expected: ReadonlyMap<string, XmpValue | undefined>): boolean => {
  const read = readXmp(bytes);
  if (!read.ok) return false;
  const found = new Map<string, XmpValue[]>();
  for (const property of read.packet.properties) {
    const name = key(property.namespace, property.localName);
    found.set(name, [...(found.get(name) ?? []), property.value]);
  }
  if ([...LEGACY.keys()].some(name => found.has(name))) return false;
  return [...expected].every(([name, value]) => {
    const occurrences = found.get(name) ?? [];
    if (value === undefined) return occurrences.length === 0;
    const [only] = occurrences;
    return occurrences.length === 1 && only !== undefined && sameValue(only, value);
  });
};

/**
 * Replaces the managed properties of a readable packet: every managed and legacy property is removed wherever it occurs, as an element or an attribute of any top-level rdf:Description, and one new rdf:Description holding the managed values is inserted before the rdf:RDF end tag.
 * Every other byte of the packet is copied unchanged: other properties and namespaces, the wrapper, x:xmpmeta and its attributes, comments and padding.
 * The new element takes the packet's subject as rdf:about (XMP Part 1 7.4), declares rdf itself, and resets xml:lang when an enclosing element sets one.
 * Throws ValidationError xmp-unreadable when the result does not read back with exactly the managed values.
 */
export const splicePacket = (packet: ReadPacket, values: ManagedValues): SplicedPacket => {
  const expected = expectedValues(values);
  const removed = packet.properties
    .filter(property => expected.has(key(property.namespace, property.localName)) || LEGACY.has(key(property.namespace, property.localName)))
    .toSorted((left, right) => left.textSpan.start - right.textSpan.start);
  const { text } = packet;
  let result = '';
  let from = 0;
  for (const property of removed) {
    const start = withSpaceBefore(text, property.textSpan.start);
    if (start < from) continue;
    result += text.slice(from, start);
    from = property.textSpan.end;
  }
  const description = managedDescription(values, {
    about: packet.subject,
    declareRdf: true,
    resetLanguage: packet.rdfLanguage !== undefined && packet.rdfLanguage !== '',
  });
  result += `${text.slice(from, packet.rdfEnd)}${description}\n${text.slice(packet.rdfEnd)}`;
  const transcoded = packet.encoding !== 'utf8';
  // The byte-order mark of a UTF-16 or UTF-32 packet has no purpose in UTF-8, where XMP Part 1 7.1 does not recommend one.
  if (transcoded && result.startsWith('\u{FEFF}')) result = result.slice(1);
  const bytes = new TextEncoder().encode(result);
  if (!readsBack(bytes, expected)) throw new ValidationError('the edited packet does not read back with the values written into it', 'xmp-unreadable');
  const removedLegacy = removed.flatMap(property => LEGACY.get(key(property.namespace, property.localName)) ?? []);
  return { bytes, removedLegacy, transcoded };
};
