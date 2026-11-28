import type { IllustratorDocument, Paint, PathItem, RasterItem, SpotColor } from '../model/illustratorDocument.ts';

import { InvalidArgumentError, ValidationError, mm, pdfDate } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { documentColors, writeHeader } from './writeHeader.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const spot: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
const rectangle: PathItem = {
  kind: 'path',
  geometry: {
    subpaths: [
      {
        start: [10, 10],
        segments: [
          { kind: 'line', to: [30, 10] },
          { kind: 'line', to: [30, 20] },
          { kind: 'line', to: [10, 20] },
        ],
      },
    ],
  },
  fill: { paint: { kind: 'spot', spot } },
};
const document: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
  layers: [
    { name: 'Hidden', visible: false, items: [{ ...rectangle, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }] },
    { name: 'Spot', items: [rectangle] },
  ],
  lastModified: date,
  title: 'Print test',
};

describe('native header comments', () => {
  it('writes the observed artboard formulas and ends metadata at EndComments CR', () => {
    const writer = createNativeWriter();
    const metaDataLength = writeHeader(writer, document);
    const text = new TextDecoder().decode(writer.finish());
    expect(metaDataLength).toBe(writer.finish().length);
    expect(text).toContain('%AI3_Cropmarks: 0 0 283.4645669291 198.4251968504\r');
    expect(text).toContain('%%PageOrigin:0 198.4251968504\r');
    expect(text).toContain('%AI3_TileBox: -261.2677165354 -180.2874015748 521.7322834646 378.7125984252\r');
  });

  it('uses each native origin’s ruler origin for TemplateBox', () => {
    for (const [nativeOrigin, expected] of [
      ['artboard-bottom-left', '142.5 98.9251968504 142.5 98.9251968504'],
      ['artboard-top-left', '141.7322834646 99.2125984252 141.7322834646 99.2125984252'],
    ] as const) {
      const writer = createNativeWriter();
      writeHeader(writer, document, { nativeOrigin });
      const text = new TextDecoder().decode(writer.finish());
      expect(text).toContain(`%AI3_TemplateBox: ${expected}\r`);
    }
  });

  it('keeps neutral provenance, visible process plates and sorted spot comments', () => {
    const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
    const twoSpots: IllustratorDocument = {
      ...document,
      layers: [...document.layers, { name: 'Cut', items: [{ ...rectangle, fill: { paint: { kind: 'spot', spot: cut } } }] }],
    };
    const writer = createNativeWriter();
    writeHeader(writer, twoSpots, { creator: 'pdfwright test' });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%%Creator: pdfwright test\r%%AI8_CreatorVersion: 30.8.2\r%%For: () ()\r');
    expect(text).toContain('%%CreationDate: 2026/09/28 12:34\r');
    expect(text).toContain(
      '%AI7_ImageSettings: 0\r%%DocumentCustomColors: (Cut)\r%%+ (White)\r%%CMYKCustomColor: 0 1 0 0 (Cut)\r%%+ 0.2 0 0 0 (White)\r%AI3_Cropmarks:',
    );
    expect(text).not.toContain('%%DocumentProcessColors: Black');
    expect(text).toMatch(/%%EndComments\r$/u);
  });

  it.each([
    ['a non-ASCII character', 'é'],
    ['the last C0 control', '\u001F'],
    ['DEL', '\u007F'],
  ] as const)('rejects a creator with %s', (_name, creator) => {
    expect(() => writeHeader(createNativeWriter(), document, { creator })).toThrow(InvalidArgumentError);
  });

  it('accepts a creator of the first and last printable ASCII characters', () => {
    const writer = createNativeWriter();
    writeHeader(writer, document, { creator: '~ ' });
    expect(new TextDecoder().decode(writer.finish())).toContain('\r%%Creator: ~ \r');
  });

  it.each([
    ['an empty title when none is given', undefined, '%%Title: ()\r'],
    ['an escaped title', 'A(b)', String.raw`%%Title: (A\(b\))` + '\r'],
  ] as const)('writes %s', (_name, title, expected) => {
    const untitled: IllustratorDocument = { artboard: document.artboard, layers: document.layers, lastModified: date };
    const writer = createNativeWriter();
    writeHeader(writer, title === undefined ? untitled : { ...untitled, title });
    expect(new TextDecoder().decode(writer.finish())).toContain(`\r${expected}`);
  });

  it('rejects a non-ASCII title', () => {
    expect(() => writeHeader(createNativeWriter(), { ...document, title: 'é' })).toThrow(ValidationError);
  });

  it('pads the creation date’s day, hour and minute to two digits', () => {
    const writer = createNativeWriter();
    writeHeader(writer, { ...document, lastModified: pdfDate({ year: 2026, month: 9, day: 3, hour: 7, minute: 5, second: 0, offset: 'Z' }) });
    expect(new TextDecoder().decode(writer.finish())).toContain('\r%%CreationDate: 2026/09/03 07:05\r');
  });

  it('counts visible process plates and reverses layer order for the view flags', () => {
    const process: PathItem = { ...rectangle, fill: { paint: { kind: 'process', cmyk: [1, 0, 0, 0] } } };
    const adjusted: IllustratorDocument = { ...document, layers: [...document.layers, { name: 'Cyan', items: [process] }] };
    expect(documentColors(adjusted).process).toStrictEqual(['Cyan']);
    const writer = createNativeWriter();
    writeHeader(writer, adjusted);
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%%DocumentProcessColors: Cyan\r');
    expect(text).toContain('%AI5_OpenViewLayers: 776\r');
  });

  it('writes the artboard-top-left cropmarks and page origin', () => {
    const writer = createNativeWriter();
    writeHeader(writer, document, { nativeOrigin: 'artboard-top-left' });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%AI3_Cropmarks: 0 -198.4251968504 283.4645669291 0\r');
    expect(text).toContain('%%PageOrigin:0 0\r');
  });

  it.each([
    ['artboard-bottom-left', '10 10 30 20', '10 10 30 20', '-261.2677165354 -180.2874015748 521.7322834646 378.7125984252'],
    // The art lies 198.4251968504 (70 mm) lower, and the integer box rounds outward.
    ['artboard-top-left', '10 -189 30 -178', '10 -188.4251968504 30 -178.4251968504', '-261.2677165354 -378.7125984252 521.7322834646 180.2874015748'],
  ] as const)('writes the bounding boxes and TileBox for the %s origin', (nativeOrigin, boundingBox, hiResBoundingBox, tileBox) => {
    const writer = createNativeWriter();
    writeHeader(writer, document, { nativeOrigin });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain(`\r%%BoundingBox: ${boundingBox}\r%%HiResBoundingBox: ${hiResBoundingBox}\r`);
    expect(text).toContain(`\r%AI3_TileBox: ${tileBox}\r`);
  });

  it.each([
    ['artboard-bottom-left', '-904 475 1'],
    // Math.round(473.5) is 474, so the top-left view is one point below the bottom-left one mirrored.
    ['artboard-top-left', '-904 474 1'],
  ] as const)('rounds the OpenToView centre of a 1-point-high artboard for the %s origin', (nativeOrigin, prefix) => {
    const writer = createNativeWriter();
    writeHeader(writer, { ...document, artboard: { width: 100, height: 1 } }, { nativeOrigin });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain(`\r%AI10_OpenToVie: ${prefix} 0 0 0 1908`);
    expect(text).toContain(`\r%AI9_OpenToView: ${prefix} 1908`);
  });

  it.each([
    ['one visible locked layer', [{ name: 'A', locked: true, items: [] }], '1', '3'],
    [
      'every visibility and lock combination',
      [
        { name: 'A', visible: false, items: [] },
        { name: 'B', items: [] },
        { name: 'C', locked: true, items: [] },
        { name: 'D', visible: false, locked: true, items: [] },
      ],
      '4',
      '2376',
    ],
  ] as const)('counts layers and writes view flags for %s', (_name, layers, count, flags) => {
    const writer = createNativeWriter();
    writeHeader(writer, { ...document, layers });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain(`\r%AI5_NumLayers: ${count}\r`);
    expect(text).toContain(`\r%AI5_OpenViewLayers: ${flags}\r`);
  });

  it('counts no layers in a document without them', () => {
    const writer = createNativeWriter();
    writeHeader(writer, { ...document, layers: [] });
    expect(new TextDecoder().decode(writer.finish())).toContain('\r%AI5_NumLayers: 0\r');
  });
});

const raster = (samples: ReadonlyArray<number>): RasterItem => ({
  kind: 'raster',
  width: 2,
  height: 1,
  bounds: { x: 0, y: 0, width: 2, height: 1 },
  color: { space: 'cmyk', samples: new Uint8Array(samples) },
  alpha: new Uint8Array([255, 255]),
});

// UTF-8 byte order is code point order, so this compares code points rather than bytes.
const codePointOrder = (left: string, right: string): number => {
  const first = Array.from(left, character => character.codePointAt(0) ?? 0);
  const second = Array.from(right, character => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return first.length - second.length;
};

describe('document colours', () => {
  const processPath = (cmyk: readonly [number, number, number, number]): PathItem => ({ ...rectangle, fill: { paint: { kind: 'process', cmyk } } });
  const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };

  it.each([
    ['takes process plates from raster samples by channel', [{ name: 'A', items: [raster([0, 0, 0, 0, 0, 0, 9, 0])] }], [], ['Yellow']],
    ['ignores raster samples on a hidden layer', [{ name: 'A', visible: false, items: [raster([0, 0, 0, 0, 0, 0, 9, 0])] }], [], []],
    ['lists a spot used only on a hidden layer', [{ name: 'A', visible: false, items: [rectangle] }], [spot], []],
    [
      'counts stroke paint inside nested clip groups and groups',
      [
        {
          name: 'A',
          items: [
            {
              kind: 'clipGroup',
              clip: rectangle.geometry,
              items: [
                {
                  kind: 'group',
                  items: [
                    { kind: 'path', geometry: rectangle.geometry, stroke: { paint: { kind: 'process', cmyk: [0, 1, 0, 0] }, width: 1 } },
                    { kind: 'path', geometry: rectangle.geometry, stroke: { paint: { kind: 'spot', spot: cut }, width: 1 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [cut],
      ['Magenta'],
    ],
    [
      'orders plates as cyan, magenta, yellow, black whatever order they appear in',
      [{ name: 'A', items: [processPath([0, 0, 0, 1]), processPath([1, 0, 0, 0])] }],
      [],
      ['Cyan', 'Black'],
    ],
  ] as const)('%s', (_name, layers, spots, process) => {
    expect(documentColors({ ...document, layers })).toStrictEqual({ spots, process });
  });
});

describe('properties', () => {
  const pool: ReadonlyArray<SpotColor> = ['White', 'cut', 'Ａ', '😀', 'Cut', 'Cutter', 'ＣＵＴ'].map((name, index) => ({
    name,
    alternate: [index / 10, 0, 0, 0],
  }));
  const plate = fc.constantFrom(0, 0.5, 1);
  const paint = fc.oneof(
    fc.constantFrom(...pool).map((color): Paint => ({ kind: 'spot', spot: color })),
    fc.tuple(plate, plate, plate, plate).map((cmyk): Paint => ({ kind: 'process', cmyk })),
  );
  const layer = fc.record({
    name: fc.constant('L'),
    visible: fc.boolean(),
    items: fc.array(
      paint.map((fill): PathItem => ({ ...rectangle, fill: { paint: fill } })),
      { maxLength: 4 },
    ),
  });
  const plates = ['Cyan', 'Magenta', 'Yellow', 'Black'];

  it('lists spots in code point order and plates in plate order, whatever the layer order', () => {
    fc.assert(
      fc.property(fc.array(layer, { maxLength: 4 }), layers => {
        const colors = documentColors({ ...document, layers });
        expect(colors.spots.map(color => color.name)).toStrictEqual(colors.spots.map(color => color.name).toSorted(codePointOrder));
        expect(colors.process).toStrictEqual(plates.filter(name => colors.process.includes(name)));
        expect(documentColors({ ...document, layers: layers.toReversed() })).toStrictEqual(colors);
      }),
    );
  });
});
