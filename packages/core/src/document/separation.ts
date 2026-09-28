import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { DeviceColor } from './color.ts';

import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfNameFromBytes, pdfReal } from '../object/pdfObject.ts';

import { cmyk, gray, rgb } from './color.ts';

/** A colorant name in text or raw bytes and its alternate colour; `All` and `None` require matching `allow` or raise ValidationError reason `reserved-colorant`, and optional ASCII policy raises `colorant-ascii-only` under ISO 32000-1:2008, 8.6.6.4. */
export interface SeparationOptions {
  /** Colorant name as text or encoded PDF name bytes. */
  name: string | Uint8Array;
  /** Alternate colour for viewers without the spot plate. */
  alternate: DeviceColor;
  /** Explicitly permits the reserved All or None colorant name. */
  allow?: 'All' | 'None';
}

/** A Separation colour space created by, and usable only in, the document that returned it. */
export interface Separation {
  readonly kind: 'Separation';
}

export interface SeparationRecord {
  readonly name: Uint8Array;
  readonly alternate: DeviceColor;
}

const copyColor = (color: DeviceColor): DeviceColor => {
  if (color.kind === 'DeviceCMYK') return cmyk(...color.components);
  if (color.kind === 'DeviceRGB') return rgb(...color.components);
  return gray(color.components[0]);
};

export const colorantKey = (name: Uint8Array): string => [...name].map(byte => byte.toString(16).padStart(2, '0')).join('');

export const createSeparationRecord = (options: SeparationOptions, asciiOnly: boolean): SeparationRecord => {
  // ISO 32000-1:2008, 7.3.5 treats name bytes as UTF-8 text; callers can pass encoded bytes for a different naming convention.
  const name = typeof options.name === 'string' ? new TextEncoder().encode(options.name) : Uint8Array.from(options.name);
  pdfNameFromBytes(name);
  if (asciiOnly && [...name].some(byte => byte < 0x21 || byte > 0x7e)) {
    throw new ValidationError('colorant policy requires printable ASCII name bytes', 'colorant-ascii-only');
  }
  const text = new TextDecoder().decode(name);
  // ISO 32000-1:2008, 8.6.6.4 reserves All and None as special colorant names with defined output semantics.
  if ((text === 'All' || text === 'None') && options.allow !== text) {
    throw new ValidationError(`${text} requires an explicit allow option`, 'reserved-colorant');
  }
  if (options.allow !== undefined && text !== options.allow) throw new ValidationError('allow must match the special colorant name', 'reserved-colorant');
  return { name, alternate: copyColor(options.alternate) };
};

// ISO 32000-1:2008, 8.6.6.4 defines the four-element Separation array; 7.10.2 Tables 38 and 40 define the type 2 tint function.
export const separationObject = (separation: SeparationRecord): PdfDirectObject => {
  const { alternate } = separation;
  const noInk = { DeviceCMYK: [0, 0, 0, 0], DeviceRGB: [1, 1, 1], DeviceGray: [1] }[alternate.kind];
  const functionEntries = new PdfDictionaryEntries([
    [pdfName('FunctionType').bytes, pdfInteger(2)],
    [pdfName('Domain').bytes, pdfArray([pdfInteger(0), pdfInteger(1)])],
    [pdfName('C0').bytes, pdfArray(noInk.map(value => pdfReal(value)))],
    [pdfName('C1').bytes, pdfArray([...alternate.components].map(value => pdfReal(value)))],
    [pdfName('N').bytes, pdfInteger(1)],
  ]);
  return pdfArray([pdfName('Separation'), pdfNameFromBytes(separation.name), pdfName(alternate.kind), pdfDictionary(functionEntries)]);
};
