import type { ParsedPdfDate, PdfDate } from '../date/pdfDate.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { MappedKey, MappedProperty, MetadataMapping } from './mapping.ts';
import type { MetadataFinding } from './metadataFinding.ts';
import type { MetadataState } from './readMetadata.ts';
import type { ReadProperty, XmpValue } from './xmp/readXmp.ts';
import type { ManagedValues } from './xmp/writeXmp.ts';

import { parsePdfDate, pdfDateObject } from '../date/pdfDate.ts';
import { PdfDictionaryEntries, pdfName, pdfString } from '../object/pdfObject.ts';

import { pdfTextString } from './documentInfo.ts';
import { MAPPED_ROWS, comparableText } from './mapping.ts';
import { finerThan, parseXmpDate, pdfDateText, xmpDateString, xmpDateText } from './xmp/xmpDate.ts';

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
  /** Values left as they were stored because the mapping cannot read them. */
  readonly findings: readonly MetadataFinding[];
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

const dateToInfo = (value: ParsedPdfDate): InfoAction => ({ kind: 'set', value: pdfString(new TextEncoder().encode(pdfDateText(value))) });
const dateToXmp = (value: ParsedPdfDate): XmpAction => ({ kind: 'write', value: xmpDateText(value) });

class Resolver {
  readonly reconciled: ReconciledValue[] = [];
  readonly findings: MetadataFinding[] = [];
  readonly kept = new Set<MappedKey>();
  private readonly mapping: MetadataMapping;
  private readonly packetText: string;
  private readonly occurrences: ReadonlyMap<MappedKey, readonly ReadProperty[]>;

  constructor(state: MetadataState) {
    this.mapping = state.mapping;
    const packet = state.xmp !== undefined && 'packet' in state.xmp ? state.xmp.packet : undefined;
    const properties = packet?.properties ?? [];
    this.packetText = packet?.text ?? '';
    const found = new Map<MappedKey, readonly ReadProperty[]>();
    for (const row of MAPPED_ROWS) {
      found.set(
        row.key,
        properties.filter(property => property.namespace === row.namespace && property.localName === row.name),
      );
    }
    this.occurrences = found;
  }

  private row(key: MappedKey): MappedProperty | undefined {
    return this.mapping.properties.find(property => property.key === key);
  }

  // A property that occurs once is left as it is; with more occurrences, which one a reader takes is unclear, so it is written again.
  private keepXmp(key: MappedKey, written: () => XmpAction): XmpAction {
    if (this.occurrences.get(key)?.length !== 1) return written();
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
    // A value the mapping does not read is reported as the XML it was written as.
    const [first] = this.occurrences.get(key) ?? [];
    if ((value?.kind === 'opaque' || value?.kind === 'uri') && first !== undefined) {
      this.reconciled.push({ key, from, discarded: this.packetText.slice(first.textSpan.start, first.textSpan.end) });
    }
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
    if (xmp === undefined) return info === undefined ? BOTH_REMOVED : { info: KEEP, xmp: writers.xmp(info) };
    const fromXmp = (): KeyPlan => ({ info: { kind: 'set', value: writers.info(xmp) }, xmp: this.keepXmp(key, () => writers.xmp(xmp)) });
    if (info === undefined) return fromXmp();
    if (row?.agreement === 'agree') return { info: KEEP, xmp: this.keepXmp(key, () => writers.xmp(xmp)) };
    if (this.mapping.authority === 'xmp') {
      this.reconciled.push({ key, from: 'xmp', discarded: info });
      return fromXmp();
    }
    this.discardItems(key, 'info', { value: row?.xmp, written: info });
    return { info: KEEP, xmp: writers.xmp(info) };
  }

  // A property in a form the mapping does not read, such as a qualified value (XMP Part 1 7.8), is left as it is, and Info as stored.
  private unread(key: MappedKey): KeyPlan | undefined {
    const row = this.row(key);
    const found = this.occurrences.get(key) ?? [];
    const [only] = found;
    if (found.length !== 1 || (only?.value.kind !== 'opaque' && only?.value.kind !== 'uri')) return undefined;
    this.kept.add(key);
    this.findings.push({ code: 'opaque-property-kept', detail: `${row?.property ?? key} is in a form the mapping does not read and was left as it is` });
    return { info: row?.info === undefined ? REMOVE : KEEP, xmp: KEEP };
  }

  // An empty input is an unknown value, which ISO 32000-1:2008, 14.3.3 has omitted rather than written empty.
  text(key: ResolvedKey, input: string | null | undefined): KeyPlan {
    const row = this.row(key);
    const unread = input === undefined ? this.unread(key) : undefined;
    if (unread !== undefined) return unread;
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
    const unread = this.unread('Trapped');
    if (unread !== undefined) return unread;
    const row = this.row('Trapped');
    const xmp = trappedName(row?.xmp === undefined ? undefined : comparableText(row.xmp));
    return this.resolve('Trapped', { info: trappedName(row?.info), xmp }, TRAPPED_WRITERS);
  }

  private dateSides(): Sides<ParsedPdfDate> & { readonly shown: Sides<string> } {
    const row = this.row('CreationDate');
    const infoText = row?.info;
    const xmpText = row?.xmp === undefined ? undefined : comparableText(row.xmp);
    return {
      info: infoText === undefined ? undefined : parsePdfDate(infoText),
      xmp: xmpText === undefined ? undefined : parseXmpDate(xmpText),
      shown: { info: infoText, xmp: xmpText },
    };
  }

  // A date is written to each side to its own precision, from the side that gives more where both agree, so that a coarse date never replaces a finer one and no field or time zone is added (XMP Part 1 8.2.1.2); where they disagree, the authoritative side is kept, and where they cannot be compared, Info, whose time has a zone.
  creationDate(input: PdfDate | null | undefined): KeyPlan {
    if (input === null) return BOTH_REMOVED;
    if (input !== undefined) return { info: { kind: 'set', value: pdfDateObject(input) }, xmp: { kind: 'write', value: xmpDateString(input) } };
    const unread = this.unread('CreationDate');
    if (unread !== undefined) return unread;
    const { info, xmp, shown } = this.dateSides();
    const keepXmp = (value: ParsedPdfDate): XmpAction => this.keepXmp('CreationDate', () => dateToXmp(value));
    if (info === undefined) return xmp === undefined ? BOTH_REMOVED : { info: dateToInfo(xmp), xmp: keepXmp(xmp) };
    if (xmp === undefined) return { info: KEEP, xmp: dateToXmp(info) };
    const agreement = this.row('CreationDate')?.agreement;
    if (agreement === 'agree') {
      if (finerThan(xmp, info) && pdfDateText(xmp) !== pdfDateText(info)) return { info: dateToInfo(xmp), xmp: keepXmp(xmp) };
      return finerThan(info, xmp) ? { info: KEEP, xmp: dateToXmp(info) } : { info: KEEP, xmp: keepXmp(xmp) };
    }
    if (agreement === 'differ' && this.mapping.authority === 'xmp') {
      this.reconciled.push({ key: 'CreationDate', from: 'xmp', discarded: shown.info ?? '' });
      return { info: dateToInfo(xmp), xmp: keepXmp(xmp) };
    }
    this.reconciled.push({ key: 'CreationDate', from: 'info', discarded: shown.xmp ?? '' });
    return { info: KEEP, xmp: dateToXmp(info) };
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
  return { plans, reconciled: resolver.reconciled, findings: resolver.findings, kept: resolver.kept };
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
