import type { PdfDifference, SavedPdf } from '@pdfwright/core';

import { cmyk, compareDocuments, loadDocument, mm, rect } from '@pdfwright/core';

export interface VarnishEdit {
  readonly saved: SavedPdf;
  readonly differences: readonly PdfDifference[];
}

export const addVarnishPlate = (input: Uint8Array): VarnishEdit => {
  const document = loadDocument(input);
  const varnish = document.separation({ name: 'Varnish', alternate: cmyk(0, 0, 0.2, 0) });
  const page = document.page(0);
  page.setBox('TrimBox', rect(mm(6), mm(6), mm(94), mm(54)));
  page.appendContent(content => {
    content.fillColor(varnish, 1);
    content.path(path => path.rect(mm(10), mm(10), mm(80), mm(40)));
    content.fill('nonzero');
  });
  const saved = document.save();
  const { differences } = compareDocuments(loadDocument(input), loadDocument(saved.chunks));
  return { saved, differences };
};
