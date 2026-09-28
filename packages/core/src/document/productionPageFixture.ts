import type { PdfDate } from '../date/pdfDate.ts';
import type { SavedPdf } from '../write/savedPdf.ts';

import { pdfDate } from '../date/pdfDate.ts';
import { mm, pt } from '../length/length.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';

import { cmyk } from './color.ts';
import { createDocument } from './pdfDocument.ts';
import { rect } from './rect.ts';

export interface ProductionPageFixture {
  saved: SavedPdf;
  lastModified: PdfDate;
  whiteName: Uint8Array;
  primerName: Uint8Array;
  cutName: Uint8Array;
  foldName: Uint8Array;
}

export const createProductionPage = (): ProductionPageFixture => {
  const lastModified = pdfDate({ year: 2024, month: 3, day: 2, hour: 1, minute: 4, second: 5, offset: 'Z' });
  const document = createDocument({ info: { title: 'Print page', modificationDate: lastModified } });
  const whiteName = new TextEncoder().encode('White');
  const primerName = new TextEncoder().encode('Primer');
  const cutName = new Uint8Array([0x82, 0x62, 0x82, 0x74, 0x82, 0x73]);
  const foldName = new Uint8Array([0x82, 0x65, 0x82, 0x6e, 0x82, 0x6b, 0x82, 0x63]);
  const white = document.separation({ name: whiteName, alternate: cmyk(0, 0, 0, 0.1) });
  const primer = document.separation({ name: primerName, alternate: cmyk(0, 0, 0, 0.2) });
  const cut = document.separation({ name: cutName, alternate: cmyk(0, 0, 0, 0.5) });
  const fold = document.separation({ name: foldName, alternate: cmyk(0, 0, 0, 0.5) });

  const artwork = document.image({
    width: 1,
    height: 1,
    colorSpace: 'DeviceRGB',
    bitsPerComponent: 8,
    samples: new Uint8Array([255, 0, 0]),
    softMask: { width: 1, height: 1, samples: new Uint8Array([128]) },
  });
  const mask = { width: 3, height: 1, samples: new Uint8Array([255, 128, 0]) };
  const plateImage = document.image({ width: 3, height: 1, colorSpace: 'ImageMask', bitsPerComponent: 1, samples: new Uint8Array([0xc0]), softMask: mask });
  const primerGroup = document.group({ bbox: rect(pt(0), pt(0), mm(30), mm(10)), isolated: true, colorSpace: 'DeviceCMYK' }, content => {
    content.graphicsState({ fillAlpha: 0.3 });
    content.fillColor(primer, 1);
    content.image(plateImage, [mm(30), 0, 0, mm(10), 0, 0]);
  });

  const page = document.addPage({
    mediaBox: rect(mm(0), mm(0), mm(50), mm(40)),
    bleedBox: rect(mm(3), mm(3), mm(47), mm(37)),
    trimBox: rect(mm(5), mm(5), mm(45), mm(35)),
    group: { colorSpace: 'DeviceCMYK' },
  });
  const privateData = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: new TextEncoder().encode('print page private data') });
  page.pieceInfo({ lastModified, data: { Illustrator: { private: privateData } } });
  page.draw(content => {
    const clipped = (render: () => void): void => {
      content.save();
      content.path(path => path.rect(mm(5), mm(5), mm(40), mm(30)));
      content.clip('nonzero');
      render();
      content.restore();
    };
    clipped(() => {
      content.image(artwork, [mm(50), 0, 0, mm(40), 0, 0]);
    });
    clipped(() => {
      content.fillColor(white, 1);
      content.image(plateImage, [mm(30), 0, 0, mm(10), mm(10), mm(10)]);
    });
    clipped(() => {
      content.group(primerGroup, [1, 0, 0, 1, mm(10), mm(20)]);
    });
    clipped(() => {
      content.lineWidth(0);
      content.strokeColor(cut, 1);
      content.path(path => path.rect(mm(5), mm(5), mm(40), mm(30)));
      content.stroke();
    });
    clipped(() => {
      content.lineWidth(0);
      content.strokeColor(fold, 1);
      content.path(path => path.rect(mm(6), mm(6), mm(38), mm(28)));
      content.stroke();
    });
  });
  return { saved: document.save(), lastModified, whiteName, primerName, cutName, foldName };
};
