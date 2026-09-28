import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { SampledCmykFunction } from './sampleCmykFunction.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName } from '../object/pdfObject.ts';

export interface StitchedCmykFunction {
  readonly kind: 'stitched';
  readonly dictionary: PdfDictionaryEntries;
  readonly functions: readonly SampledCmykFunction[];
}

export type ConvertedCmykFunction = SampledCmykFunction | StitchedCmykFunction;

/** Keeps Domain, Bounds and Encode while replacing each Type 3 child with a sampled CMYK function. */
export const stitchCmykFunction = (document: LoadedDocument, source: PdfObject, compose: (child: PdfObject) => SampledCmykFunction): StitchedCmykFunction => {
  if (source.kind !== 'dictionary') throw new ValidationError('stitching function is not a dictionary', 'color-space');
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const children = source.entries.get(pdfName('Functions').bytes);
  if (children?.kind !== 'array' || children.items.length === 0) throw new ValidationError('stitching function has no subfunctions', 'color-space');
  const functions: SampledCmykFunction[] = [];
  for (const item of children.items) {
    const child = internals.objects.deref(item);
    if (child === undefined || child.kind === 'null') throw new ValidationError('stitching subfunction is missing', 'color-space');
    functions.push(compose(child));
  }
  const dictionary = new PdfDictionaryEntries(source.entries.entries());
  // ISO 32000-1:2008, 7.10.4 Table 41: the wrapper's Bounds and Encode still select its subfunctions.
  dictionary.set(pdfName('Range').bytes, pdfArray([0, 1, 0, 1, 0, 1, 0, 1].map(value => pdfInteger(value))));
  return { kind: 'stitched', dictionary, functions };
};

export const writeCmykFunction = (document: LoadedDocument, converted: ConvertedCmykFunction): PdfReference => {
  if (converted.kind === 'sampled') return document.object({ kind: 'stream', dictionary: converted.dictionary, data: converted.data });
  const functions = converted.functions.map(item => document.object({ kind: 'stream', dictionary: item.dictionary, data: item.data }));
  const entries = new PdfDictionaryEntries(converted.dictionary.entries());
  entries.set(pdfName('Functions').bytes, pdfArray(functions));
  return document.object(pdfDictionary(entries));
};
