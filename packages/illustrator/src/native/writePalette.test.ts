import type { IllustratorDocument, SpotColor } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writePalette } from './writePalette.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 0, offset: 'Z' });
const spot = (name: string, cyan: number): SpotColor => ({ name, alternate: [cyan, 0, 0, 0] });
const white = spot('White', 0.1);
const lowerCut = spot('cut', 0.2);
const fullwidth = spot('Ａ', 0.3);
const emoji = spot('😀', 0.4);
const cut = spot('Cut', 0.5);
const cutter = spot('Cutter', 0.6);

const documentWith = (spots: ReadonlyArray<SpotColor>): IllustratorDocument => ({
  artboard: { width: 100, height: 70 },
  layers: [
    {
      name: 'Spots',
      items: spots.map((color, index) =>
        index % 2 === 0
          ? {
              kind: 'path',
              geometry: { subpaths: [{ start: [0, 0], segments: [{ kind: 'line', to: [10, 0] }] }] },
              fill: { paint: { kind: 'spot', spot: color } },
            }
          : {
              kind: 'raster',
              width: 1,
              height: 1,
              bounds: { x: 0, y: 0, width: 1, height: 1 },
              color: { space: 'spot', spot: color },
              alpha: new Uint8Array([255]),
            },
      ),
    },
  ],
  lastModified: date,
});

const swatch = (color: SpotColor): string => `${String(color.alternate[0])} 0 0 0 (${color.name}) 0 x\r(${color.name})\rPc\r`;
const palette = (spots: ReadonlyArray<SpotColor>): string => `%AI5_BeginPalette\r0 0 Pb\r${spots.map(swatch).join('')}PB\r%AI5_EndPalette\r`;

const render = (document: IllustratorDocument, spots?: ReadonlyArray<SpotColor>): string => {
  const writer = createNativeWriter();
  writePalette(writer, document, spots);
  return new TextDecoder().decode(writer.finish());
};

describe('native setup', () => {
  it('writes every spot swatch from paths and rasters in UTF-8 byte order', () => {
    // UTF-16 code-unit order would put 😀 (D83D) before Ａ (FF21), and locale order would put lowercase cut next to Cut.
    expect(render(documentWith([emoji, cutter, fullwidth, lowerCut, white, cut]))).toBe(palette([cut, cutter, white, lowerCut, fullwidth, emoji]));
  });

  it('writes an empty palette for a document without spots', () => {
    expect(render(documentWith([]))).toBe('%AI5_BeginPalette\r0 0 Pb\rPB\r%AI5_EndPalette\r');
  });

  it('writes the spots it is given in place of the document’s', () => {
    expect(render(documentWith([white, cut]), [cutter])).toBe(palette([cutter]));
  });
});
