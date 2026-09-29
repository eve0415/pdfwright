import type { Core14Font } from './core14Metrics.ts';
import type { Rectangle } from './fontModel.ts';

import { CORE14_FONTS, CORE14_LATIN_NAMES } from './core14Metrics.ts';

// ISO 32000-1:2008, 9.6.2.2: "The PostScript names of 14 Type 1 fonts, known as the standard 14 fonts, are as follows: Times-Roman, Helvetica, Courier, Symbol, Times-Bold, Helvetica-Bold, Courier-Bold, ZapfDingbats, Times-Italic, Helvetica-Oblique, Courier-Oblique, Times-BoldItalic, Helvetica-BoldOblique, Courier-BoldOblique".
export const STANDARD_14: ReadonlySet<string> = new Set([
  'Times-Roman',
  'Helvetica',
  'Courier',
  'Symbol',
  'Times-Bold',
  'Helvetica-Bold',
  'Courier-Bold',
  'ZapfDingbats',
  'Times-Italic',
  'Helvetica-Oblique',
  'Courier-Oblique',
  'Times-BoldItalic',
  'Helvetica-BoldOblique',
  'Courier-BoldOblique',
]);

/** A standard 14 font's metrics from the bundled AFM data: each glyph name's width in glyph space, and the FontBBox. */
export interface Standard14Metrics {
  readonly width: (glyphName: string) => number | undefined;
  readonly bbox: Rectangle;
}

const fonts = new Map<string, Core14Font>(Object.entries(CORE14_FONTS));
const parsed = new Map<string, Standard14Metrics>();

/** The metrics of a standard 14 font by its exact PostScript name, or undefined for any other name. */
export const standard14Metrics = (name: string): Standard14Metrics | undefined => {
  const known = parsed.get(name);
  if (known !== undefined) return known;
  const font = STANDARD_14.has(name) ? fonts.get(name) : undefined;
  if (font === undefined) return undefined;
  const names = (font.names ?? CORE14_LATIN_NAMES).split(' ');
  const widths = font.widths.split(' ').map(Number);
  const table = new Map(names.map((glyph, index) => [glyph, widths[index] ?? 0]));
  const metrics: Standard14Metrics = { width: glyph => table.get(glyph), bbox: font.bbox };
  parsed.set(name, metrics);
  return metrics;
};
