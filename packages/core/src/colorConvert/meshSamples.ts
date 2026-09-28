import type { ColorTransform } from '../color/createColorTransform.ts';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

export interface MeshSamples {
  readonly data: Uint8Array;
  readonly records: number;
}

export interface MeshSampleOptions {
  readonly type: 4 | 5 | 6 | 7;
  readonly coordinateBits: number;
  readonly componentBits: number;
  readonly flagBits: number;
  readonly channels: number;
  readonly decode: readonly number[];
  readonly transform: ColorTransform;
  readonly maxBytes: number;
}

const sampleValue = (value: number, bits: number, range: { low: number; high: number }): number =>
  range.low + (value / (2 ** bits - 1)) * (range.high - range.low);

const writeColor = (reader: MeshBitReader, writer: MeshBitWriter, options: MeshSampleOptions): void => {
  const input = new Float64Array(options.channels);
  for (let channel = 0; channel < options.channels; channel++) {
    const raw = reader.read(options.componentBits);
    input[channel] = sampleValue(raw, options.componentBits, { low: options.decode[4 + channel * 2] ?? 0, high: options.decode[5 + channel * 2] ?? 1 });
  }
  const output = new Float64Array(4);
  options.transform.convert(input, output);
  for (const value of output) writer.write(options.componentBits, Math.round(value * (2 ** options.componentBits - 1)));
};

const copyCoordinates = (reader: MeshBitReader, writer: MeshBitWriter, config: { pairs: number; bits: number }): void => {
  for (let coordinate = 0; coordinate < config.pairs * 2; coordinate++) writer.write(config.bits, reader.read(config.bits));
};

const vertexRecord = (reader: MeshBitReader, writer: MeshBitWriter, options: MeshSampleOptions): void => {
  if (options.type === 4) {
    const flag = reader.read(options.flagBits);
    if (flag % 4 > 2) throw new ParseError('Type 4 mesh edge flag is invalid', 0);
    writer.write(options.flagBits, flag);
  }
  copyCoordinates(reader, writer, { pairs: 1, bits: options.coordinateBits });
  writeColor(reader, writer, options);
  reader.alignByte();
  writer.alignByte();
};

const patchRecord = (reader: MeshBitReader, writer: MeshBitWriter, config: { options: MeshSampleOptions; first: boolean }): void => {
  const { options, first } = config;
  const flag = reader.read(options.flagBits);
  const edge = flag % 4;
  if (first && edge !== 0) throw new ParseError('the first mesh patch must start a new patch', 0);
  writer.write(options.flagBits, flag);
  let coordinates = options.type === 6 ? 8 : 12;
  if (edge === 0) coordinates = options.type === 6 ? 12 : 16;
  const colors = edge === 0 ? 4 : 2;
  copyCoordinates(reader, writer, { pairs: coordinates, bits: options.coordinateBits });
  for (let corner = 0; corner < colors; corner++) writeColor(reader, writer, options);
  reader.alignByte();
  writer.alignByte();
};

/** Rewrites only mesh colour fields; flags and coordinate bit fields retain their original encoded values. */
export const convertMeshSamples = (data: Uint8Array, options: MeshSampleOptions): MeshSamples => {
  if (data.length * 2 > options.maxBytes) throw new ResourceLimitError(`mesh conversion exceeds the in-memory ceiling (${String(options.maxBytes)} bytes)`);
  const reader = new MeshBitReader(data);
  const writer = new MeshBitWriter();
  let records = 0;
  while (reader.remainingBits > 0) {
    if (options.type === 4 || options.type === 5) vertexRecord(reader, writer, options);
    else patchRecord(reader, writer, { options, first: records === 0 });
    records++;
  }
  return { data: writer.finish(options.maxBytes), records };
};
