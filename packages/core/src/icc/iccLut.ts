import type { Curve, Matrix3 } from './iccTags.ts';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { iccSignature } from './iccSignature.ts';

export interface Clut {
  readonly gridPoints: readonly number[];
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly values: Uint8Array | Uint16Array;
}

export interface TableLut {
  readonly kind: 'lut8' | 'lut16';
  readonly matrix: Matrix3;
  readonly input: readonly Curve[];
  readonly clut: Clut;
  readonly output: readonly Curve[];
}

const table = (view: DataView, config: { offset: number; count: number; channels: number; width: 1 | 2 }): Curve[] => {
  const result: Curve[] = [];
  for (let channel = 0; channel < config.channels; channel++) {
    const start = config.offset + channel * config.count * config.width;
    const values = config.width === 1 ? new Uint8Array(view.buffer, view.byteOffset + start, config.count) : new Uint16Array(config.count);
    if (config.width === 2) for (let index = 0; index < config.count; index++) values[index] = view.getUint16(start + index * 2);
    result.push({ kind: 'table', values });
  }
  return result;
};

const dimensions = (view: DataView, offset: number, width: 1 | 2) => {
  const inputChannels = view.getUint8(offset + 8);
  const outputChannels = view.getUint8(offset + 9);
  const grid = view.getUint8(offset + 10);
  if (inputChannels < 1 || inputChannels > 15 || outputChannels < 1 || outputChannels > 15 || grid < 2) {
    throw new InvalidProfileError('invalid ICC LUT dimensions', 'bad-tag-data', { offset: offset + 8 });
  }
  const inputCount = width === 1 ? 256 : view.getUint16(offset + 48);
  const outputCount = width === 1 ? 256 : view.getUint16(offset + 50);
  if (inputCount < 2 || inputCount > 4096 || outputCount < 2 || outputCount > 4096) {
    throw new InvalidProfileError('invalid ICC LUT table length', 'bad-tag-data', { offset: offset + 48 });
  }
  let clutEntries = outputChannels;
  for (let channel = 0; channel < inputChannels; channel++) {
    if (clutEntries > Math.floor(16_777_216 / grid)) throw new ResourceLimitError('ICC CLUT exceeds 16777216 entries');
    clutEntries *= grid;
  }
  return { inputChannels, outputChannels, grid, inputCount, outputCount, clutEntries };
};

export const readLut = (bytes: Uint8Array, offset: number, limit: number): TableLut => {
  // ICC.1:2022, 10.10 Table 40 and 10.11 Table 44 specify the mft2 and mft1 layouts and matrix → input → CLUT → output order.
  const name = iccSignature(bytes, offset);
  if (name !== 'mft1' && name !== 'mft2') throw new InvalidProfileError('ICC tag must be lut8Type or lut16Type', 'tag-type-mismatch', { offset });
  const width = name === 'mft1' ? 1 : 2;
  const headerSize = width === 1 ? 48 : 52;
  if (offset < 0 || limit > bytes.length || limit - offset < headerSize) throw new InvalidProfileError('truncated ICC LUT header', 'bad-tag-data', { offset });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { inputChannels, outputChannels, grid, inputCount, outputCount, clutEntries } = dimensions(view, offset, width);
  const inputBytes = inputChannels * inputCount * width;
  const clutBytes = clutEntries * width;
  const outputBytes = outputChannels * outputCount * width;
  const required = headerSize + inputBytes + clutBytes + outputBytes;
  if (required > limit - offset) throw new InvalidProfileError('truncated ICC LUT data', 'bad-tag-data', { offset });
  const matrix: Matrix3 = [
    view.getInt32(offset + 12) / 65536,
    view.getInt32(offset + 16) / 65536,
    view.getInt32(offset + 20) / 65536,
    view.getInt32(offset + 24) / 65536,
    view.getInt32(offset + 28) / 65536,
    view.getInt32(offset + 32) / 65536,
    view.getInt32(offset + 36) / 65536,
    view.getInt32(offset + 40) / 65536,
    view.getInt32(offset + 44) / 65536,
  ];
  const inputStart = offset + headerSize;
  const clutStart = inputStart + inputBytes;
  const outputStart = clutStart + clutBytes;
  const values = width === 1 ? bytes.subarray(clutStart, clutStart + clutEntries) : new Uint16Array(clutEntries);
  if (width === 2) for (let index = 0; index < clutEntries; index++) values[index] = view.getUint16(clutStart + index * 2);
  return {
    kind: width === 1 ? 'lut8' : 'lut16',
    matrix,
    input: table(view, { offset: inputStart, count: inputCount, channels: inputChannels, width }),
    clut: { gridPoints: Array.from({ length: inputChannels }, () => grid), inputChannels, outputChannels, values },
    output: table(view, { offset: outputStart, count: outputCount, channels: outputChannels, width }),
  };
};
