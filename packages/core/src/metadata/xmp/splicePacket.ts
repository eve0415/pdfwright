import type { MappedKey } from '../mapping.ts';
import type { ReadPacket, XmpValue } from './readXmp.ts';
import type { ManagedValues } from './writeXmp.ts';

import { ValidationError } from '../../error/validationError.ts';
import { MAPPED_ROWS, PDFX_ID_NAMESPACE, XMP_MM_NAMESPACE, XMP_NAMESPACE } from '../mapping.ts';

import { readXmp } from './readXmp.ts';
import { managedDescription } from './writeXmp.ts';
import { DEFAULT_XML_LIMITS } from './xmlTokenizer.ts';

export interface SplicedPacket {
  readonly bytes: Uint8Array;
  /** The legacy properties removed, as their conventional prefix and name. */
  readonly removedLegacy: readonly string[];
  /** Whether the packet was in an encoding other than UTF-8 and was re-encoded. */
  readonly transcoded: boolean;
}

const key = (namespace: string, name: string): string => `${namespace}\n${name}`;

// XML 1.0, 2.8, production [23] XMLDecl, and 4.3.3, productions [80] EncodingDecl and [81] EncName: the encoding pseudo-attribute of an XML declaration at the start of the text.
const ENCODING_DECLARATION = /^(<\?xml[ \t\r\n][^?]*?[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*)(["'])[A-Za-z][\w.-]*\2/u;

const textValue = (value: string | undefined): XmpValue | undefined => (value === undefined ? undefined : { kind: 'text', text: value, language: undefined });

const arrayValue = (type: 'Alt' | 'Seq', value: string | undefined): XmpValue | undefined =>
  value === undefined ? undefined : { kind: 'array', type, items: [{ text: value, language: type === 'Alt' ? 'x-default' : undefined }] };

const sameValue = (left: XmpValue, right: XmpValue): boolean => {
  if (left.kind === 'text' && right.kind === 'text') return left.text === right.text && left.language === right.language;
  if (left.kind === 'uri' && right.kind === 'uri') return left.uri === right.uri;
  if (left.kind === 'opaque' || right.kind === 'opaque') return left.kind === right.kind;
  if (left.kind !== 'array' || right.kind !== 'array' || left.type !== right.type || left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => {
    const other = right.items[index];
    return other !== undefined && item.text === other.text && item.language === other.language;
  });
};

/** Each managed property's key with the value the new rdf:Description gives it, or the value a kept property already has. */
const expectedValues = (packet: ReadPacket, values: ManagedValues, kept: ReadonlySet<MappedKey>): ReadonlyMap<string, XmpValue | undefined> => {
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
  const value = (row: (typeof MAPPED_ROWS)[number]): XmpValue | undefined =>
    kept.has(row.key) ? packet.properties.find(property => property.namespace === row.namespace && property.localName === row.name)?.value : byKey[row.key];
  const expected = new Map([
    ...MAPPED_ROWS.map(row => [key(row.namespace, row.name), value(row)] as const),
    [key(XMP_NAMESPACE, 'MetadataDate'), textValue(values.metadataDate)],
    [key(XMP_MM_NAMESPACE, 'DocumentID'), textValue(values.documentId)],
    [key(XMP_MM_NAMESPACE, 'InstanceID'), textValue(values.instanceId)],
  ]);
  if (values.pdfxVersion !== undefined) {
    expected.set(key(XMP_MM_NAMESPACE, 'VersionID'), textValue(values.versionId));
    expected.set(key(XMP_MM_NAMESPACE, 'RenditionClass'), textValue(values.renditionClass));
    expected.set(key(PDFX_ID_NAMESPACE, 'GTS_PDFXVersion'), textValue(values.pdfxVersion));
  }
  return expected;
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
const readsBack = (bytes: Uint8Array, expected: ReadonlyMap<string, XmpValue | undefined>, maxTokens: number): boolean => {
  const read = readXmp(bytes, maxTokens);
  if (!read.ok) return false;
  // Each occurrence is appended in place, so that a packet repeating one name many times is still checked in linear time.
  const found = new Map<string, XmpValue[]>();
  for (const property of read.packet.properties) {
    const name = key(property.namespace, property.localName);
    const occurrences = found.get(name);
    if (occurrences === undefined) found.set(name, [property.value]);
    else occurrences.push(property.value);
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
 * The properties of the `kept` keys, which the values leave out, stay as they are.
 * Every other byte of the packet is copied unchanged: other properties and namespaces, the wrapper, x:xmpmeta and its attributes, comments and padding.
 * The new element takes the packet's subject as rdf:about (XMP Part 1 7.4), declares rdf itself, and resets xml:lang when an enclosing element sets one.
 * Throws ValidationError xmp-unreadable when the result does not read back with exactly the managed values.
 */
export const splicePacket = (
  packet: ReadPacket,
  values: ManagedValues,
  options: { readonly kept?: ReadonlySet<MappedKey>; readonly maxTokens?: number } = {},
): SplicedPacket => {
  const kept = options.kept ?? new Set<MappedKey>();
  const maxTokens = options.maxTokens ?? DEFAULT_XML_LIMITS.maxTokens;
  const expected = expectedValues(packet, values, kept);
  const keptNames = new Set(MAPPED_ROWS.filter(row => kept.has(row.key)).map(row => key(row.namespace, row.name)));
  const removed = packet.properties
    .filter(property => {
      const name = key(property.namespace, property.localName);
      return (expected.has(name) && !keptNames.has(name)) || LEGACY.has(name);
    })
    .toSorted((left, right) => left.textSpan.start - right.textSpan.start);
  const text =
    packet.packetEnd !== undefined && packet.findings.some(finding => finding.code === 'extra-xmp-packet')
      ? packet.text.slice(0, packet.packetEnd)
      : packet.text;
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
  // An rdf:RDF written as an empty-element tag becomes a start tag and an end tag around the new element (XML 1.0, 3.1).
  const empty = packet.rdfEmptyTag;
  result +=
    empty === undefined
      ? `${text.slice(from, packet.rdfEnd)}${description}\n${text.slice(packet.rdfEnd)}`
      : `${text.slice(from, packet.rdfEnd)}>${description}\n</${empty}>${text.slice(packet.rdfEnd + 2)}`;
  const transcoded = packet.encoding !== 'utf8';
  if (transcoded) {
    // The byte-order mark of a UTF-16 or UTF-32 packet has no purpose in UTF-8, where XMP Part 1 7.1 does not recommend one.
    if (result.startsWith('\u{FEFF}')) result = result.slice(1);
    // XML 1.0, 4.3.3: "it is a fatal error for an entity including an encoding declaration to be presented to the XML processor in an encoding other than that named in the declaration".
    result = result.replace(ENCODING_DECLARATION, '$1$2UTF-8$2');
  }
  const bytes = new TextEncoder().encode(result);
  if (!readsBack(bytes, expected, maxTokens)) {
    throw new ValidationError('the edited packet does not read back with the values written into it', 'xmp-unreadable');
  }
  const removedLegacy = removed.flatMap(property => LEGACY.get(key(property.namespace, property.localName)) ?? []);
  return { bytes, removedLegacy, transcoded };
};
