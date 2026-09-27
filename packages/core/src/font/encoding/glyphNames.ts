import { LATIN_PDF_DOC_CODES, pdfDocEncodingUnicode } from './simpleEncodings.ts';

const UPPER_HEX = /^[0-9A-F]+$/u;

const isScalar = (value: number): boolean => (value >= 0 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0x10ffff);

// Adobe Glyph List Specification, section 2: "if the component is of the form ‘uni’ … followed by a sequence of uppercase hexadecimal digits …, if the length of that sequence is a multiple of four, and if each group of four digits represents a value in the ranges 0000 through D7FF or E000 through FFFF, then interpret each as a Unicode scalar value".
const uniText = (digits: string): string | undefined => {
  if (digits.length === 0 || digits.length % 4 !== 0 || !UPPER_HEX.test(digits)) return undefined;
  let text = '';
  for (let index = 0; index < digits.length; index += 4) {
    const value = Number.parseInt(digits.slice(index, index + 4), 16);
    if (!isScalar(value)) return undefined;
    text += String.fromCodePoint(value);
  }
  return text;
};

// "if the component is of the form ‘u’ … followed by a sequence of four to six uppercase hexadecimal digits …, and those digits represents a value in the ranges 0000 through D7FF or E000 through 10FFFF, then interpret it as a Unicode scalar value".
const uText = (digits: string): string | undefined => {
  if (digits.length < 4 || digits.length > 6 || !UPPER_HEX.test(digits)) return undefined;
  const value = Number.parseInt(digits, 16);
  return isScalar(value) ? String.fromCodePoint(value) : undefined;
};

// ISO 32000-1:2008, Annex D: every Latin character name of D.2 has a PDFDocEncoding code, and D.3 gives each code's Unicode value.
const latinText = (name: string): string | undefined => {
  const code = LATIN_PDF_DOC_CODES.get(name);
  const unicode = code === undefined ? undefined : pdfDocEncodingUnicode(code);
  return unicode === undefined ? undefined : String.fromCodePoint(unicode);
};

const componentText = (component: string): string =>
  latinText(component) ??
  (component.startsWith('uni') ? uniText(component.slice(3)) : undefined) ??
  (component.startsWith('u') ? uText(component.slice(1)) : undefined) ??
  // "Otherwise, map the component to an empty string."
  '';

/**
 * The text a glyph name stands for, or undefined when it maps to nothing, by the Adobe Glyph List Specification, section 2: "Drop all the characters from the glyph name starting with the first occurrence of a period", "Split the remaining string into a sequence of components, using underscore … as the delimiter", and map each component.
 * A component is mapped by the Latin character set of ISO 32000-1:2008, Annex D, then by the `uni` and `u` forms.
 */
export const glyphNameText = (name: string): string | undefined => {
  const period = name.indexOf('.');
  const base = period === -1 ? name : name.slice(0, period);
  const text = base
    .split('_')
    .map(component => componentText(component))
    .join('');
  return text === '' ? undefined : text;
};
