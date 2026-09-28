import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { ConvertedInlineImage } from './convertInlineImage.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName } from '../object/pdfObject.ts';

export interface NamedInlineImage extends ConvertedInlineImage {
  readonly name: string;
}

const XOBJECT = pdfName('XObject').bytes;

export const addInlineXObjects = (document: LoadedDocument, resources: PdfDictionaryEntries, images: readonly NamedInlineImage[]): void => {
  if (images.length === 0) return;
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const category = internals.objects.deref(resources.get(XOBJECT));
  const mapped = category?.kind === 'dictionary' ? new PdfDictionaryEntries(category.entries.entries()) : new PdfDictionaryEntries();
  for (const image of images) {
    const name = pdfName(image.name).bytes;
    if (mapped.has(name)) throw new ValidationError('inline image resource name is already in use', 'color-space');
    let colorSpace: PdfDirectObject = pdfName('DeviceCMYK');
    if (image.keptProfile !== undefined) {
      const profileDictionary = new PdfDictionaryEntries([[pdfName('N').bytes, pdfInteger(3)]]);
      const profile = document.object({ kind: 'stream', dictionary: profileDictionary, data: image.keptProfile });
      colorSpace = pdfArray([pdfName('ICCBased'), profile]);
    }
    const dictionary = new PdfDictionaryEntries([
      [pdfName('Type').bytes, pdfName('XObject')],
      [pdfName('Subtype').bytes, pdfName('Image')],
      [pdfName('Width').bytes, pdfInteger(image.width)],
      [pdfName('Height').bytes, pdfInteger(image.height)],
      [pdfName('BitsPerComponent').bytes, pdfInteger(image.bits)],
      [pdfName('ColorSpace').bytes, colorSpace],
      [pdfName('Filter').bytes, image.keptFilter ?? pdfName('FlateDecode')],
    ]);
    if (image.keptDecodeParms !== undefined) dictionary.set(pdfName('DecodeParms').bytes, image.keptDecodeParms);
    const reference =
      image.produce === undefined
        ? document.object({ kind: 'stream', dictionary, data: image.data })
        : internals.objects.addProduced(dictionary, image.produce);
    mapped.set(name, reference);
  }
  resources.set(XOBJECT, pdfDictionary(mapped));
};
