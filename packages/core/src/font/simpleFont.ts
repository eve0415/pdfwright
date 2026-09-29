import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { EncodingTable } from './encoding/simpleEncodings.ts';
import type { Descriptor } from './fontDescriptor.ts';
import type { FontSubtype } from './fontModel.ts';
import type { FontSource } from './fontValues.ts';

import { pdfName } from '../object/pdfObject.ts';

import { STANDARD_ENCODING, SYMBOL_ENCODING, ZAPF_DINGBATS_ENCODING, namedEncoding } from './encoding/simpleEncodings.ts';
import { latin1, nameOf, numberOf, numbersOf, withoutSubsetTag } from './fontValues.ts';
import { STANDARD_14 } from './standard14.ts';

const ENCODING = pdfName('Encoding').bytes;
const BASE_ENCODING = pdfName('BaseEncoding').bytes;
const DIFFERENCES = pdfName('Differences').bytes;
const FIRST_CHAR = pdfName('FirstChar').bytes;
const LAST_CHAR = pdfName('LastChar').bytes;
const WIDTHS = pdfName('Widths').bytes;
const BASE_FONT = pdfName('BaseFont').bytes;

/** What the encoding and widths of a simple font are read from. */
export interface SimpleFontInput {
  readonly source: FontSource;
  readonly font: PdfDictionaryEntries;
  readonly subtype: FontSubtype;
  readonly descriptor: Descriptor;
}

/** A simple font's glyph names by code, the Differences names in the order given, and the damage found reading its Encoding. */
export interface SimpleGlyphNames {
  readonly names: EncodingTable;
  readonly differences: readonly string[];
  readonly problems: readonly string[];
}

/**
 * The encoding a font program has built in, as far as it is known without reading the program: the Symbol and ZapfDingbats encodings of Annex D.5 and D.6 for those fonts, StandardEncoding for a nonsymbolic Type 1 font and for the other standard 14 fonts, and nothing otherwise.
 * ISO 32000-1:2008, 9.6.6.2: "A Type 1 font’s built-in encoding shall be defined by an Encoding array that is part of the font program", which pdfwright does not parse.
 */
const builtInEncoding = (subtype: FontSubtype, baseFont: string | undefined, descriptor: Descriptor): EncodingTable | undefined => {
  if (subtype === 'Type3') return undefined;
  const name = baseFont === undefined ? undefined : withoutSubsetTag(baseFont);
  if (subtype !== 'TrueType' && name === 'Symbol') return SYMBOL_ENCODING;
  if (subtype !== 'TrueType' && name === 'ZapfDingbats') return ZAPF_DINGBATS_ENCODING;
  const standard14 = descriptor.dictionary === undefined && baseFont !== undefined && STANDARD_14.has(baseFont);
  return descriptor.nonsymbolic || standard14 ? STANDARD_ENCODING : undefined;
};

// ISO 32000-1:2008, 9.6.6.1: "Each code shall be the first index in a sequence of character codes to be changed. The first character name after the code becomes the name corresponding to that code. Subsequent names replace consecutive code indices until the next code appears in the array or the array ends."
interface AppliedDifferences {
  readonly listed: string[];
  readonly problems: string[];
}

const applyDifferences = (source: FontSource, value: PdfDictionaryEntries, names: (string | undefined)[]): AppliedDifferences => {
  const differences = source.objects.deref(value.get(DIFFERENCES));
  const problems: string[] = [];
  const listed: string[] = [];
  if (differences === undefined) return { listed, problems };
  if (differences.kind !== 'array') return { listed, problems: ['the Differences entry is not an array'] };
  let code: number | undefined = undefined;
  for (const item of differences.items) {
    const resolved = source.objects.deref(item);
    if (resolved?.kind === 'integer') code = resolved.value;
    else if (resolved?.kind === 'name' && code !== undefined) {
      const name = latin1(resolved.bytes);
      listed.push(name);
      if (code >= 0 && code <= 255) names[code] = name;
      code++;
    } else problems.push('the Differences array holds a value that is not a code or a name after a code');
  }
  return { listed, problems };
};

/**
 * A simple font's glyph name for each code, by ISO 32000-1:2008, 9.6.6: an Encoding name selects a predefined encoding; an encoding dictionary applies Differences to its BaseEncoding, or to the implicit base Table 114 describes; without an Encoding the font's built-in encoding applies.
 * A Type 3 font's names come from its Encoding alone (9.6.6.3). A nonsymbolic TrueType font's undefined entries are filled from StandardEncoding (9.6.6.4).
 */
export const simpleGlyphNames = ({ source, font, subtype, descriptor }: SimpleFontInput): SimpleGlyphNames => {
  const problems: string[] = [];
  const baseFont = nameOf(source.objects.deref(font.get(BASE_FONT)));
  const builtIn = builtInEncoding(subtype, baseFont, descriptor);
  const encoding = source.objects.deref(font.get(ENCODING));
  let base: EncodingTable | undefined = builtIn;
  let differences: string[] = [];
  const names: (string | undefined)[] = Array.from<string | undefined>({ length: 256 });
  if (encoding?.kind === 'name') {
    const name = latin1(encoding.bytes);
    base = namedEncoding(name) ?? builtIn;
    if (namedEncoding(name) === undefined) problems.push(`the Encoding name ${name} is not a predefined encoding`);
  } else if (encoding?.kind === 'dictionary') {
    const baseName = nameOf(source.objects.deref(encoding.entries.get(BASE_ENCODING)));
    const named = baseName === undefined ? undefined : namedEncoding(baseName);
    if (baseName !== undefined && named === undefined) problems.push(`the BaseEncoding name ${baseName} is not a predefined encoding`);
    base = named ?? builtIn;
    for (const [code, name] of (base ?? []).entries()) names[code] = name;
    const applied = applyDifferences(source, encoding.entries, names);
    differences = applied.listed;
    problems.push(...applied.problems);
    base = undefined;
  } else if (encoding !== undefined) problems.push('the Encoding entry is not a name or a dictionary');
  if (base !== undefined) for (const [code, name] of base.entries()) names[code] = name;
  // 9.6.6.4: "Finally, any undefined entries in the table shall be filled using StandardEncoding."
  if (subtype === 'TrueType' && descriptor.nonsymbolic) {
    for (const [code, name] of STANDARD_ENCODING.entries()) names[code] ??= name;
  }
  return { names, differences, problems };
};

/** A simple font's width for each code in glyph space, undefined for a code whose width is unknown; the whole is undefined when the font gives no widths. */
export type SimpleWidths = ((code: number) => number | undefined) | undefined;

/**
 * Widths from FirstChar, LastChar and Widths (Table 111): "For character codes outside the range FirstChar to LastChar, the value of MissingWidth from the FontDescriptor entry for this font shall be used"; for a Type 3 font "the width shall be 0" there (Table 112).
 */
export const simpleWidths = ({ source, font, subtype, descriptor }: SimpleFontInput): SimpleWidths => {
  const widths = numbersOf(source, font.get(WIDTHS));
  const first = numberOf(source.objects.deref(font.get(FIRST_CHAR)));
  if (widths === undefined || first === undefined) return undefined;
  const lastChar = numberOf(source.objects.deref(font.get(LAST_CHAR))) ?? Number.POSITIVE_INFINITY;
  const last = Math.min(lastChar, first + widths.length - 1);
  const outside = subtype === 'Type3' ? 0 : descriptor.missingWidth;
  return code => (code >= first && code <= last ? (widths[code - first] ?? outside) : outside);
};
