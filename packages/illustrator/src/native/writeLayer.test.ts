import type { Item, Layer, PathItem, RasterItem, Subpath } from '../model/illustratorDocument.ts';

import { describe, expect, it } from 'vitest';

import { nameBasedUuid } from './nameBasedUuid.ts';
import { createNativeWriter } from './nativeWriter.ts';
import { writeLayer } from './writeLayer.ts';

const square: Subpath = {
  start: [0, 0],
  segments: [
    { kind: 'line', to: [2, 0] },
    { kind: 'line', to: [2, 2] },
    { kind: 'line', to: [0, 2] },
  ],
};
const path: PathItem = { kind: 'path', geometry: { subpaths: [square] }, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } };
const raster: RasterItem = {
  kind: 'raster',
  width: 1,
  height: 1,
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  color: { space: 'cmyk', samples: new Uint8Array([1, 2, 3, 4]) },
  alpha: new Uint8Array([255]),
};

const render = (layer: Layer, index = 0): string => {
  const writer = createNativeWriter();
  writeLayer(writer, layer, { index });
  return new TextDecoder('latin1').decode(writer.finish());
};

describe('native layers', () => {
  it('writes an empty layer with its name escaped as an XMLUID', () => {
    expect(render({ name: 'Base 30%', items: [] })).toBe(
      '%AI5_BeginLayer\r1 1 1 1 0 0 1 0 79 128 255 0 50 0 Lb\r(Base 30%) Ln\r0 AE\r%_/ArtDictionary :\r%_/XMLUID : (Base_30_x25_) ; (AI10_ArtUID) ,\r%_;\r%_\r0 A\r0 Xw\rLB\r%AI5_EndLayer--\r',
    );
  });

  it.each([
    ['the second default colour at index 1', { name: 'A', items: [] }, 1, '1 1 1 1 0 0 1 1 255 79 79 0 50 0 Lb'],
    ['the first default colour again at index 5', { name: 'A', items: [] }, 5, '1 1 1 1 0 0 1 5 79 128 255 0 50 0 Lb'],
    ['the layer’s own colour over the default', { name: 'A', color: [1, 2, 3], items: [] }, 0, '1 1 1 1 0 0 1 0 1 2 3 0 50 0 Lb'],
  ] as const)('writes %s', (_name, layer, index, expected) => {
    expect(render(layer, index)).toContain(`\r${expected}\r`);
  });

  it.each([
    ['a visible locked layer whose path is unlocked', { locked: true, items: [path] }, '1 1 0 1 0 0 1', '1 A\r0 Xw\r0 A\r4 As\r'],
    ['a visible locked layer whose path is locked', { locked: true, items: [{ ...path, locked: true }] }, '1 1 0 1 0 0 1', '1 A\r0 Xw\r4 As\r'],
    ['a hidden locked empty layer', { visible: false, locked: true, items: [] }, '0 1 0 1 0 0 0', '1 A\r1 Xw\r0 Xw\rLB\r'],
    ['a hidden unlocked empty layer', { visible: false, items: [] }, '0 1 1 1 0 0 0', '0 A\r1 Xw\r0 Xw\rLB\r'],
    ['a hidden locked layer whose path is unlocked', { visible: false, locked: true, items: [path] }, '0 1 0 1 0 0 0', '1 A\r1 Xw\r0 A\r0 Xw\r4 As\r'],
  ] as const)('writes the lock and visibility state of %s', (_name, state, flags, expected) => {
    const text = render({ name: 'A', ...state });
    expect(text).toContain(`\r${flags} 0 79 128 255 0 50 0 Lb\r`);
    expect(text).toContain(`%_;\r%_\r${expected}`);
  });

  it('writes the lock state before a locked group and resets it for an unlocked child', () => {
    expect(render({ name: 'A', items: [{ kind: 'group', locked: true, items: [path] }] })).toContain('\r0 A\r0 Xw\r1 A\r0 Ae\ru\r0 A\r4 As\r');
  });

  it.each([
    ['a fully transparent layer', 0, '0 Xw\r0 0 0 2 0 Xy\r0 0 Xd\r7 () XW\rLB\r'],
    ['a translucent layer', 0.5, '0 Xw\r0 0.5 0 2 0 Xy\r0 0 Xd\r7 () XW\rLB\r'],
    ['an explicitly opaque layer', 1, '0 Xw\rLB\r'],
  ] as const)('writes the opacity trailer of %s', (_name, opacity, expected) => {
    expect(render({ name: 'A', opacity, items: [] })).toContain(`\r${expected}%AI5_EndLayer--\r`);
  });

  it('selects even-odd again for a clip after a raster has selected nonzero', () => {
    const compound: PathItem = { ...path, geometry: { subpaths: [square, square], fillRule: 'evenodd' } };
    const clipped: Item = { kind: 'clipGroup', clip: { subpaths: [square], fillRule: 'evenodd' }, items: [raster] };
    // The compound path selects even-odd and the raster's state lines select nonzero, so the clip has to select even-odd once more.
    expect([...render({ name: 'A', items: [compound, clipped] }).matchAll(/\d XR/gu)].map(match => match[0])).toStrictEqual(['1 XR', '0 XR', '1 XR']);
  });

  it('identifies nested rasters with identical bytes by their item paths', () => {
    const text = render({ name: 'A', items: [{ kind: 'group', items: [raster, raster] }] });
    expect([...text.matchAll(/%_\(([0-9a-f-]{36})\) \/UnicodeString \(AI24 ImageRawDataUUID\) ,\r/gu)].map(match => match[1])).toStrictEqual([
      nameBasedUuid('raster-color', raster.color.samples ?? new Uint8Array(), '0/0/0'),
      nameBasedUuid('raster-color', raster.color.samples ?? new Uint8Array(), '0/0/1'),
    ]);
  });
});
