import type { DecodedPng } from './decodePng.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { arrayBuffer, text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { decodePng, pngToRgba8 } from './decodePng.ts';

// The PNGs here are written by ImageMagick 7 from raw 16-bit samples computed below, with png:color-type and png:bit-depth selecting the colour type and bit depth and -interlace PNG selecting Adam7.
// The reference decode is ImageMagick's own reading of the same file as 16-bit RGBA; each test first checks that the file's IHDR is the one requested.
const magick = async (args: readonly string[], input: Uint8Array): Promise<Uint8Array> => {
  const child = spawn('magick', args);
  child.stdin.end(input);
  const [output, errors, closed] = await Promise.all([arrayBuffer(child.stdout), text(child.stderr), once(child, 'close')]);
  if (closed[0] !== 0) throw new Error(errors);
  return new Uint8Array(output);
};

const WIDTH = 13;
const HEIGHT = 9;

const rawInput = (format: 'gray' | 'rgb' | 'rgba', colorType: number, depth: number): Uint8Array => {
  const channels = { gray: 1, rgb: 3, rgba: 4 }[format];
  const input = new Uint8Array(WIDTH * HEIGHT * channels * 2);
  const view = new DataView(input.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      let value = (pixel * 4099 + channel * 12_345) % 65_536;
      if (colorType === 0) value = ((pixel * 7 + 3) % 2 ** depth) * (65_535 / (2 ** depth - 1));
      if (colorType === 3) value = (((pixel % 2 ** depth) * 50 + channel * 30) % 256) * 257;
      if (colorType === 4 && channel < 3) value = (pixel * 4099) % 65_536;
      view.setUint16((pixel * channels + channel) * 2, value);
    }
  }
  return input;
};

const rgba16 = (png: DecodedPng): Uint8Array => {
  const eight = pngToRgba8(png);
  const output = new Uint8Array(png.width * png.height * 8);
  const view = new DataView(output.buffer);
  // 16-bit samples are compared at full precision; everything else, including colour-key alpha, is the 8-bit conversion widened by 257.
  const colorColumns = { gray: [0, 0, 0], 'gray-alpha': [0, 0, 0, 1], rgb: [0, 1, 2], rgba: [0, 1, 2, 3], indexed: [] }[png.colorType];
  for (let pixel = 0; pixel < png.width * png.height; pixel++) {
    for (let channel = 0; channel < 4; channel++) {
      const column = colorColumns[channel];
      const value = png.bitDepth === 16 && column !== undefined ? (png.samples[pixel * png.channels + column] ?? 0) : (eight[pixel * 4 + channel] ?? 0) * 257;
      view.setUint16((pixel * 4 + channel) * 2, value);
    }
  }
  return output;
};

interface OracleCase {
  readonly format: 'gray' | 'rgb' | 'rgba';
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  readonly depth: 1 | 2 | 4 | 8 | 16;
  readonly interlace: 'None' | 'PNG';
}

const COMBINATIONS = [
  ['gray', 0, 1],
  ['gray', 0, 2],
  ['gray', 0, 4],
  ['gray', 0, 8],
  ['gray', 0, 16],
  ['rgb', 2, 8],
  ['rgb', 2, 16],
  ['rgb', 3, 1],
  ['rgb', 3, 2],
  ['rgb', 3, 4],
  ['rgb', 3, 8],
  ['rgba', 4, 8],
  ['rgba', 4, 16],
  ['rgba', 6, 8],
  ['rgba', 6, 16],
] as const;
const CASES: readonly OracleCase[] = COMBINATIONS.flatMap(([format, colorType, depth]) =>
  (['None', 'PNG'] as const).map(interlace => ({ format, colorType, depth, interlace })),
);
const COLOR_TYPES = { 0: 'gray', 2: 'rgb', 3: 'indexed', 4: 'gray-alpha', 6: 'rgba' } as const;

const writePng = async (sample: OracleCase): Promise<Uint8Array> => {
  const { format, colorType, depth, interlace } = sample;
  // An indexed image gets exactly 2^depth colours and no bKGD, so ImageMagick can honour the requested bit depth.
  const palette = colorType === 3 ? ['+dither', '-colors', String(2 ** depth), '-define', 'png:exclude-chunk=bKGD'] : [];
  const input = ['-size', `${String(WIDTH)}x${String(HEIGHT)}`, '-depth', '16', `${format}:-`, ...palette];
  const png = ['-define', `png:color-type=${String(colorType)}`, '-define', `png:bit-depth=${String(depth)}`, '-interlace', interlace, 'png:-'];
  return magick([...input, ...png], rawInput(format, colorType, depth));
};

describe('png decoding against ImageMagick', () => {
  it.each(CASES)('matches $format input written as colour type $colorType at bit depth $depth with interlace $interlace', async sample => {
    const png = await writePng(sample);
    const decoded = decodePng(png);
    expect([decoded.colorType, decoded.bitDepth, decoded.interlaced]).toStrictEqual([COLOR_TYPES[sample.colorType], sample.depth, sample.interlace === 'PNG']);
    const reference = await magick(['png:-', '-depth', '16', '-endian', 'MSB', 'rgba:-'], png);
    expect(rgba16(decoded)).toStrictEqual(reference);
  });

  it.each(CASES.filter(sample => sample.depth <= 8))(
    'converts colour type $colorType at bit depth $depth with interlace $interlace to the RGBA ImageMagick reads',
    async sample => {
      const png = await writePng(sample);
      expect(pngToRgba8(decodePng(png))).toStrictEqual(await magick(['png:-', '-depth', '8', 'rgba:-'], png));
    },
  );
});
