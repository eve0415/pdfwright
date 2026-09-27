import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { CodeRange } from './cmap/parseCMap.ts';
import type { CidFontSubtype, DescendantFont, VerticalMetrics } from './fontModel.ts';
import type { FontSource } from './fontValues.ts';

import { pdfName } from '../object/pdfObject.ts';

import { MappingTable } from './cmap/mappingTable.ts';
import { decodedData, dictionaryOf, latin1, nameOf, numberOf, numbersOf } from './fontValues.ts';

const DESCENDANT_FONTS = pdfName('DescendantFonts').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const WIDTH_ARRAY = pdfName('W').bytes;
const VERTICAL_ARRAY = pdfName('W2').bytes;
const DEFAULT_VERTICAL = pdfName('DW2').bytes;
const DEFAULT_WIDTH = pdfName('DW').bytes;
const CID_TO_GID_MAP = pdfName('CIDToGIDMap').bytes;
const CID_SYSTEM_INFO = pdfName('CIDSystemInfo').bytes;
const REGISTRY = pdfName('Registry').bytes;
const ORDERING = pdfName('Ordering').bytes;

const cidSubtype = (name: string | undefined): CidFontSubtype => (name === 'CIDFontType0' || name === 'CIDFontType2' ? name : 'other');

/** ISO 32000-1:2008, Table 121, DescendantFonts: "A one-element array specifying the CIDFont dictionary that is the descendant of this Type 0 font." */
export const descendantOf = (source: FontSource, font: PdfDictionaryEntries): DescendantFont | undefined => {
  const array = source.objects.deref(font.get(DESCENDANT_FONTS));
  const [item] = array?.kind === 'array' ? array.items : [];
  const dictionary = dictionaryOf(source.objects.deref(item));
  if (dictionary === undefined) return undefined;
  const subtype = nameOf(source.objects.deref(dictionary.get(SUBTYPE)));
  return { subtype: cidSubtype(subtype), dictionary, reference: item?.kind === 'reference' ? item : undefined };
};

/** The registry and ordering of a CIDSystemInfo dictionary (Table 116), as text. */
export const collectionOf = (
  source: FontSource,
  dictionary: PdfDictionaryEntries | undefined,
): { readonly registry: string; readonly ordering: string } | undefined => {
  const info = dictionaryOf(source.objects.deref(dictionary?.get(CID_SYSTEM_INFO)));
  const registry = source.objects.deref(info?.get(REGISTRY));
  const ordering = source.objects.deref(info?.get(ORDERING));
  if (registry?.kind !== 'string' || ordering?.kind !== 'string') return undefined;
  return { registry: latin1(registry.bytes), ordering: latin1(ordering.bytes) };
};

/** CID metrics of the W or W2 form, looked up as ranges of 2-byte codes whose value is the CID. */
export type CidMetric<T> = CodeRange & { readonly metric: T };

/** How a W or W2 array is read: `size` numbers per metric, made into a value by `make`. */
export interface MetricFormat<T> {
  readonly size: number;
  readonly make: (numbers: readonly number[]) => T;
}

/**
 * Reads the groups of a W or W2 array (ISO 32000-1:2008, 9.7.4.3): `c [m1 m2 …]`, consecutive CIDs from c each taking `size` numbers, or `cfirst clast m`, one metric of `size` numbers for a range.
 * Malformed groups end the reading; the groups before them are kept.
 */
export const cidMetrics = <T>(source: FontSource, value: PdfDirectObject | undefined, { size, make }: MetricFormat<T>): MappingTable<CidMetric<T>> => {
  const array = source.objects.deref(value);
  const items = array?.kind === 'array' ? array.items.map(item => source.objects.deref(item)) : [];
  const metrics: CidMetric<T>[] = [];
  let index = 0;
  while (index < items.length) {
    const first = numberOf(items[index]);
    const next = items[index + 1];
    if (first === undefined || !Number.isInteger(first) || first < 0) break;
    if (next?.kind === 'array') {
      const numbers = next.items.map(item => numberOf(source.objects.deref(item)));
      for (let group = 0; group + size <= numbers.length; group += size) {
        const slice = numbers.slice(group, group + size);
        if (slice.includes(undefined)) break;
        const cid = first + group / size;
        metrics.push({ length: 2, low: cid, high: cid, metric: make(slice.map(number => number ?? 0)) });
      }
      index += 2;
      continue;
    }
    const last = numberOf(next);
    const numbers = items.slice(index + 2, index + 2 + size).map(item => numberOf(item));
    if (last === undefined || !Number.isInteger(last) || last < first || numbers.length < size || numbers.includes(undefined)) break;
    metrics.push({ length: 2, low: first, high: last, metric: make(numbers.map(number => number ?? 0)) });
    index += 2 + size;
  }
  return new MappingTable(metrics);
};

/** A CIDFont's width for a CID in glyph space: from W, else DW, whose "Default value: 1000" (Table 117). */
export const cidWidths = (source: FontSource, descendant: PdfDictionaryEntries): ((cid: number) => number) => {
  const table = cidMetrics(source, descendant.get(WIDTH_ARRAY), { size: 1, make: ([width = 0]) => width });
  const fallback = numberOf(source.objects.deref(descendant.get(DEFAULT_WIDTH))) ?? 1000;
  return cid => table.find({ value: cid, length: 2 })?.metric ?? fallback;
};

/**
 * A CIDFontType2 font's glyph index for a CID (Table 117, CIDToGIDMap): the identity when the entry is absent or the name Identity; from a stream, "the glyph index for a particular CID value c shall be a 2-byte value stored in bytes 2 × c and 2 × c + 1, where the first byte shall be the high-order byte".
 * A CID past the end of the stream selects glyph 0. A map that cannot be read is returned as the reason.
 */
export const cidToGid = (source: FontSource, descendant: PdfDictionaryEntries): ((cid: number) => number) | string => {
  const value = source.objects.deref(descendant.get(CID_TO_GID_MAP));
  if (value === undefined || nameOf(value) === 'Identity') return cid => cid;
  if (value.kind !== 'stream') return 'the CIDToGIDMap entry is not the name Identity or a stream';
  const data = decodedData(source, value);
  if (typeof data === 'string') return `the CIDToGIDMap stream cannot be decoded: ${data}`;
  return cid => (data[2 * cid] ?? 0) * 256 + (data[2 * cid + 1] ?? 0);
};

/**
 * A CIDFont's writing mode 1 metrics for a CID with horizontal width `w0`, in glyph space (ISO 32000-1:2008, 9.7.4.3): from W2, whose groups are "the vertical component of the vertical displacement vector w1 … followed by the horizontal and vertical components for the position vector v", else from DW2, "Default value: [ 880 −1000 ]" (Table 117), whose position vector's horizontal component "shall be half the glyph width".
 */
export const cidVertical = (source: FontSource, descendant: PdfDictionaryEntries): ((cid: number, w0: number) => VerticalMetrics) => {
  const table = cidMetrics(source, descendant.get(VERTICAL_ARRAY), { size: 3, make: ([w1 = 0, vx = 0, vy = 0]): VerticalMetrics => ({ w1, vx, vy }) });
  const defaults = numbersOf(source, descendant.get(DEFAULT_VERTICAL));
  const [vy, w1] = defaults?.length === 2 ? defaults : [880, -1000];
  return (cid, w0) => table.find({ value: cid, length: 2 })?.metric ?? { w1: w1 ?? -1000, vx: w0 / 2, vy: vy ?? 880 };
};
