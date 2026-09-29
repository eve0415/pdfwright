import type { Fill, IllustratorDocument, PathGeometry, PathItem, Stroke, Subpath } from '../model/illustratorDocument.ts';

import { createDocument, inflateZlib, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { drawPage } from './drawPage.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const outline: Subpath = {
  start: [10, 10],
  segments: [
    { kind: 'line', to: [40, 10] },
    { kind: 'line', to: [40, 30] },
    { kind: 'line', to: [10, 30] },
  ],
};
const fill: Fill = { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } };
const stroke: Stroke = { paint: { kind: 'spot', spot: { name: 'Cut', alternate: [0, 1, 0, 0] } }, width: 0 };
const path: PathItem = { kind: 'path', geometry: { subpaths: [outline] }, fill, stroke };

const pageContent = (model: IllustratorDocument): string => {
  const document = createDocument();
  drawPage(document, model);
  const bytes = document.save().toBytes();
  const pdf = new TextDecoder('latin1').decode(bytes);
  const start = pdf.indexOf('\nstream\n', pdf.indexOf('/Filter/FlateDecode')) + 8;
  const stream = bytes.subarray(start, pdf.indexOf('\nendstream', start));
  return new TextDecoder().decode(inflateZlib(stream).data);
};

describe('visible Illustrator page', () => {
  it('places paths and clips in a bleed-offset CMYK page', () => {
    const model: IllustratorDocument = {
      artboard: { width: 100, height: 70, bleed: 3 },
      layers: [
        { name: 'Hidden', visible: false, items: [{ ...path, geometry: { subpaths: [{ start: [99, 99], segments: [{ kind: 'line', to: [100, 99] }] }] } }] },
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

  it('draws every subpath of a compound path and clip into one path painted by its fill rule', () => {
    const hole: Subpath = { start: [20, 15], segments: [{ kind: 'quadratic', control: [26, 27], to: [32, 15] }] };
    const pieces: PathGeometry = { subpaths: [outline, hole] };
    const evenOdd: PathGeometry = { ...pieces, fillRule: 'evenodd' };
    const model: IllustratorDocument = {
      artboard: { width: 100, height: 70 },
      layers: [
        {
          name: 'Compound',
          items: [
            { kind: 'path', geometry: pieces, stroke },
            { kind: 'path', geometry: evenOdd, fill },
            { kind: 'path', geometry: evenOdd, fill, stroke },
            { kind: 'path', geometry: pieces, fill },
            { kind: 'clipGroup', clip: pieces, items: [path] },
            { kind: 'clipGroup', clip: evenOdd, items: [path] },
          ],
        },
      ],
      lastModified: date,
    };
    const content = pageContent(model);
    // The quadratic from (20, 15) through (26, 27) to (32, 15) is the cubic with controls (24, 23) and (28, 23).
    const geometry = '10 10 m\n40 10 l\n40 30 l\n10 30 l\nh\n20 15 m\n24 23 28 23 32 15 c\nh\n';
    const paths = [...content.matchAll(/10 10 m\n[^]*?\n(?:S|f\*?|B\*?|W\*?\nn)\n/gu)].map(match => match[0]);
    const painted = paths.filter(drawn => drawn.includes('20 15 m\n'));
    expect(painted).toStrictEqual(['S', 'f*', 'B*', 'f', 'W\nn', 'W*\nn'].map(operator => `${geometry}${operator}\n`));
  });

  it('draws spot rasters as Separation images sharing a soft mask', () => {
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
    expect([
      pdf.includes('/ImageMask true'),
      pdf.match(/\/SMask \d+ 0 R/gu)?.length,
      new Set([...pdf.matchAll(/\/SMask (\d+) 0 R/gu)].map(match => match[1])).size,
    ]).toStrictEqual([false, 3, 2]);
    expect(pdf).toContain('/SMask');
    expect(pdf).toContain('/ColorSpace/DeviceCMYK');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Primer');
  });

  it('draws layer and isolated group opacity outside their forms', () => {
    const model: IllustratorDocument = {
      artboard: { width: 50, height: 40 },
      lastModified: date,
      layers: [
        {
          name: 'Primer',
          opacity: 0.3,
          items: [{ kind: 'group', opacity: 0.5, isolated: true, items: [path] }],
        },
      ],
    };
    const document = createDocument();
    drawPage(document, model);
    const pdf = new TextDecoder('latin1').decode(document.save().toBytes());
    expect(pdf.match(/\/Subtype\/Form/gu)).toHaveLength(2);
    expect(pdf).toContain('/I true');
    expect(pdf).toContain('/I false');
    expect(pdf).toContain('/ca 0.3');
    expect(pdf).toContain('/ca 0.5');
  });
});
