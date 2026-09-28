import type { Length } from '../length/length.ts';

import { compare } from '../length/length.ts';

/** Four exact lengths for opposite corners of a PDF rectangle, normalized by `rect` under ISO 32000-1:2008, 7.9.5. */
export type PdfRect = [Length, Length, Length, Length];

// ISO 32000-1:2008, 7.9.5 accepts any two diagonally opposite corners of a rectangle.
/** Normalizes a PDF rectangle from two opposite corners (ISO 32000-1:2008, 7.9.5). */
export const rect = (...[x1, y1, x2, y2]: PdfRect): PdfRect => [
  compare(x1, x2) <= 0 ? x1 : x2,
  compare(y1, y2) <= 0 ? y1 : y2,
  compare(x1, x2) <= 0 ? x2 : x1,
  compare(y1, y2) <= 0 ? y2 : y1,
];
