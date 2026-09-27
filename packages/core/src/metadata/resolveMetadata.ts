import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { MappedKey, MappedProperty, MetadataMapping } from './mapping.ts';
import type { MetadataState } from './readMetadata.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { parsePdfDate, pdfDateObject } from '../date/pdfDate.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';

import { pdfTextString } from './documentInfo.ts';
import { comparableText } from './mapping.ts';
import { parseXmpDate, xmpDateString } from './xmp/xmpDate.ts';

export interface MetadataInput {
  /** Info Title and dc:title; left out, the document's value is kept, taken from the authoritative side where Info and XMP disagree; null or an empty string removes it. */
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

/** A key whose Info and XMP values differed and whose value was taken from one side. */
export interface ReconciledValue {
  readonly key: MappedKey;
  readonly from: 'info' | 'xmp';
  readonly discarded: string;
}

export interface ResolvedValues {
  readonly title: string | undefined;
  readonly author: string | undefined;
  readonly subject: string | undefined;
  readonly keywords: string | undefined;
  readonly creator: string | undefined;
  readonly producer: string | undefined;
  readonly creationDate: PdfDate | undefined;
  readonly trapped: 'True' | 'False' | 'Unknown' | undefined;
}

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

  // An empty input is an unknown value, which ISO 32000-1:2008, 14.3.3 has omitted rather than written empty.
  text(key: MappedKey, input: string | null | undefined): string | undefined {
    if (input !== undefined) return input === null || input === '' ? undefined : input;
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

export interface ResolvedInput {
  readonly values: ResolvedValues;
  readonly reconciled: readonly ReconciledValue[];
}

export const resolveValues = (state: MetadataState, input: MetadataInput): ResolvedInput => {
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

export interface Identifiers {
  readonly documentId: string;
  readonly instanceId: string;
}

export const managedValues = (values: ResolvedValues, input: MetadataInput, identifiers: Identifiers): ManagedValues => ({
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
export const infoDictionary = (existing: PdfDictionaryEntries | undefined, values: ResolvedValues, input: MetadataInput): PdfDictionaryEntries => {
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
