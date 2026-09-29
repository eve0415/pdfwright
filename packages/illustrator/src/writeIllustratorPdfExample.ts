import type { IllustratorDocument, PathGeometry, RasterItem, SpotColor } from './model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';

import { writeIllustratorPdf } from './writeIllustratorPdf.ts';

/** Writes die lines, white ink, primer, and CMYK artwork with one shared soft mask. */
export const writeIllustratorPdfExample = (): Uint8Array => {
  const die: PathGeometry = {
    start: [mm(5), mm(5)],
    segments: [
      { kind: 'line', to: [mm(45), mm(5)] },
      { kind: 'line', to: [mm(45), mm(35)] },
      { kind: 'line', to: [mm(5), mm(35)] },
    ],
  };
  const bounds = { x: mm(10), y: mm(10), width: mm(30), height: mm(10) };
  const alpha = Uint8Array.of(255, 128, 0);
  const white: SpotColor = { name: 'White', alternate: [0, 0, 0, 0.1] };
  const primer: SpotColor = { name: 'Primer', alternate: [0, 0, 0, 0.2] };
  const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
  const whiteImage: RasterItem = { kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: white }, alpha };
  const primerImage: RasterItem = { kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: primer }, alpha };
  const artwork: RasterItem = {
    kind: 'raster',
    width: 3,
    height: 1,
    bounds,
    color: { space: 'cmyk', samples: Uint8Array.of(0, 100, 20, 0, 20, 0, 100, 0, 0, 0, 0, 100) },
    alpha,
  };
  const document: IllustratorDocument = {
    artboard: { width: mm(50), height: mm(40), bleed: mm(3) },
    layers: [
      { name: 'Design', items: [{ kind: 'clipGroup', clip: die, items: [artwork] }] },
      { name: 'Primer', items: [{ kind: 'clipGroup', clip: die, items: [{ kind: 'group', opacity: 0.3, isolated: true, items: [primerImage] }] }] },
      { name: 'White', items: [{ kind: 'clipGroup', clip: die, items: [whiteImage] }] },
      { name: 'Die line', items: [{ kind: 'path', geometry: die, stroke: { paint: { kind: 'spot', spot: cut }, width: 0 } }] },
    ],
    lastModified: pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' }),
  };
  return writeIllustratorPdf(document);
};
