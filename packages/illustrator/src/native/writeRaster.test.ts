import type { RasterItem, SpotColor } from '../model/illustratorDocument.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeRaster } from './writeRaster.ts';

const cmyk: RasterItem = {
  kind: 'raster',
  width: 2,
  height: 1,
  bounds: { x: 10, y: 20, width: 4, height: 2 },
  color: { space: 'cmyk', samples: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  alpha: new Uint8Array([255, 0]),
};

describe('native rasters', () => {
  it('writes interleaved CMYK and separate alpha after XI LF', () => {
    const writer = createNativeWriter();
    writeRaster(writer, cmyk, { itemPath: 'layer/0' });
    const bytes = writer.finish();
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/DeviceCMYK XN\r[ 2 0 0 2 10 22 ] 2 1 0 Xh\r');
    expect(text).toContain('%%BeginData: 11\rXI\n');
    const start = text.indexOf('XI\n') + 3;
    expect(bytes.slice(start, start + 10)).toStrictEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 255, 0]));
    expect(text.slice(start + 10)).toMatch(/^%%EndData\rXH\r/u);
    expect(text).toMatch(/N\r%_\/ArtDictionary :\r%_2 \/Real \(Raster Art Original Scale\) ,\r/u);
  });

  it('writes one-channel spot samples and changes UUIDs with the item path', () => {
    const spot: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
    const raster: RasterItem = { ...cmyk, width: 1, height: 1, color: { space: 'spot', spot }, alpha: new Uint8Array([128]) };
    const first = createNativeWriter();
    const second = createNativeWriter();
    writeRaster(first, raster, { itemPath: 'layer/0' });
    writeRaster(second, raster, { itemPath: 'layer/1' });
    const text = new TextDecoder('latin1').decode(first.finish());
    expect(text).toContain('0 O\r0.2 0 0 0 (White) 0 x\r');
    expect(text).toContain('1 [0.2 0 0 0 /DeviceCMYK (White) /Separation] XC\r');
    expect(text).toContain('%%BeginData: 4\rXI\nÿ€%%EndData\r');
    expect(text).toContain('%AI5_EndRaster\rF\r');
    expect(first.finish()).not.toStrictEqual(second.finish());
  });
});
