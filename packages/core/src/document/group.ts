import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { PieceInfoInput, PieceInfoRecord } from './pieceInfo.ts';
import type { PdfRect } from './rect.ts';

import { pdfDateObject } from '../date/pdfDate.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { formatLength } from '../length/length.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfName, pdfReal } from '../object/pdfObject.ts';

import { rect } from './rect.ts';

export interface GroupOptions {
  bbox: PdfRect;
  isolated?: boolean;
  knockout?: boolean;
  colorSpace?: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray';
}

/** A transparency group form XObject created by, and usable only in, the document that returned it. */
export interface PdfGroup {
  readonly kind: 'PdfGroup';
  readonly pieceInfo: (input: PieceInfoInput) => void;
}

export interface GroupAttributes {
  readonly bbox: PdfRect;
  readonly isolated: boolean;
  readonly knockout: boolean;
  readonly colorSpace: 'DeviceCMYK' | 'DeviceRGB' | 'DeviceGray' | undefined;
}

export const groupAttributes = (options: GroupOptions, fractionDigits: number): GroupAttributes => {
  if (options.colorSpace !== undefined && options.isolated !== true) throw new ValidationError('a transparency group colour space requires isolated: true');
  const bbox = rect(...options.bbox);
  const [left, bottom, right, top] = bbox.map(value => Number(formatLength(value, fractionDigits)));
  if (left === undefined || bottom === undefined || right === undefined || top === undefined || left >= right || bottom >= top) {
    throw new ValidationError('transparency group bounding box must have non-zero area after rounding');
  }
  return { bbox, isolated: options.isolated ?? false, knockout: options.knockout ?? false, colorSpace: options.colorSpace };
};

// ISO 32000-1:2008, 8.10.2, Table 95 defines form XObjects; 11.6.6, Table 147 defines transparency group attributes.
export const groupObject = (
  ...[group, content, resources, pieceInfo]: [GroupAttributes, Uint8Array, PdfDirectObject, PieceInfoRecord | undefined]
): PdfObject => {
  const attributes = new PdfDictionaryEntries([
    [pdfName('S').bytes, pdfName('Transparency')],
    [pdfName('I').bytes, { kind: 'boolean', value: group.isolated }],
    [pdfName('K').bytes, { kind: 'boolean', value: group.knockout }],
  ]);
  if (group.colorSpace !== undefined) attributes.set(pdfName('CS').bytes, pdfName(group.colorSpace));
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('XObject')],
    [pdfName('Subtype').bytes, pdfName('Form')],
    [pdfName('BBox').bytes, pdfArray(group.bbox.map(length => pdfReal(length)))],
    [pdfName('Resources').bytes, resources],
    [pdfName('Group').bytes, pdfDictionary(attributes)],
    [pdfName('Filter').bytes, pdfName('FlateDecode')],
  ]);
  if (pieceInfo !== undefined) {
    dictionary.set(pdfName('LastModified').bytes, pdfDateObject(pieceInfo.lastModified));
    dictionary.set(pdfName('PieceInfo').bytes, pieceInfo.value);
  }
  return { kind: 'stream', dictionary, data: deflateZlib(content) };
};
