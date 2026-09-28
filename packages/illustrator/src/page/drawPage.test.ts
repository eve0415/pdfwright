import type { IllustratorDocument, PathItem } from '../model/illustratorDocument.ts';

import { createDocument, inflateZlib, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { drawPage } from './drawPage.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const path: PathItem = {
  kind: 'path',
  geometry: {
    start: [10, 10],
    segments: [
      { kind: 'line', to: [40, 10] },
      { kind: 'line', to: [40, 30] },
      { kind: 'line', to: [10, 30] },
    ],
  },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } },
  stroke: { paint: { kind: 'spot', spot: { name: 'Cut', alternate: [0, 1, 0, 0] } }, width: 0 },
};

describe('visible Illustrator page', () => {
  it('places paths and clips in a bleed-offset CMYK page', () => {
    const model: IllustratorDocument = {
      artboard: { width: 100, height: 70, bleed: 3 },
      layers: [
        { name: 'Hidden', visible: false, items: [{ ...path, geometry: { start: [99, 99], segments: [{ kind: 'line', to: [100, 99] }] } }] },
        { name: 'Visible', items: [{ kind: 'clipGroup', clip: path.geometry, items: [path] }] },
      ],
      lastModified: date,
    };
    const document = createDocument();
    drawPage(document, model);
    const bytes = document.save().toBytes();
    const pdf = new TextDecoder('latin1').decode(bytes);
    const start = pdf.indexOf('\nstream\n', pdf.indexOf('/Filter/FlateDecode')) + 8;
    const end = pdf.indexOf('\nendstream', start);
    const content = new TextDecoder().decode(inflateZlib(bytes.subarray(start, end)).data);
    expect(pdf).toContain('/MediaBox[0 0 106 76]');
    expect(pdf).toContain('/TrimBox[3 3 103 73]');
    expect(content).toContain('0 w\n');
    expect(content).toContain('B\n');
    expect(content).toContain('W\nn\n');
  });

  it('shares one alpha stencil across spot plates and draws a CMYK image', () => {
    const alpha = new Uint8Array([255, 128, 0]);
    const bounds = { x: 0, y: 0, width: 30, height: 10 };
    const white = { name: 'White', alternate: [0, 0, 0, 0.1] } as const;
    const primer = { name: 'Primer', alternate: [0, 0, 0, 0.2] } as const;
    const model: IllustratorDocument = {
      artboard: { width: 50, height: 40 },
      lastModified: date,
      layers: [
        { name: 'White', items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: white }, alpha }] },
        { name: 'Primer', items: [{ kind: 'raster', width: 3, height: 1, bounds, color: { space: 'spot', spot: primer }, alpha }] },
        {
          name: 'Design',
          items: [
            { kind: 'raster', width: 1, height: 1, bounds, color: { space: 'cmyk', samples: new Uint8Array([0, 10, 20, 30]) }, alpha: new Uint8Array([255]) },
          ],
        },
      ],
    };
    const document = createDocument();
    drawPage(document, model);
    const pdf = new TextDecoder('latin1').decode(document.save().toBytes());
    expect(pdf.match(/\/ImageMask true/gu)).toHaveLength(1);
    expect(pdf).toContain('/SMask');
    expect(pdf).toContain('/ColorSpace/DeviceCMYK');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Primer');
  });
});
