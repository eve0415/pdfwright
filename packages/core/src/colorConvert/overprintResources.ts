import type { LoadedDocument } from '../document/loadDocument.ts';
import type { OverprintNames } from './rewriteContent.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfInteger, pdfName } from '../object/pdfObject.ts';

const EXT_G_STATE = pdfName('ExtGState').bytes;
const OPM = pdfName('OPM').bytes;

export const chooseOverprintNames = (document: LoadedDocument, resources: PdfDictionaryEntries): OverprintNames => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const category = internals.objects.deref(resources.get(EXT_G_STATE));
  const entries = category?.kind === 'dictionary' ? category.entries : undefined;
  for (let index = 0; ; index += 2) {
    const off = `PWOPM${String(index)}`;
    const on = `PWOPM${String(index + 1)}`;
    if (entries?.has(pdfName(off).bytes) !== true && entries?.has(pdfName(on).bytes) !== true) return { off, on };
  }
};

export const addOverprintStates = (document: LoadedDocument, resources: PdfDictionaryEntries, names: OverprintNames): void => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const category = internals.objects.deref(resources.get(EXT_G_STATE));
  const states = category?.kind === 'dictionary' ? new PdfDictionaryEntries(category.entries.entries()) : new PdfDictionaryEntries();
  const off = pdfDictionary(new PdfDictionaryEntries([[OPM, pdfInteger(0)]]));
  const on = pdfDictionary(new PdfDictionaryEntries([[OPM, pdfInteger(1)]]));
  states.set(pdfName(names.off).bytes, off);
  states.set(pdfName(names.on).bytes, on);
  resources.set(EXT_G_STATE, pdfDictionary(states));
};
