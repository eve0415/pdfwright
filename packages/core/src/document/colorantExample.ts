import type { PageColorants, SavedPdf } from '@pdfwright/core';

import { ValidationError, cmyk, createDocument, listColorants, loadDocument, pt, rect } from '@pdfwright/core';

export interface ColorantExample {
  readonly saved: SavedPdf;
  readonly colorants: PageColorants['colorants'];
  readonly whiteOverprintReason: string | undefined;
}

export const writeColorants = (): ColorantExample => {
  const document = createDocument();
  const rawName = Uint8Array.of(0x82, 0xa0);
  const spot = document.separation({ name: rawName, alternate: cmyk(0, 0, 0, 0.2) });
  const all = document.separation({ name: 'All', alternate: cmyk(0, 0, 0, 0.2), allow: 'All' });
  const none = document.separation({ name: 'None', alternate: cmyk(0, 0, 0, 0), allow: 'None' });
  const page = document.addPage({ mediaBox: rect(pt(0), pt(0), pt(100), pt(100)) });
  page.draw(content => {
    for (const [plate, x] of [
      [spot, 10],
      [all, 40],
      [none, 70],
    ] as const) {
      content.fillColor(plate, 1);
      content.path(path => path.rect(x, 10, 20, 20));
      content.fill('nonzero');
    }
  });
  const probe = createDocument();
  const probePage = probe.addPage({ mediaBox: rect(pt(0), pt(0), pt(10), pt(10)) });
  let whiteOverprintReason: string | undefined = undefined;
  try {
    probePage.draw(content => {
      content.fillColor(cmyk(0, 0, 0, 0));
      content.graphicsState({ overprintFill: true, overprintMode: 1 });
      content.path(path => path.rect(0, 0, 10, 10));
      content.fill('nonzero');
    });
  } catch (error: unknown) {
    if (!(error instanceof ValidationError)) throw error;
    whiteOverprintReason = error.reason;
  }
  const saved = document.save();
  const colorants = listColorants(loadDocument(saved.toBytes()))[0]?.colorants ?? [];
  return { saved, colorants, whiteOverprintReason };
};
