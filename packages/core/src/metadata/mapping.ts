import type { ParsedPdfDate } from '../date/pdfDate.ts';
import type { InfoValue } from './documentInfo.ts';
import type { MetadataFinding } from './metadataFinding.ts';
import type { XmpPacket, XmpProperty, XmpValue } from './xmp/readXmp.ts';
import type { XmpDate } from './xmp/xmpDate.ts';

import { parsePdfDate } from '../date/pdfDate.ts';

import { compareDates, instant, parseXmpDate } from './xmp/xmpDate.ts';

export const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
export const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/';
export const PDF_NAMESPACE = 'http://ns.adobe.com/pdf/1.3/';
export const XMP_MM_NAMESPACE = 'http://ns.adobe.com/xap/1.0/mm/';
export const PDFX_ID_NAMESPACE = 'http://www.npes.org/pdfx/ns/id/';

/** The document information keys XMP Part 3 Table 20 maps to XMP properties. */
export type MappedKey = 'Title' | 'Author' | 'Subject' | 'Keywords' | 'Creator' | 'Producer' | 'CreationDate' | 'ModDate' | 'Trapped';

export type Agreement = 'agree' | 'differ' | 'indeterminate' | 'info-only' | 'xmp-only' | 'absent';

export interface LegacyValue {
  /** The legacy property, as its conventional prefix and name. */
  readonly property: string;
  readonly value: XmpValue;
}

export interface MappedProperty {
  readonly key: MappedKey;
  /** The XMP property XMP Specification Part 3, Table 20 maps the key to, as its conventional prefix and name. */
  readonly property: string;
  /** The Info value as text, or undefined when it is absent, empty or not of the kind ISO 32000-1:2008, Table 317 requires. */
  readonly info: string | undefined;
  /** The value of the first occurrence of the XMP property, or undefined when it is absent or empty. */
  readonly xmp: XmpValue | undefined;
  /** Properties that XMP versions before Part 2 used for the same key, as the packet carries them. */
  readonly legacy: readonly LegacyValue[];
  readonly agreement: Agreement;
}

export interface MetadataMapping {
  readonly properties: readonly MappedProperty[];
  /** Which side ISO 32000-1:2008, 14.3.2 makes authoritative where they disagree. */
  readonly authority: 'xmp' | 'info' | 'indeterminate';
  readonly findings: readonly MetadataFinding[];
}

interface Row {
  readonly key: MappedKey;
  readonly namespace: string;
  readonly name: string;
  readonly prefix: string;
  readonly kind: 'alternative' | 'creators' | 'text' | 'date' | 'trapped';
  /** Pre-Part-2 names for the same value: pdf:Title, pdf:Author, pdf:Subject, pdf:Creator, pdf:CreationDate and pdf:ModDate, and xap:Title, xap:Author and xap:Description, none of which XMP Part 1 Table 5 or Part 2 3.1 defines. */
  readonly legacy: readonly (readonly [string, string, string])[];
}

// XMP Part 3 2.2, Table 20 "Mapping of PDF keys to XMP properties".
export const MAPPED_ROWS: readonly Row[] = [
  {
    key: 'Title',
    namespace: DC_NAMESPACE,
    prefix: 'dc',
    name: 'title',
    kind: 'alternative',
    legacy: [
      [PDF_NAMESPACE, 'pdf', 'Title'],
      [XMP_NAMESPACE, 'xmp', 'Title'],
    ],
  },
  {
    key: 'Author',
    namespace: DC_NAMESPACE,
    prefix: 'dc',
    name: 'creator',
    kind: 'creators',
    legacy: [
      [PDF_NAMESPACE, 'pdf', 'Author'],
      [XMP_NAMESPACE, 'xmp', 'Author'],
    ],
  },
  {
    key: 'Subject',
    namespace: DC_NAMESPACE,
    prefix: 'dc',
    name: 'description',
    kind: 'alternative',
    legacy: [
      [PDF_NAMESPACE, 'pdf', 'Subject'],
      [XMP_NAMESPACE, 'xmp', 'Description'],
    ],
  },
  { key: 'Keywords', namespace: PDF_NAMESPACE, prefix: 'pdf', name: 'Keywords', kind: 'text', legacy: [] },
  { key: 'Creator', namespace: XMP_NAMESPACE, prefix: 'xmp', name: 'CreatorTool', kind: 'text', legacy: [[PDF_NAMESPACE, 'pdf', 'Creator']] },
  { key: 'Producer', namespace: PDF_NAMESPACE, prefix: 'pdf', name: 'Producer', kind: 'text', legacy: [] },
  { key: 'CreationDate', namespace: XMP_NAMESPACE, prefix: 'xmp', name: 'CreateDate', kind: 'date', legacy: [[PDF_NAMESPACE, 'pdf', 'CreationDate']] },
  { key: 'ModDate', namespace: XMP_NAMESPACE, prefix: 'xmp', name: 'ModifyDate', kind: 'date', legacy: [[PDF_NAMESPACE, 'pdf', 'ModDate']] },
  { key: 'Trapped', namespace: PDF_NAMESPACE, prefix: 'pdf', name: 'Trapped', kind: 'trapped', legacy: [] },
];

const find = (packet: XmpPacket | undefined, namespace: string, name: string): XmpProperty | undefined =>
  packet?.properties.find(property => property.namespace === namespace && property.localName === name);

/** The text a value maps to one Info string: a simple value's text, the x-default or else the first item of an alternative, the first item of any other array; a URI or an opaque value maps to none. */
export const comparableText = (value: XmpValue): string | undefined => {
  if (value.kind === 'text') return value.text;
  if (value.kind === 'opaque' || value.kind === 'uri') return undefined;
  return (value.type === 'Alt' ? value.items.find(item => item.language === 'x-default') : undefined)?.text ?? value.items[0]?.text;
};

class RowMapper {
  readonly findings: MetadataFinding[] = [];

  private report(code: MetadataFinding['code'], detail: string): void {
    this.findings.push({ code, detail });
  }

  // Table 317: Trapped is "(Optional; PDF 1.3) A name object indicating whether the document has been modified to include trapping information".
  infoText(row: Row, value: InfoValue | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (row.kind === 'trapped') {
      if (value.kind === 'name') return value.name;
      this.report('trapped-not-name', `Trapped is ${value.kind === 'text' ? 'a string' : `of type ${value.type}`}, not a name`);
      return undefined;
    }
    if (value.kind !== 'text') {
      this.report('info-not-text-string', `${row.key} is ${value.kind === 'name' ? 'a name' : `of type ${value.type}`}, not a text string`);
      return undefined;
    }
    if (value.replaced > 0) this.report('info-text-undecodable', `${row.key} holds ${String(value.replaced)} bytes that do not decode as text`);
    // ISO 32000-1:2008, 14.3.3: "Any entry whose value is not known should be omitted from the dictionary rather than included with an empty string as its value."
    if (value.text === '') {
      this.report('info-empty-string', `${row.key} is an empty string`);
      return undefined;
    }
    if (row.kind === 'date' && parsePdfDate(value.text) === undefined) this.report('date-unparseable', `Info ${row.key} ${value.text} is not a date`);
    return value.text;
  }

  // An empty XMP value is unknown, as ISO 32000-1:2008, 14.3.3 has an unknown Info value omitted "rather than included with an empty string as its value".
  xmpValue(row: Row, value: XmpValue | undefined): XmpValue | undefined {
    const empty = value?.kind === 'text' ? value.text === '' : value?.kind === 'array' && value.items.every(item => item.text === '');
    if (!empty) return value;
    this.report('xmp-empty-value', `${row.prefix}:${row.name} is empty`);
    return undefined;
  }

  private dateAgreement(row: Row, info: string, xmp: string): Agreement {
    const pdfDate = parsePdfDate(info);
    const xmpDate = parseXmpDate(xmp);
    if (xmpDate === undefined) this.report('date-unparseable', `${row.prefix}:${row.name} ${xmp} is not a date`);
    if (pdfDate === undefined || xmpDate === undefined) return 'indeterminate';
    const result = compareDates(pdfDate, xmpDate);
    if (result === 'equal') return 'agree';
    if (result === 'different') return 'differ';
    this.report('date-zone-unknown', `${row.prefix}:${row.name} ${xmp} has no time zone`);
    return 'indeterminate';
  }

  private bothAgreement(row: Row, info: string, xmp: XmpValue): Agreement {
    const text = comparableText(xmp);
    if (text === undefined) return 'indeterminate';
    if (row.kind === 'date') return this.dateAgreement(row, info, text);
    if (info === text) return 'agree';
    // Table 20: Author maps to "the first of the creators" or to "a concatenated list of the creators … separated by a standard separator character such as semicolon".
    if (row.kind === 'creators' && xmp.kind === 'array' && info.split(/\s*;\s*/u).join('\n') === xmp.items.map(item => item.text).join('\n')) return 'agree';
    return 'differ';
  }

  agreement(row: Row, info: string | undefined, xmp: XmpValue | undefined): Agreement {
    // XMP Part 2 3.1: pdf:Trapped is Boolean, so Info Unknown has no XMP form.
    const infoSide = row.kind === 'trapped' && info === 'Unknown' ? undefined : info;
    if (infoSide === undefined) {
      if (xmp !== undefined) return 'xmp-only';
      return info === undefined ? 'absent' : 'agree';
    }
    if (xmp === undefined) return 'info-only';
    return this.bothAgreement(row, infoSide, xmp);
  }

  legacyValues(row: Row, packet: XmpPacket | undefined, compared: string | undefined): LegacyValue[] {
    const values: LegacyValue[] = [];
    for (const [namespace, prefix, name] of row.legacy) {
      const property = find(packet, namespace, name);
      if (property === undefined) continue;
      values.push({ property: `${prefix}:${name}`, value: property.value });
      const text = comparableText(property.value);
      if (compared !== undefined && text !== undefined && text !== compared) {
        this.report('legacy-property-mismatch', `${prefix}:${name} says ${text}, ${row.prefix}:${row.name} or Info ${row.key} says ${compared}`);
      }
    }
    return values;
  }
}

const stampOf = (packet: XmpPacket): XmpDate | undefined => {
  const property = find(packet, XMP_NAMESPACE, 'MetadataDate') ?? find(packet, XMP_NAMESPACE, 'ModifyDate');
  const text = property === undefined ? undefined : comparableText(property.value);
  return text === undefined ? undefined : parseXmpDate(text);
};

// ISO 32000-1:2008, 14.3.2: "If this date stamp is equal to or later than the document modification date recorded in the document information dictionary, the metadata stream shall be taken as authoritative."
// XMP Specification Part 3, 2.2.2 compares Info ModDate with xmp:MetadataDate; xmp:ModifyDate stands in when a packet has no xmp:MetadataDate.
const authorityOf = (
  info: ReadonlyMap<string, InfoValue> | undefined,
  packet: XmpPacket | undefined,
  findings: MetadataFinding[],
): MetadataMapping['authority'] => {
  if (packet === undefined) return 'info';
  if (info === undefined) return 'xmp';
  const modified = info.get('ModDate');
  const infoDate: ParsedPdfDate | undefined = modified?.kind === 'text' ? parsePdfDate(modified.text) : undefined;
  const stamp = stampOf(packet);
  if (infoDate === undefined || stamp === undefined) return 'indeterminate';
  const same = compareDates(infoDate, stamp);
  if (same === 'indeterminate') return 'indeterminate';
  if (same === 'equal' || instant(stamp.date) > instant(infoDate.date)) return 'xmp';
  findings.push({ code: 'modification-after-metadata', detail: 'Info ModDate is later than the metadata date, so Info overrides the packet' });
  return 'info';
};

/** Compares the document information dictionary with the document's XMP packet row by row of XMP Part 3 Table 20, and decides which side is authoritative. */
export const mapMetadata = (info: ReadonlyMap<string, InfoValue> | undefined, packet: XmpPacket | undefined): MetadataMapping => {
  const mapper = new RowMapper();
  const { findings } = mapper;
  const rows: { property: MappedProperty; row: Row }[] = [];
  for (const row of MAPPED_ROWS) {
    const infoValue = mapper.infoText(row, info?.get(row.key));
    const xmp = mapper.xmpValue(row, find(packet, row.namespace, row.name)?.value);
    const compared = xmp === undefined ? infoValue : comparableText(xmp);
    const legacy = mapper.legacyValues(row, packet, compared);
    const agreement = mapper.agreement(row, infoValue, xmp);
    rows.push({ row, property: { key: row.key, property: `${row.prefix}:${row.name}`, info: infoValue, xmp, legacy, agreement } });
  }
  const authority = authorityOf(info, packet, findings);
  for (const { row, property } of rows) {
    const shown = property.xmp === undefined ? '' : (comparableText(property.xmp) ?? 'a structured value');
    if (property.agreement === 'differ') {
      findings.push({
        code: 'info-xmp-mismatch',
        detail: `Info ${row.key} says ${property.info ?? ''}, ${property.property} says ${shown}; ${authority} is authoritative`,
      });
    } else if (property.agreement === 'indeterminate') {
      findings.push({ code: 'info-xmp-indeterminate', detail: `Info ${row.key} and ${property.property} cannot be compared` });
    }
  }
  return { properties: rows.map(({ property }) => property), authority, findings };
};
