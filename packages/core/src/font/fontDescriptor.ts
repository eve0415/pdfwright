import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { VerticalExtent } from './fontModel.ts';
import type { FontSource } from './fontValues.ts';

import { pdfName } from '../object/pdfObject.ts';

import { dictionaryOf, numberOf, numbersOf } from './fontValues.ts';

const FLAGS = pdfName('Flags').bytes;
const MISSING_WIDTH = pdfName('MissingWidth').bytes;
const ASCENT = pdfName('Ascent').bytes;
const DESCENT = pdfName('Descent').bytes;
const FONT_BBOX = pdfName('FontBBox').bytes;
const FONT_DESCRIPTOR = pdfName('FontDescriptor').bytes;

/** The parts of a font descriptor (ISO 32000-1:2008, 9.8) that decoding and positioning use. */
export interface Descriptor {
  readonly dictionary: PdfDictionaryEntries | undefined;
  /** Table 123, bit 3 Symbolic: "Font contains glyphs outside the Adobe standard Latin character set." */
  readonly symbolic: boolean;
  /** Table 123, bit 6 Nonsymbolic: "Font uses the Adobe standard Latin character set or a subset of it." */
  readonly nonsymbolic: boolean;
  /** Table 122, MissingWidth, in glyph space; default 0. */
  readonly missingWidth: number;
}

const flagSet = (flags: number, bit: number): boolean => Math.floor(flags / 2 ** (bit - 1)) % 2 === 1;

export const readDescriptor = (source: FontSource, font: PdfDictionaryEntries): Descriptor => {
  const dictionary = dictionaryOf(source.objects.deref(font.get(FONT_DESCRIPTOR)));
  const flags = numberOf(source.objects.deref(dictionary?.get(FLAGS))) ?? 0;
  return {
    dictionary,
    symbolic: flagSet(flags, 3),
    nonsymbolic: flagSet(flags, 6),
    missingWidth: numberOf(source.objects.deref(dictionary?.get(MISSING_WIDTH))) ?? 0,
  };
};

// ISO 32000-1:2008, 7.9.5: "A rectangle shall be written as an array of four numbers giving the coordinates of a pair of diagonally opposite corners", so the y range is normalised; Chromium writes a Type 3 FontBBox with its top below its bottom.
// Table 112, FontBBox: "If all four elements of the rectangle are zero, a conforming reader shall make no assumptions about glyph sizes based on the font bounding box."
const boxExtent = (source: FontSource, value: PdfDirectObject | undefined): VerticalExtent | undefined => {
  const box = numbersOf(source, value);
  if (box?.length !== 4) return undefined;
  const [, y1 = 0, , y2 = 0] = box;
  if (box.every(number => number === 0) || y1 === y2) return undefined;
  return { descent: Math.min(y1, y2), ascent: Math.max(y1, y2), estimated: false };
};

/**
 * The vertical extent of a font's glyphs in glyph space: the descriptor's Descent and Ascent (Table 122) when both are present and Ascent is above Descent, else the y range of the descriptor's FontBBox or of `fontBBox` (a Type 3 font's own, Table 112), else [−200, 800], estimated.
 */
export const verticalExtent = (source: FontSource, descriptor: PdfDictionaryEntries | undefined, fontBBox?: PdfDirectObject): VerticalExtent => {
  const ascent = numberOf(source.objects.deref(descriptor?.get(ASCENT)));
  const descent = numberOf(source.objects.deref(descriptor?.get(DESCENT)));
  if (ascent !== undefined && descent !== undefined && ascent > descent) return { descent, ascent, estimated: false };
  return boxExtent(source, descriptor?.get(FONT_BBOX)) ?? boxExtent(source, fontBBox) ?? { descent: -200, ascent: 800, estimated: true };
};
