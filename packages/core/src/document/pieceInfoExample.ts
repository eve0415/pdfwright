import type { SavedPdf } from '@pdfwright/core';

import { createDocument, loadDocument, pdfDate, pdfString, pt, rect, serializeObject } from '@pdfwright/core';

export interface PieceInfoExample {
  readonly saved: SavedPdf;
  readonly retained: boolean;
}

export const preservePagePieceData = (): PieceInfoExample => {
  const date = pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' });
  const document = createDocument();
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  const applicationName = Uint8Array.of(0x82, 0xa0);
  const privateValue = pdfString(Uint8Array.of(1, 2, 3), 'hex');
  page.pieceInfo({
    lastModified: date,
    data: new Map([[applicationName, { private: privateValue }]]),
  });
  const loaded = loadDocument(document.save().toBytes());
  const original = loaded.page(0).pieceInfo();
  loaded.page(0).setBox('TrimBox', rect(pt(5), pt(5), pt(95), pt(95)));
  const saved = loaded.save();
  const preserved = loadDocument(saved.chunks).page(0).pieceInfo();
  if (original === undefined || preserved === undefined) throw new Error('page-piece data is missing');
  const before = serializeObject(original, { fractionDigits: 5 });
  const after = serializeObject(preserved, { fractionDigits: 5 });
  return { saved, retained: before.length === after.length && before.every((value, index) => value === after[index]) };
};
