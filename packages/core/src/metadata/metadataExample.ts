import type { DocumentMetadata, MetadataChange } from '@pdfwright/core';

import { createDocument, loadDocument, pdfDate, pt, readMetadata, rect, setMetadata } from '@pdfwright/core';

export interface MetadataExample {
  readonly before: DocumentMetadata;
  readonly after: DocumentMetadata;
  readonly change: MetadataChange;
  readonly identicalBytes: boolean;
}

export const updateMetadata = (): MetadataExample => {
  const date = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' });
  const created = createDocument({ info: { title: 'Original title', modificationDate: date } });
  created.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  const document = loadDocument(created.save().toBytes());
  const before = readMetadata(document);
  const change = setMetadata(document, { title: 'Revised title', modificationDate: date });
  const first = document.save().toBytes();
  const second = document.save().toBytes();
  const after = readMetadata(loadDocument(first));
  const identicalBytes = first.length === second.length && first.every((value, index) => value === second[index]);
  return { before, after, change, identicalBytes };
};
