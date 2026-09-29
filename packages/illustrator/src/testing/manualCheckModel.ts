import type { IllustratorDocument, PathGeometry, Point, RasterItem, SpotColor, Subpath } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';

const point = (x: number, y: number): Point => [mm(x), mm(y)];
const CURVE = 0.5522847498;

const rectangle = ([left, bottom, right, top]: readonly [number, number, number, number]): PathGeometry => ({
  subpaths: [
    {
      start: point(left, bottom),
      segments: [
        { kind: 'line', to: point(right, bottom) },
        { kind: 'line', to: point(right, top) },
        { kind: 'line', to: point(left, top) },
      ],
    },
  ],
});

const circle = (centerX: number, centerY: number, radius: number): PathGeometry => ({
  subpaths: [
    {
      start: point(centerX + radius, centerY),
      segments: [
        {
          kind: 'curve',
          control1: point(centerX + radius, centerY + CURVE * radius),
          control2: point(centerX + CURVE * radius, centerY + radius),
          to: point(centerX, centerY + radius),
          anchor: 'smooth',
        },
        {
          kind: 'curve',
          control1: point(centerX - CURVE * radius, centerY + radius),
          control2: point(centerX - radius, centerY + CURVE * radius),
          to: point(centerX - radius, centerY),
          anchor: 'smooth',
        },
        {
          kind: 'curve',
          control1: point(centerX - radius, centerY - CURVE * radius),
          control2: point(centerX - CURVE * radius, centerY - radius),
          to: point(centerX, centerY - radius),
          anchor: 'smooth',
        },
        {
          kind: 'curve',
          control1: point(centerX + CURVE * radius, centerY - radius),
          control2: point(centerX + radius, centerY - CURVE * radius),
          to: point(centerX + radius, centerY),
          anchor: 'smooth',
        },
      ],
    },
  ],
});

const roundedDie = (): PathGeometry => {
  const left = 5;
  const bottom = 5;
  const right = 95;
  const top = 65;
  const radius = 5;
  const tangent = CURVE * radius;
  return {
    subpaths: [
      {
        start: point(left + radius, bottom),
        segments: [
          { kind: 'line', to: point(right - radius, bottom) },
          {
            kind: 'curve',
            control1: point(right - radius + tangent, bottom),
            control2: point(right, bottom + radius - tangent),
            to: point(right, bottom + radius),
            anchor: 'smooth',
          },
          { kind: 'line', to: point(right, top - radius) },
          {
            kind: 'curve',
            control1: point(right, top - radius + tangent),
            control2: point(right - radius + tangent, top),
            to: point(right - radius, top),
            anchor: 'smooth',
          },
          { kind: 'line', to: point(left + radius, top) },
          {
            kind: 'curve',
            control1: point(left + radius - tangent, top),
            control2: point(left, top - radius + tangent),
            to: point(left, top - radius),
            anchor: 'smooth',
          },
          { kind: 'line', to: point(left, bottom + radius) },
          {
            kind: 'curve',
            control1: point(left, bottom + radius - tangent),
            control2: point(left + radius - tangent, bottom),
            to: point(left + radius, bottom),
            anchor: 'smooth',
          },
        ],
      },
    ],
  };
};

/** Builds the synthetic six-layer artwork used for Illustrator 30.8.2 manual checks. */
export const manualCheckModel = (): IllustratorDocument => {
  const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
  const unicodeCut: SpotColor = { name: 'ＣＵＴ', nameBytes: Uint8Array.of(0x82, 0x62, 0x82, 0x74, 0x82, 0x73), alternate: [0, 1, 0, 0] };
  const white: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
  const primer: SpotColor = { name: 'Primer', alternate: [0, 0, 0, 0.2] };
  const clip = roundedDie();
  const rasterWidth = 30;
  const rasterHeight = 20;
  const alpha = new Uint8Array(rasterWidth * rasterHeight);
  const cmyk = new Uint8Array(rasterWidth * rasterHeight * 4);
  for (let y = 0; y < rasterHeight; y++) {
    for (let x = 0; x < rasterWidth; x++) {
      const index = y * rasterWidth + x;
      const radius = Math.hypot((x + 0.5 - rasterWidth / 2) / 13, (y + 0.5 - rasterHeight / 2) / 8);
      alpha[index] = Math.round(255 * Math.max(0, Math.min(1, (1 - radius) / 0.35)));
      cmyk[index * 4] = Math.floor((x / rasterWidth) * 255);
      cmyk[index * 4 + 1] = Math.floor((y / rasterHeight) * 255);
      cmyk[index * 4 + 2] = 32;
      cmyk[index * 4 + 3] = 0;
    }
  }
  const bounds = { x: mm(20), y: mm(15), width: mm(60), height: mm(40) };
  const rampWidth = 16;
  const rampAlpha = new Uint8Array(rampWidth * 2);
  const rampCmyk = new Uint8Array(rampWidth * 2 * 4);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < rampWidth; x++) {
      rampAlpha[y * rampWidth + x] = x * 17;
      rampCmyk[(y * rampWidth + x) * 4 + 1] = 255;
    }
  }
  return {
    artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
    layers: [
      {
        name: '非表示',
        visible: false,
        items: [{ kind: 'path', geometry: rectangle([0, 0, 10, 10]), fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }],
      },
      {
        name: 'Design',
        items: [
          {
            kind: 'clipGroup',
            clip,
            items: [
              { kind: 'raster', width: rasterWidth, height: rasterHeight, bounds, color: { space: 'cmyk', samples: cmyk }, alpha },
              {
                kind: 'raster',
                width: rampWidth,
                height: 2,
                bounds: { x: mm(42), y: mm(8), width: mm(16), height: mm(4) },
                color: { space: 'cmyk', samples: rampCmyk },
                alpha: rampAlpha,
              },
            ],
          },
        ],
      },
      {
        name: 'Primer 30%',
        opacity: 0.3,
        items: [
          {
            kind: 'clipGroup',
            clip,
            items: [{ kind: 'raster', width: rasterWidth, height: rasterHeight, bounds, color: { space: 'spot', spot: primer }, alpha }],
          },
        ],
      },
      {
        name: 'White',
        items: [
          {
            kind: 'clipGroup',
            clip,
            items: [{ kind: 'raster', width: rasterWidth, height: rasterHeight, bounds, color: { space: 'spot', spot: white }, alpha }],
          },
        ],
      },
      {
        name: 'Spot shapes',
        items: [
          {
            kind: 'path',
            geometry: rectangle([20, 20, 40, 40]),
            fill: { paint: { kind: 'spot', spot: white } },
            stroke: { paint: { kind: 'spot', spot: cut }, width: 1 },
          },
          { kind: 'path', geometry: circle(65, 35, 8), fill: { paint: { kind: 'spot', spot: white, tint: 0.5 } } },
          { kind: 'path', geometry: rectangle([45, 15, 55, 25]), fill: { paint: { kind: 'spot', spot: cut }, overprint: true } },
        ],
      },
      {
        name: 'Die (outer)',
        items: [
          { kind: 'path', geometry: clip, stroke: { paint: { kind: 'spot', spot: cut }, width: 0.25 } },
          { kind: 'path', geometry: circle(50, 35, 20), stroke: { paint: { kind: 'spot', spot: unicodeCut }, width: 0 } },
        ],
      },
    ],
    lastModified: pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' }),
    title: 'Illustrator manual check',
  };
};

// A 10 mm square around a 4 mm square, both drawn counterclockwise, so the inner one is filled by the nonzero rule and empty by the even-odd rule.
const nested = (left: number): readonly Subpath[] => [...rectangle([left, 10, left + 10, 20]).subpaths, ...rectangle([left + 3, 13, left + 7, 17]).subpaths];

/** Builds compound paths and clips under both fill rules for the Illustrator compound-path check. */
export const compoundManualCheckModel = (): IllustratorDocument => {
  const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
  const outlineWithHole = [...roundedDie().subpaths, ...circle(50, 35, 12).subpaths];
  const arch: Subpath = { start: point(10, 25), segments: [{ kind: 'quadratic', control: point(15, 38), to: point(20, 25) }] };
  const black = { paint: { kind: 'process', cmyk: [0, 0, 0, 0.6] } } as const;
  const paleCyan: RasterItem = {
    kind: 'raster',
    width: 2,
    height: 2,
    bounds: { x: mm(0), y: mm(0), width: mm(100), height: mm(70) },
    color: { space: 'cmyk', samples: new Uint8Array(16).map((_, index) => (index % 4 === 0 ? 77 : 0)) },
    alpha: new Uint8Array(4).fill(255),
  };
  return {
    artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
    layers: [
      { name: 'Even-odd clip', items: [{ kind: 'clipGroup', clip: { subpaths: outlineWithHole, fillRule: 'evenodd' }, items: [paleCyan] }] },
      {
        name: 'Compound fills',
        items: [
          { kind: 'path', geometry: { subpaths: [...nested(10), arch] }, fill: black },
          { kind: 'path', geometry: { subpaths: nested(80), fillRule: 'evenodd' }, fill: black },
        ],
      },
      { name: 'Compound die', items: [{ kind: 'path', geometry: { subpaths: outlineWithHole }, stroke: { paint: { kind: 'spot', spot: cut }, width: 0.25 } }] },
    ],
    lastModified: pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' }),
    title: 'Illustrator compound path check',
  };
};

/** Adds lock states to the standard artwork for the Illustrator Layers panel check. */
export const lockedManualCheckModel = (): IllustratorDocument => {
  const standard = manualCheckModel();
  return {
    ...standard,
    layers: [
      ...standard.layers,
      {
        name: 'Locked layer',
        locked: true,
        items: [{ kind: 'path', geometry: rectangle([5, 5, 15, 15]), fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }],
      },
      {
        name: 'Locked object',
        items: [{ kind: 'path', locked: true, geometry: rectangle([40, 5, 50, 15]), fill: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } } }],
      },
      {
        name: 'Locked and hidden',
        locked: true,
        visible: false,
        items: [{ kind: 'path', geometry: rectangle([70, 5, 80, 15]), fill: { paint: { kind: 'process', cmyk: [0, 1, 1, 0] } } }],
      },
    ],
  };
};
