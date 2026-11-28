import type { DocumentInternals } from '../../document/documentInternals.ts';
import type { LoadOptions } from '../../document/loadDocument.ts';
import type { PdfObject } from '../../object/pdfObject.ts';
import type { TestObject } from '../../testing/pdfBuilder.ts';

import { internalsOf } from '../../document/documentInternals.ts';
import { loadDocument } from '../../document/loadDocument.ts';
import { pdfReference } from '../../object/pdfObject.ts';
import { buildPdf } from '../../testing/pdfBuilder.ts';

/** The internals of a document with an empty page tree as objects 1 and 2 and the given objects beside them. */
export const fontDocument = (objects: ReadonlyArray<TestObject> = [], options: LoadOptions = {}): DocumentInternals => {
  const loaded = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' }, { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }, ...objects],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
    options,
  );
  const parts = internalsOf(loaded);
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

/** Object 10 of a document holding `body` as object 10 and `objects` beside it, with the document it was read from. */
export const objectIn = (body: string, objects: ReadonlyArray<TestObject> = []): { readonly document: DocumentInternals; readonly object: PdfObject } => {
  const document = fontDocument([{ number: 10, body }, ...objects]);
  const object = document.objects.deref(pdfReference(10, 0));
  if (object === undefined) {
    throw new Error('object 10 is missing');
  }
  return { document, object };
};
