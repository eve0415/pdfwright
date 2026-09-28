import type { PdfObject } from '../object/pdfObject.ts';
import type { Separation, SeparationRecord } from './separation.ts';

import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';

import { separationObject } from './separation.ts';

export type ImageColorSpace = 'DeviceRGB' | 'DeviceCMYK' | 'DeviceGray' | Separation;

export interface ImageOptions {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Colour space of the supplied samples. */
  colorSpace: ImageColorSpace;
  /** Eight bits per component for supplied samples. */
  bitsPerComponent: 8;
  /** One byte per component, width × height × components long, else ValidationError; for a Separation space each byte is an ink amount, 255 meaning tint 1 (ISO 32000-1:2008, 8.9.5.2 and 8.6.6.4, NOTE 5). */
  samples: Uint8Array;
  /** Optional grayscale alpha samples with the same pixel dimensions. */
  softMask?: { width: number; height: number; samples: Uint8Array };
}

/** An image XObject created by, and usable only in, the document that returned it. */
export interface PdfImage {
  readonly kind: 'PdfImage';
}

export interface SoftMaskRecord {
  readonly width: number;
  readonly height: number;
  readonly samples: Uint8Array;
}

export interface ImageRecord {
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'DeviceRGB' | 'DeviceCMYK' | 'DeviceGray' | SeparationRecord;
  readonly samples: Uint8Array;
  readonly softMask: SoftMaskRecord | undefined;
}

const validDimension = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export const createImageRecord = (options: ImageOptions, resolveSeparation: (separation: Separation) => SeparationRecord): ImageRecord => {
  // ISO 32000-1:2008, 8.9.5.1, Table 89 defines image dimensions, colour space, and bits per component.
  const { width, height, colorSpace, samples, softMask } = options;
  if (!validDimension(width) || !validDimension(height)) throw new ValidationError('image dimensions must be positive integers');
  const channels = { DeviceRGB: 3, DeviceCMYK: 4, DeviceGray: 1 }[typeof colorSpace === 'string' ? colorSpace : 'DeviceGray'];
  if (samples.length !== width * height * channels) throw new ValidationError('image sample length does not match dimensions and colour space');
  if (
    softMask !== undefined &&
    (!validDimension(softMask.width) || !validDimension(softMask.height) || softMask.samples.length !== softMask.width * softMask.height)
  ) {
    throw new ValidationError('soft mask sample length does not match its dimensions');
  }
  return {
    width,
    height,
    colorSpace: typeof colorSpace === 'string' ? colorSpace : resolveSeparation(colorSpace),
    samples: Uint8Array.from(samples),
    softMask: softMask === undefined ? undefined : { width: softMask.width, height: softMask.height, samples: Uint8Array.from(softMask.samples) },
  };
};

// ISO 32000-1:2008, 8.9.5.1, Table 89 defines image XObject dictionaries; 11.6.5, Table 145 requires a grayscale soft-mask image.
export const imageObject = (image: ImageRecord, softMaskObjectNumber?: number): PdfObject => {
  const colorSpace = typeof image.colorSpace === 'string' ? pdfName(image.colorSpace) : separationObject(image.colorSpace);
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('XObject')],
    [pdfName('Subtype').bytes, pdfName('Image')],
    [pdfName('Width').bytes, pdfInteger(image.width)],
    [pdfName('Height').bytes, pdfInteger(image.height)],
    [pdfName('ColorSpace').bytes, colorSpace],
    [pdfName('BitsPerComponent').bytes, pdfInteger(8)],
    [pdfName('Filter').bytes, pdfName('FlateDecode')],
  ]);
  if (typeof image.colorSpace !== 'string') {
    // ISO 32000-1:2008, 8.9.5.2 and 8.6.6.4 NOTE 5: Separation samples are ink amounts, with 255 mapping to tint 1.
    dictionary.set(pdfName('Decode').bytes, pdfArray([pdfInteger(0), pdfInteger(1)]));
  }
  if (softMaskObjectNumber !== undefined) dictionary.set(pdfName('SMask').bytes, pdfReference(softMaskObjectNumber, 0));
  return { kind: 'stream', dictionary, data: deflateZlib(image.samples) };
};

export const softMaskObject = (mask: SoftMaskRecord): PdfObject => {
  const dictionary = new PdfDictionaryEntries([
    [pdfName('Type').bytes, pdfName('XObject')],
    [pdfName('Subtype').bytes, pdfName('Image')],
    [pdfName('Width').bytes, pdfInteger(mask.width)],
    [pdfName('Height').bytes, pdfInteger(mask.height)],
    [pdfName('ColorSpace').bytes, pdfName('DeviceGray')],
    [pdfName('BitsPerComponent').bytes, pdfInteger(8)],
    [pdfName('Filter').bytes, pdfName('FlateDecode')],
  ]);
  return { kind: 'stream', dictionary, data: deflateZlib(mask.samples) };
};
