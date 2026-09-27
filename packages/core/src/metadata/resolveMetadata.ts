import type { PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { MappedKey, MappedProperty, MetadataMapping } from './mapping.ts';
import type { MetadataState } from './readMetadata.ts';
import type { XmpValue } from './xmp/readXmp.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { parsePdfDate, pdfDateObject } from '../date/pdfDate.ts';
import { PdfDictionaryEntries, pdfName } from '../object/pdfObject.ts';

import { pdfTextString } from './documentInfo.ts';
import { MAPPED_ROWS, comparableText } from './mapping.ts';
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

/** A value the edit discarded: one side's value where Info and XMP differed and the other side's was taken ('info' or 'xmp'), or a packet item that one written value replaces ('input' when the caller set the key). */
export interface ReconciledValue {
  readonly key: MappedKey;
  readonly from: 'info' | 'xmp' | 'input';
  readonly discarded: string;
}

/** What an edit does to one side of a key: leave the stored value as it is, write a value, or remove the key. */
export type InfoAction = { readonly kind: 'keep' } | { readonly kind: 'set'; readonly value: PdfDirectObject } | { readonly kind: 'remove' };
export type XmpAction = { readonly kind: 'keep' } | { readonly kind: 'write'; readonly value: string } | { readonly kind: 'remove' };

export interface KeyPlan {
  readonly info: InfoAction;
  readonly xmp: XmpAction;
}

/** The keys an edit resolves; ModDate always takes the input's modificationDate. */
export type ResolvedKey = Exclude<MappedKey, 'ModDate'>;

export interface ResolvedInput {
  readonly plans: Readonly<Record<ResolvedKey, KeyPlan>>;
  readonly reconciled: readonly ReconciledValue[];
  /** The keys whose packet property is left as it is. */
  readonly kept: ReadonlySet<MappedKey>;
}

const KEEP = { kind: 'keep' } as const;
const REMOVE = { kind: 'remove' } as const;
const BOTH_REMOVED: KeyPlan = { info: REMOVE, xmp: REMOVE };

type Trapped = 'True' | 'False' | 'Unknown';

const trappedName = (value: string | undefined): Trapped | undefined => (value === 'True' || value === 'False' || value === 'Unknown' ? value : undefined);

interface Sides<T> {
  readonly info: T | undefined;
  readonly xmp: T | undefined;
}

/** How a resolved value is written to each side. */
interface Writers {
  readonly info: (value: string) => PdfDirectObject;
  readonly xmp: (value: string) => XmpAction;
}

const TEXT_WRITERS: Writers = { info: pdfTextString, xmp: value => ({ kind: 'write', value }) };

// XMP Part 2 3.1: pdf:Trapped is Boolean, so Info Unknown has no XMP form.
const TRAPPED_WRITERS: Writers = { info: pdfName, xmp: value => (value === 'True' || value === 'False' ? { kind: 'write', value } : REMOVE) };

class Resolver {
  readonly reconciled: ReconciledValue[] = [];
  readonly kept = new Set<MappedKey>();
  private readonly mapping: MetadataMapping;
  private readonly occurrences: ReadonlyMap<MappedKey, number>;

  constructor(state: MetadataState) {
    this.mapping = state.mapping;
    const properties = state.xmp !== undefined && 'packet' in state.xmp ? state.xmp.packet.properties : [];
    const counts = new Map<MappedKey, number>();
    for (const row of MAPPED_ROWS) {
      counts.set(row.key, properties.filter(property => property.namespace === row.namespace && property.localName === row.name).length);
    }
    this.occurrences = counts;
  }

  private row(key: MappedKey): MappedProperty | undefined {
    return this.mapping.properties.find(property => property.key === key);
  }

  // A property that occurs once is left as it is; with more occurrences, which one a reader takes is unclear, so it is written again.
  private keepXmp(key: MappedKey, value: string, writers: Writers): XmpAction {
    if (this.occurrences.get(key) !== 1) return writers.xmp(value);
    this.kept.add(key);
    return KEEP;
  }

  // Each item of the packet's value that the written value does not carry is discarded.
  private discardItems(
    key: MappedKey,
    from: ReconciledValue['from'],
    { value, written }: { readonly value: XmpValue | undefined; readonly written: string | undefined },
  ): void {
    if (value?.kind === 'text' && from !== 'input' && value.text !== written) this.reconciled.push({ key, from, discarded: value.text });
    if (value?.kind !== 'array') return;
    let carried = false;
    for (const item of value.items) {
      if (!carried && item.text === written) carried = true;
      else this.reconciled.push({ key, from, discarded: item.text });
    }
  }

  // With no input, a side that agrees with the resolved value is left as it is and the other is written from it; where both have a value and they disagree, ISO 32000-1:2008, 14.3.2 decides, and where it cannot, Info wins, as XMP Part 3 2.1 prefers the native form when the most recent cannot be determined.
  private resolve(key: MappedKey, sides: Sides<string>, writers: Writers): KeyPlan {
    const { info, xmp } = sides;
    const row = this.row(key);
    if (info === undefined && xmp === undefined) return BOTH_REMOVED;
    if (info === undefined) return xmp === undefined ? BOTH_REMOVED : { info: { kind: 'set', value: writers.info(xmp) }, xmp: this.keepXmp(key, xmp, writers) };
    if (xmp === undefined) return { info: KEEP, xmp: writers.xmp(info) };
    if (row?.agreement === 'agree') return { info: KEEP, xmp: this.keepXmp(key, xmp, writers) };
    if (this.mapping.authority === 'xmp') {
      this.reconciled.push({ key, from: 'xmp', discarded: info });
      return { info: { kind: 'set', value: writers.info(xmp) }, xmp: this.keepXmp(key, xmp, writers) };
    }
    this.discardItems(key, 'info', { value: row?.xmp, written: info });
    return { info: KEEP, xmp: writers.xmp(info) };
  }

  // An empty input is an unknown value, which ISO 32000-1:2008, 14.3.3 has omitted rather than written empty.
  text(key: ResolvedKey, input: string | null | undefined): KeyPlan {
    const row = this.row(key);
    if (input !== undefined) {
      const value = input === null || input === '' ? undefined : input;
      this.discardItems(key, 'input', { value: row?.xmp, written: value });
      return value === undefined ? BOTH_REMOVED : { info: { kind: 'set', value: pdfTextString(value) }, xmp: { kind: 'write', value } };
    }
    const xmp = row?.xmp === undefined ? undefined : comparableText(row.xmp);
    return this.resolve(key, { info: row?.info, xmp }, TEXT_WRITERS);
  }

  trapped(input: MetadataInput['trapped']): KeyPlan {
    if (input === null) return BOTH_REMOVED;
    if (input !== undefined) return { info: { kind: 'set', value: pdfName(input) }, xmp: TRAPPED_WRITERS.xmp(input) };
    const row = this.row('Trapped');
    const xmp = trappedName(row?.xmp === undefined ? undefined : comparableText(row.xmp));
    return this.resolve('Trapped', { info: trappedName(row?.info), xmp }, TRAPPED_WRITERS);
  }

  private pickDate(sides: Sides<PdfDate>, shown: Sides<string>): PdfDate | undefined {
    const { info, xmp } = sides;
    if (info === undefined || xmp === undefined || this.row('CreationDate')?.agreement === 'agree') return info ?? xmp;
    const from = this.mapping.authority === 'xmp' ? 'xmp' : 'info';
    this.reconciled.push({ key: 'CreationDate', from, discarded: (from === 'xmp' ? shown.info : shown.xmp) ?? '' });
    return from === 'xmp' ? xmp : info;
  }

  creationDate(input: PdfDate | null | undefined): KeyPlan {
    let date = input ?? undefined;
    if (input === undefined) {
      const row = this.row('CreationDate');
      const infoDate = row?.info === undefined ? undefined : parsePdfDate(row.info)?.date;
      const xmpText = row?.xmp === undefined ? undefined : comparableText(row.xmp);
      const xmpDate = xmpText === undefined ? undefined : parseXmpDate(xmpText);
      // An XMP time without a time zone designator names no instant (XMP Part 1 8.2.1.2), so it cannot become a PDF date.
      const usable = xmpDate !== undefined && (xmpDate.zone === 'explicit' || ['year', 'month', 'day'].includes(xmpDate.precision)) ? xmpDate.date : undefined;
      date = this.pickDate({ info: infoDate, xmp: usable }, { info: row?.info, xmp: xmpText });
    }
    return date === undefined ? BOTH_REMOVED : { info: { kind: 'set', value: pdfDateObject(date) }, xmp: { kind: 'write', value: xmpDateString(date) } };
  }
}

/** Resolves each key the input sets or leaves out into what the edit does to Info and to the packet, and the values it discards. */
export const resolveValues = (state: MetadataState, input: MetadataInput): ResolvedInput => {
  const resolver = new Resolver(state);
  const plans: Record<ResolvedKey, KeyPlan> = {
    Title: resolver.text('Title', input.title),
    Author: resolver.text('Author', input.author),
    Subject: resolver.text('Subject', input.subject),
    Keywords: resolver.text('Keywords', input.keywords),
    Creator: resolver.text('Creator', input.creator),
    Producer: resolver.text('Producer', input.producer),
    CreationDate: resolver.creationDate(input.creationDate),
    Trapped: resolver.trapped(input.trapped),
  };
  return { plans, reconciled: resolver.reconciled, kept: resolver.kept };
};

export interface Identifiers {
  readonly documentId: string;
  readonly instanceId: string;
}

const written = (plan: KeyPlan): string | undefined => (plan.xmp.kind === 'write' ? plan.xmp.value : undefined);

/** The values the packet's new rdf:Description holds; a key whose property is kept or removed has none. */
export const managedValues = (resolved: ResolvedInput, input: MetadataInput, identifiers: Identifiers): ManagedValues => {
  const { plans } = resolved;
  const trapped = written(plans.Trapped);
  return {
    title: written(plans.Title),
    author: written(plans.Author),
    subject: written(plans.Subject),
    keywords: written(plans.Keywords),
    creator: written(plans.Creator),
    producer: written(plans.Producer),
    trapped: trapped === 'True' || trapped === 'False' ? trapped : undefined,
    createDate: written(plans.CreationDate),
    modifyDate: xmpDateString(input.modificationDate),
    metadataDate: xmpDateString(input.modificationDate),
    documentId: identifiers.documentId,
    instanceId: identifiers.instanceId,
  };
};

// ISO 32000-1:2008, 14.3.3: unmanaged keys stay; each managed key is kept, set or, with no value, removed, since "Any entry whose value is not known should be omitted".
export const infoDictionary = (existing: PdfDictionaryEntries | undefined, resolved: ResolvedInput, input: MetadataInput): PdfDictionaryEntries => {
  const entries = new PdfDictionaryEntries(existing === undefined ? [] : [...existing.entries()]);
  const apply = (key: string, action: InfoAction): void => {
    if (action.kind === 'remove') entries.delete(pdfName(key).bytes);
    else if (action.kind === 'set') entries.set(pdfName(key).bytes, action.value);
  };
  const { plans } = resolved;
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate'] as const) apply(key, plans[key].info);
  apply('ModDate', { kind: 'set', value: pdfDateObject(input.modificationDate) });
  apply('Trapped', plans.Trapped.info);
  return entries;
};
