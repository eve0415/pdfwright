import type { PdfObject } from '../object/pdfObject.ts';

export interface AnnotationFlags {
  readonly hidden: boolean;
  readonly print: boolean;
  /** Whether the annotation prints: Print set and Hidden clear. */
  readonly printable: boolean;
}

const WORD = 2 ** 32;

// ISO 32000-1:2008, 12.5.3: "Bit positions within the flag word shall be numbered from low-order to high-order, with the lowest-order bit numbered 1."
const bit = (flags: number, position: number): boolean => Math.floor(flags / 2 ** (position - 1)) % 2 === 1;

/**
 * Reads an annotation's F entry; an absent or non-integer value reads as 0, all flags clear, and a negative integer as its 32-bit two's complement.
 * ISO 32000-1:2008, 12.5.3, Table 165: bit 2 Hidden, "If set, do not display or print the annotation", and bit 3 Print, "If set, print the annotation when the page is printed. If clear, never print the annotation".
 */
export const annotationFlags = (value?: PdfObject): AnnotationFlags => {
  const flags = value?.kind === 'integer' ? ((value.value % WORD) + WORD) % WORD : 0;
  const hidden = bit(flags, 2);
  const print = bit(flags, 3);
  return { hidden, print, printable: print && !hidden };
};
