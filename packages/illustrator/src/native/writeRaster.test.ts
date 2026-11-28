import type { RasterItem, SpotColor } from '../model/illustratorDocument.ts';
import type { NativeRasterOptions } from './writeRaster.ts';

import { describe, expect, it } from 'vitest';

import { nameBasedUuid } from './nameBasedUuid.ts';
import { createNativeWriter } from './nativeWriter.ts';
import { writeRaster } from './writeRaster.ts';

const encoder = new TextEncoder();
// Bounds 6 by 2 over 2 by 1 pixels give a horizontal scale of 3 and a vertical scale of 2, so swapping them shows.
const cmyk: RasterItem = {
  kind: 'raster',
  width: 2,
  height: 1,
  bounds: { x: 10, y: 20, width: 6, height: 2 },
  color: { space: 'cmyk', samples: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  alpha: new Uint8Array([255, 0]),
};
const white: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };

const render = (item: RasterItem, options: NativeRasterOptions): Uint8Array => {
  const writer = createNativeWriter();
  writeRaster(writer, item, options);
  return writer.finish();
};
// The decoder maps every byte to one character, so string offsets equal byte offsets.
const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
const uuids = (bytes: Uint8Array) => {
  const text = latin1(bytes);
  return {
    color: /%_\(([0-9a-f-]{36})\) \/UnicodeString \(AI24 ImageRawDataUUID\) ,\r/u.exec(text)?.[1],
    alpha: /%_\(([0-9a-f-]{36})\) \/UnicodeString \(AI24 ImageAlphaRawDataUUID\) ,\r/u.exec(text)?.[1],
  };
};
const concat = (...chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
};

describe('native rasters', () => {
  it('writes interleaved CMYK and separate alpha after XI LF', () => {
    const bytes = render(cmyk, { itemPath: 'layer/0' });
    const text = latin1(bytes);
    expect(text).toContain('/DeviceCMYK XN\r[ 3 0 0 2 10 22 ] 2 1 0 Xh\r[ 3 0 0 2 10 22 ] 0 0 2 1 2 1 8 4 1 18 1 0 4 4 0 0\r');
    expect(text).toContain('%%BeginData: 11\rXI\n');
    const start = text.indexOf('XI\n') + 3;
    expect(bytes.slice(start, start + 10)).toStrictEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 255, 0]));
    expect(text.slice(start + 10)).toMatch(/^%%EndData\rXH\r/u);
    expect(text).toMatch(/N\r%_\/ArtDictionary :\r%_3 \/Real \(Raster Art Original Scale\) ,\r/u);
  });

  it('moves the matrix origin by the y offset', () => {
    expect(latin1(render(cmyk, { itemPath: 'layer/0', yOffset: -70 }))).toContain('\r[ 3 0 0 2 10 -48 ] 2 1 0 Xh\r');
  });

  it('writes a fractional scale to ten decimal places', () => {
    const text = latin1(
      render(
        { ...cmyk, width: 3, bounds: { x: 0, y: 0, width: 1, height: 1 }, color: { space: 'cmyk', samples: new Uint8Array(12) }, alpha: new Uint8Array(3) },
        { itemPath: 'layer/0' },
      ),
    );
    expect(text).toContain('\r[ 0.3333333333 0 0 1 0 1 ] 3 1 0 Xh\r');
    expect(text).toContain('\r%_0.3333333333 /Real (Raster Art Original Scale) ,\r');
  });

  it.each([
    ['opaque default samples', undefined, new Uint8Array([255]), new Uint8Array([128])],
    ['explicit samples', new Uint8Array([7]), new Uint8Array([7]), new Uint8Array([9])],
  ] as const)('writes a one-channel spot raster with %s', (_name, given, samples, alpha) => {
    // Bounds 4 by 2 over one pixel give distinct horizontal and vertical scales.
    const raster: RasterItem = {
      kind: 'raster',
      width: 1,
      height: 1,
      bounds: { x: 10, y: 20, width: 4, height: 2 },
      color: given === undefined ? { space: 'spot', spot: white } : { space: 'spot', spot: white, samples: given },
      alpha,
    };
    const head = [
      '0 O',
      '0.2 0 0 0 (White) 0 x',
      '0 1 0 0 0 Xy',
      '0 J 0 j 1 w 10 M []0 d',
      '0 XR',
      '%AI5_File:',
      '%AI5_BeginRaster',
      '() 1 XG',
      '1 [0.2 0 0 0 /DeviceCMYK (White) /Separation] XC',
      '[ 4 0 0 2 10 22 ] 1 1 3 Xh',
      '[ 4 0 0 2 10 22 ] 0 0 1 1 1 1 8 1 1 16 1 3 4 4 0 0',
      // The byte count covers XI LF and the colour samples, not the alpha plane.
      '%%BeginData: 4',
      'XI\n',
    ].join('\r');
    const tail = [
      '%%EndData',
      'XH',
      '%AI17_Begin_Content_if_version_gt:24 17',
      '72 72 Xr',
      '%AI17_End_Versioned_Content',
      '%AI5_EndRaster',
      'F',
      '%_/ArtDictionary :',
      '%_4 /Real (Raster Art Original Scale) ,',
      `%_(${nameBasedUuid('raster-color', samples, 'layer/0')}) /UnicodeString (AI24 ImageRawDataUUID) ,`,
      `%_(${nameBasedUuid('raster-alpha', alpha, 'layer/0')}) /UnicodeString (AI24 ImageAlphaRawDataUUID) ,`,
      '%_;',
      '%_',
      '',
    ].join('\r');
    expect(render(raster, { itemPath: 'layer/0' })).toStrictEqual(concat(encoder.encode(head), samples, alpha, encoder.encode(tail)));
  });

  it('changes each data UUID with the item path and only with its own plane', () => {
    const first = uuids(render(cmyk, { itemPath: 'layer/0' }));
    const moved = uuids(render(cmyk, { itemPath: 'layer/1' }));
    const newAlpha = uuids(render({ ...cmyk, alpha: new Uint8Array([255, 1]) }, { itemPath: 'layer/0' }));
    const newColor = uuids(render({ ...cmyk, color: { space: 'cmyk', samples: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]) } }, { itemPath: 'layer/0' }));
    expect(first.color).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.alpha).toMatch(/^[0-9a-f-]{36}$/u);
    expect(moved.color).not.toBe(first.color);
    expect(moved.alpha).not.toBe(first.alpha);
    expect(newAlpha.color).toBe(first.color);
    expect(newAlpha.alpha).not.toBe(first.alpha);
    expect(newColor.color).not.toBe(first.color);
    expect(newColor.alpha).toBe(first.alpha);
  });
});
