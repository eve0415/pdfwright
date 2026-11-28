import type { IllustratorDocument, Item, Layer, PathItem, SpotColor, Subpath } from '../model/illustratorDocument.ts';

import { ValidationError, pdfDate } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readNative } from '../read/readNative.ts';

import { nameBasedUuid } from './nameBasedUuid.ts';
import { writeNative } from './writeNative.ts';

const artboardUuid = (bytes: Uint8Array): string | undefined =>
  /%_\(([0-9a-f-]{36})\) \/String \(ArtboardUUID\) ,\r/u.exec(new TextDecoder().decode(bytes))?.[1];
// Searches the bytes rather than decoded text, because multi-byte layer names would shift string offsets.
const indexOf = (bytes: Uint8Array, marker: string): number => {
  const needle = new TextEncoder().encode(marker);
  for (let start = 0; start + needle.length <= bytes.length; start++) {
    if (needle.every((byte, index) => bytes[start + index] === byte)) {
      return start;
    }
  }
  return -1;
};

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 0, offset: 'Z' });
const path: PathItem = {
  kind: 'path',
  geometry: {
    subpaths: [
      {
        start: [1, 2],
        segments: [
          { kind: 'line', to: [11, 2] },
          { kind: 'line', to: [11, 12] },
          { kind: 'line', to: [1, 12] },
        ],
      },
    ],
  },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } },
};
const hiddenLayer: Layer = { name: '非表示', visible: false, items: [path] };
const baseLayer: Layer = { name: 'Base 30%', opacity: 0.3, items: [{ kind: 'group', opacity: 0.5, isolated: true, items: [path] }] };
const document: IllustratorDocument = {
  artboard: { width: 100, height: 70 },
  layers: [hiddenLayer, baseLayer],
  lastModified: date,
};

describe('native data assembly', () => {
  it('writes the metadata prefix, setup, layer order and transparency trailers', () => {
    const result = writeNative(document);
    const text = new TextDecoder().decode(result.bytes);
    expect(new TextDecoder().decode(result.bytes.slice(0, result.metaDataLength))).toMatch(/%%EndComments\r$/u);
    expect(text).toContain('%%BeginProlog\r%%EndProlog\r%%BeginSetup\r%AI5_BeginPalette\r');
    expect(text.indexOf('(非表示) Ln')).toBeLessThan(text.indexOf('(Base 30%) Ln'));
    expect(text).toContain('0 1 1 1 0 0 0 0 79 128 255 0 50 0 Lb\r(非表示) Ln\r');
    expect(text).toContain('U\r0 0.5 1 0 0 Xy\r0 0 Xd\r6 () XW\r0 0.3 0 2 0 Xy\r0 0 Xd\r7 () XW\r');
  });

  it('writes the active artboard index immediately after the artboard array', () => {
    const text = new TextDecoder().decode(writeNative(document).bytes);
    expect(text).toContain('%_; (ArtboardArray) ,\r%_0 /Int (CropAreaActive) ,\r');
  });

  it('writes locked and hidden layer state independently', () => {
    const locked = {
      ...document,
      layers: [
        { ...hiddenLayer, locked: true },
        { ...baseLayer, locked: true, visible: false },
      ],
    };
    const text = new TextDecoder().decode(writeNative(locked).bytes);
    expect(text).toContain('%AI5_OpenViewLayers: 22\r');
    expect(text).toContain('0 1 0 1 0 0 0 0 79 128 255 0 50 0 Lb\r');
    expect(text).toContain('1 A\r1 Xw\r0 A\r0 Xw\r');
  });

  it('places item lock state before a path and resets it for the next item', () => {
    const locked = { ...document, layers: [{ name: 'Objects', items: [{ ...path, locked: true }, path] }] };
    const text = new TextDecoder().decode(writeNative(locked).bytes);
    expect(text).toContain('0 A\r0 Xw\r1 A\r4 As\r');
    expect(text).toMatch(/f\r0 A\r4 As\r/u);
  });

  it.each([
    ['artboard-bottom-left', -904, 509],
    ['artboard-top-left', -904, 439],
  ] as const)('centres OpenToView on the artboard with the %s origin', (nativeOrigin, left, top) => {
    const text = new TextDecoder().decode(writeNative(document, { nativeOrigin }).bytes);
    const prefix = `${String(left)} ${String(top)} 1`;
    const block = `%AI17_Begin_Content_if_version_gt:24 4\r%AI10_OpenToVie: ${prefix} 0 0 0 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1\r%AI17_Alternate_Content\r%AI9_OpenToView: ${prefix} 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1\r%AI17_End_Versioned_Content\r`;
    const layerLine = '%AI5_OpenViewLayers: 76\r';
    const emptyTwin = '%AI17_Begin_Content_if_version_gt:24 4\r%AI17_Alternate_Content\r%AI17_End_Versioned_Content\r';
    expect(text).toContain(`${block}${layerLine}${emptyTwin}`);
  });

  it('is deterministic and changes its artboard UUID with layer content', () => {
    const first = writeNative(document);
    const second = writeNative(document);
    expect(first.bytes).toStrictEqual(second.bytes);
    const changed = writeNative({ ...document, layers: [{ ...hiddenLayer, name: 'Hidden' }, baseLayer] });
    const uuid = artboardUuid(first.bytes);
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(artboardUuid(second.bytes)).toBe(uuid);
    expect(artboardUuid(changed.bytes)).not.toBe(uuid);
  });

  it('derives the artboard UUID from the layer bytes between the setup and the page trailer', () => {
    const { bytes } = writeNative(document);
    const setupEnd = indexOf(bytes, '%%EndSetup\r') + '%%EndSetup\r'.length;
    const layers = bytes.slice(setupEnd, indexOf(bytes, '%%PageTrailer\r'));
    expect(new TextDecoder().decode(layers)).toMatch(/^%AI5_BeginLayer\r[^]*%AI5_EndLayer--\r$/u);
    expect(artboardUuid(bytes)).toBe(nameBasedUuid('artboard', layers));
  });

  it('ends with the page trailer after the last layer', () => {
    expect(new TextDecoder().decode(writeNative(document).bytes)).toMatch(
      /%AI5_EndLayer--\r%%PageTrailer\rgsave annotatepage grestore showpage\r%%Trailer\r%%EOF\r$/u,
    );
  });

  it('validates the document before writing it', () => {
    expect(() => writeNative({ ...document, artboard: { width: 0, height: 70 } })).toThrow(ValidationError);
  });

  it('moves native coordinates to the artboard’s top-left origin', () => {
    const text = new TextDecoder().decode(writeNative(document, { nativeOrigin: 'artboard-top-left' }).bytes);
    expect(text).toContain('1 -68 m\r');
    expect(text).toContain('%_0 0 /RealPointRelToROrigin\r');
  });
});

describe('properties', () => {
  const spots: ReadonlyArray<SpotColor> = [
    { name: 'White', alternate: [0.2, 0, 0, 0] },
    { name: 'Cut', alternate: [0, 1, 0, 0] },
  ];
  const coordinate = fc.integer({ min: 0, max: 60 });
  const paint = fc.oneof(
    fc.record({
      kind: fc.constant('process'),
      cmyk: fc.tuple(fc.constantFrom(0, 0.5, 1), fc.constantFrom(0, 1), fc.constantFrom(0, 1), fc.constantFrom(0, 1)),
    }),
    fc.record({ kind: fc.constant('spot'), spot: fc.constantFrom(...spots), tint: fc.constantFrom(0.25, 1) }),
  );
  const subpath = fc.tuple(coordinate, coordinate, fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 30 })).map(([x, y, width, height]): Subpath => ({
    start: [x, y],
    segments: [
      { kind: 'line', to: [x + width, y] },
      { kind: 'curve', control1: [x + width, y + height], control2: [x, y + height], to: [x, y + height], anchor: 'smooth' },
    ],
  }));
  const geometry = fc.record({
    subpaths: fc.array(subpath, { minLength: 1, maxLength: 2 }),
    fillRule: fc.constantFrom('nonzero' as const, 'evenodd' as const),
  });
  const pathItem = fc.record({ kind: fc.constant('path'), locked: fc.boolean(), geometry, fill: fc.record({ paint, overprint: fc.boolean() }) });
  const item: fc.Arbitrary<Item> = fc.letrec<{ item: Item }>(tie => ({
    item: fc.oneof(
      { depthSize: 'small' },
      pathItem,
      fc.record({
        kind: fc.constant('group'),
        opacity: fc.constantFrom(0.5, 1),
        isolated: fc.boolean(),
        items: fc.array(tie('item'), { minLength: 1, maxLength: 2 }),
      }),
      fc.record({ kind: fc.constant('clipGroup'), clip: geometry, items: fc.array(tie('item'), { minLength: 1, maxLength: 2 }) }),
    ),
  })).item;
  const model = fc
    .array(fc.record({ visible: fc.boolean(), locked: fc.boolean(), opacity: fc.constantFrom(0.3, 1), items: fc.array(item, { maxLength: 3 }) }), {
      minLength: 1,
      maxLength: 3,
    })
    .map((layers): IllustratorDocument => ({ ...document, layers: layers.map((layer, index): Layer => ({ ...layer, name: `Layer ${String(index + 1)}` })) }));

  it('writes the same bytes again after reading its own output', () => {
    fc.assert(
      fc.property(model, original => {
        const first = writeNative(original).bytes;
        expect(writeNative(readNative(first, date).document).bytes).toStrictEqual(first);
      }),
    );
  });
});
