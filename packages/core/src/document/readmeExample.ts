import type { SavedPdf } from '@pdfwright/core';

import { cmyk, createDocument, mm, pdfDate, rect } from '@pdfwright/core';

export const writePrintPage = (): SavedPdf => {
  const document = createDocument({
    info: { title: 'White ink proof', modificationDate: pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' }) },
  });
  const white = document.separation({ name: 'White', alternate: cmyk(0, 0, 0, 0.1) });
  const cut = document.separation({ name: 'Cut', alternate: cmyk(0, 0, 0, 0.5) });
  const page = document.addPage({
    mediaBox: rect(mm(0), mm(0), mm(100), mm(60)),
    bleedBox: rect(mm(2), mm(2), mm(98), mm(58)),
    trimBox: rect(mm(5), mm(5), mm(95), mm(55)),
  });
  page.draw(content => {
    content.fillColor(white, 1);
    content.path(path => path.rect(mm(10), mm(10), mm(80), mm(40)));
    content.fill('nonzero');
    content.strokeColor(cut, 1);
    content.lineWidth(0);
    content.path(path => path.rect(mm(5), mm(5), mm(90), mm(50)));
    content.stroke();
  });
  return document.save();
};
