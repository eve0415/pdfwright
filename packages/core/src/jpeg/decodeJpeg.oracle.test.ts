import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { arrayBuffer, text } from 'node:stream/consumers';

import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { decodeJpeg } from './decodeJpeg.ts';

const magick = async (args: readonly string[], input: Uint8Array): Promise<Uint8Array> => {
  const child = spawn('magick', args);
  child.stdin.end(input);
  const [output, errors, closed] = await Promise.all([arrayBuffer(child.stdout), text(child.stderr), once(child, 'close')]);
  if (closed[0] !== 0) throw new Error(errors);
  return new Uint8Array(output);
};

const rgb = (): Uint8Array => {
  const bytes = new Uint8Array(32 * 32 * 3);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const offset = (y * 32 + x) * 3;
      bytes[offset] = (x * 7 + y * 3) % 256;
      bytes[offset + 1] = (x * 2 + y * 6) % 256;
      bytes[offset + 2] = (x * 3 + y * 4) % 256;
    }
  }
  return bytes;
};

const decoded = (bytes: Uint8Array): Uint8Array => {
  const result = decodeJpeg(bytes);
  const output = new Uint8Array(result.width * result.height * result.components);
  let offset = 0;
  for (const row of result.rows()) {
    output.set(row, offset);
    offset += row.length;
  }
  expect(offset).toBe(output.length);
  return output;
};

const maximumDifference = (actual: Uint8Array, reference: Uint8Array): number => {
  let maximum = 0;
  for (let index = 0; index < actual.length; index++) maximum = Math.max(maximum, Math.abs((actual[index] ?? 0) - (reference[index] ?? 0)));
  return maximum;
};

const markerOffset = (bytes: Uint8Array, marker: number): number => {
  for (let index = 0; index < bytes.length - 1; index++) if (bytes[index] === 0xff && bytes[index + 1] === marker) return index;
  throw new Error(`marker ${String(marker)} is missing`);
};

const withAdobe = (jpeg: Uint8Array, transform: number): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xee, 0, 14, 65, 100, 111, 98, 101, 0, 100, 0, 0, 0, 0, transform, ...jpeg.subarray(2)]);

const gray = (): Uint8Array => Uint8Array.from(Array.from({ length: 32 * 32 }, (_, index) => (index * 31) % 256));

const fullyDecode = (jpeg: Uint8Array): void => {
  for (const row of decodeJpeg(jpeg).rows()) void row;
};

describe('jpeg decoding against ImageMagick libjpeg', () => {
  it.each(['1x1,1x1,1x1', '2x1,1x1,1x1', '2x2,1x1,1x1'])('decodes generated RGB JPEG with sampling %s', async sampling => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', sampling, '-quality', '90', 'jpeg:-'], rgb());
    const reference = await magick(['-define', 'jpeg:fancy-upsampling=off', 'jpeg:-', '-depth', '8', 'rgb:-'], jpeg);
    const actual = decoded(jpeg);
    expect(actual).toHaveLength(reference.length);
    expect(maximumDifference(actual, reference)).toBeLessThanOrEqual(2);
  });

  it('decodes generated grayscale and 8-bit SOF1 images', async () => {
    const monochrome = await magick(['-size', '32x32', '-depth', '8', 'gray:-', '-quality', '90', 'jpeg:-'], gray());
    const grayReference = await magick(['jpeg:-', '-depth', '8', 'gray:-'], monochrome);
    expect(maximumDifference(decoded(monochrome), grayReference)).toBeLessThanOrEqual(1);
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', '1x1,1x1,1x1', '-quality', '90', 'jpeg:-'], rgb());
    const extended = Uint8Array.from(jpeg);
    extended[markerOffset(extended, 0xc0) + 1] = 0xc1;
    expect(decoded(extended)).toStrictEqual(decoded(jpeg));
  });

  it('decodes restart intervals and reads Adobe APP14 colour transform', async () => {
    const jpeg = await magick(
      ['-size', '32x32', '-depth', '8', 'rgb:-', '-sampling-factor', '1x1,1x1,1x1', '-define', 'jpeg:restart-interval=4', '-quality', '90', 'jpeg:-'],
      rgb(),
    );
    expect(markerOffset(jpeg, 0xdd)).toBeGreaterThan(0);
    const reference = await magick(['-define', 'jpeg:fancy-upsampling=off', 'jpeg:-', '-depth', '8', 'rgb:-'], jpeg);
    expect(maximumDifference(decoded(jpeg), reference)).toBeLessThanOrEqual(2);
    const adobe = withAdobe(jpeg, 1);
    expect(decodeJpeg(adobe).adobeColorTransform).toBe(1);
    expect(decoded(adobe)).toStrictEqual(decoded(jpeg));
  });

  it('refuses multi-scan and Adobe YCCK markers with typed reasons', async () => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], rgb());
    const multiscanned = Uint8Array.from(jpeg);
    multiscanned[markerOffset(multiscanned, 0xda) + 4] = 2;
    expect(() => decodeJpeg(multiscanned)).toThrow(UnsupportedFeatureError);
    expect(() => decodeJpeg(withAdobe(jpeg, 2))).toThrow(UnsupportedFeatureError);
    expect(() => decodeJpeg(jpeg, { maxRowBytes: 1 })).toThrow(ResourceLimitError);
  });

  it('rejects every truncation and invalid marker length of a generated JPEG', async () => {
    const jpeg = await magick(['-size', '32x32', '-depth', '8', 'rgb:-', '-quality', '90', 'jpeg:-'], rgb());
    for (let length = 0; length < jpeg.length; length++) {
      expect(() => {
        fullyDecode(jpeg.subarray(0, length));
      }).toThrow(ParseError);
    }
    const quantization = markerOffset(jpeg, 0xdb);
    for (const length of [0, 1, 65_535]) {
      const malformed = Uint8Array.from(jpeg);
      malformed[quantization + 2] = Math.floor(length / 256);
      malformed[quantization + 3] = length % 256;
      expect(() => {
        fullyDecode(malformed);
      }).toThrow(ParseError);
    }
  });
});
