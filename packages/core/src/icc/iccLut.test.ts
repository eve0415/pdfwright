import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { readLut } from './iccLut.ts';

interface LutSpec {
  readonly grid: number;
  // Nine raw s15Fixed16 integers.
  readonly matrix: ReadonlyArray<number>;
  readonly input: ReadonlyArray<ReadonlyArray<number>>;
  readonly clut: ReadonlyArray<number>;
  readonly output: ReadonlyArray<ReadonlyArray<number>>;
}

// ICC.1:2022, 10.10 Table 40 and 10.11 Table 44: the header, the matrix, then input tables, CLUT and output tables, one or two bytes per value.
const lutTag = (kind: 'lut8' | 'lut16', spec: LutSpec): Uint8Array => {
  const width = kind === 'lut8' ? 1 : 2;
  const headerSize = kind === 'lut8' ? 48 : 52;
  const values = [...spec.input.flat(), ...spec.clut, ...spec.output.flat()];
  const bytes = new Uint8Array(headerSize + values.length * width);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(kind === 'lut8' ? 'mft1' : 'mft2'));
  bytes[8] = spec.input.length;
  bytes[9] = spec.output.length;
  bytes[10] = spec.grid;
  for (const [index, value] of spec.matrix.entries()) {
    view.setInt32(12 + index * 4, value);
  }
  if (kind === 'lut16') {
    view.setUint16(48, spec.input[0]?.length ?? 0);
    view.setUint16(50, spec.output[0]?.length ?? 0);
  }
  for (const [index, value] of values.entries()) {
    if (width === 1) {
      bytes[headerSize + index] = value;
    } else {
      view.setUint16(headerSize + index * 2, value);
    }
  }
  return bytes;
};

const expected = (kind: 'lut8' | 'lut16', spec: LutSpec) => {
  const array = (values: ReadonlyArray<number>): Uint8Array | Uint16Array => (kind === 'lut8' ? Uint8Array.from(values) : Uint16Array.from(values));
  return {
    kind,
    matrix: spec.matrix.map(value => value / 65_536),
    input: spec.input.map(values => ({ kind: 'table', values: array(values) })),
    clut: { gridPoints: spec.input.map(() => spec.grid), inputChannels: spec.input.length, outputChannels: spec.output.length, values: array(spec.clut) },
    output: spec.output.map(values => ({ kind: 'table', values: array(values) })),
  };
};

const ramp = Array.from({ length: 256 }, (_, index) => index);

// Distinct coefficients, one of them negative, so a matrix read from the wrong offset or as unsigned shows.
const matrix = [0x1_00_00, -0x80_00, 0x2_00_00, 0x40_00, 0x1_80_00, -0x1_00_00, 0x20_00, 0x3_00_00, 0x10_00];

const header = (kind: 'lut8' | 'lut16', dimensions: readonly [number, number, number], tables: readonly [number, number] = [2, 2]): Uint8Array => {
  const bytes = new Uint8Array(kind === 'lut8' ? 48 : 52);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(kind === 'lut8' ? 'mft1' : 'mft2'));
  bytes.set(dimensions, 8);
  if (kind === 'lut16') {
    view.setUint16(48, tables[0]);
    view.setUint16(50, tables[1]);
  }
  return bytes;
};

// Returns the reason and offset of an InvalidProfileError, and lets any other outcome fail the test.
const failure = (bytes: Uint8Array, limit = bytes.length): 'accepted' | { readonly reason: string; readonly offset: number } => {
  try {
    readLut(bytes, 0, limit);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError) {
      return { reason: error.reason, offset: error.offset };
    }
    throw error;
  }
};

const lutSpec = (kind: 'lut8' | 'lut16') => {
  const value = fc.integer({ min: 0, max: kind === 'lut8' ? 0xff : 0xff_ff });
  return fc
    .record({
      inputs: fc.integer({ min: 1, max: 3 }),
      outputs: fc.integer({ min: 1, max: 3 }),
      grid: fc.integer({ min: 2, max: 4 }),
      inputLength: kind === 'lut8' ? fc.constant(256) : fc.integer({ min: 2, max: 9 }),
      outputLength: kind === 'lut8' ? fc.constant(256) : fc.integer({ min: 2, max: 9 }),
    })
    .chain(({ inputs, outputs, grid, inputLength, outputLength }) =>
      fc.record({
        grid: fc.constant(grid),
        matrix: fc.array(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }), { minLength: 9, maxLength: 9 }),
        input: fc.array(fc.array(value, { minLength: inputLength, maxLength: inputLength }), { minLength: inputs, maxLength: inputs }),
        clut: fc.array(value, { minLength: outputs * grid ** inputs, maxLength: outputs * grid ** inputs }),
        output: fc.array(fc.array(value, { minLength: outputLength, maxLength: outputLength }), { minLength: outputs, maxLength: outputs }),
      }),
    );
};

describe('icc lut8 and lut16 tags', () => {
  it('reads lut8 tables and a two-point CLUT in channel order', () => {
    const spec = {
      grid: 2,
      matrix,
      input: [ramp, ramp.toReversed()],
      clut: Array.from({ length: 12 }, (_, index) => 10 + index),
      output: [Array.from({ length: 256 }, () => 7), ramp, ramp.map(value => value >> 1)],
    };
    const bytes = lutTag('lut8', spec);
    expect(readLut(bytes, 0, bytes.length)).toStrictEqual(expected('lut8', spec));
  });

  it('reads lut16 tables and rejects a tag one byte short of its output tables', () => {
    const spec = { grid: 2, matrix, input: [[1, 2]], clut: [3, 4], output: [[5, 6]] };
    const bytes = lutTag('lut16', spec);
    expect(bytes).toHaveLength(64);
    expect(readLut(bytes, 0, 64)).toStrictEqual(expected('lut16', spec));
    expect(() => readLut(bytes, 0, 63)).toThrow(InvalidProfileError);
    expect(failure(bytes, 63)).toStrictEqual({ reason: 'bad-tag-data', offset: 0 });
  });

  it.each([
    { kind: 'lut8', length: 47 },
    { kind: 'lut16', length: 51 },
  ] as const)('rejects a $kind tag shorter than its $length + 1 byte header', ({ kind, length }) => {
    const bytes = header(kind, [1, 1, 2]).subarray(0, length);
    expect(failure(bytes)).toStrictEqual({ reason: 'bad-tag-data', offset: 0 });
  });

  it('rejects a tag of another type', () => {
    const bytes = header('lut8', [1, 1, 2]);
    bytes.set(new TextEncoder().encode('mft3'));
    expect(() => readLut(bytes, 0, bytes.length)).toThrow(InvalidProfileError);
    expect(() => readLut(bytes, 0, bytes.length)).toThrow(expect.objectContaining({ reason: 'tag-type-mismatch', offset: 0 }));
  });

  // ICC.1:2022, 10.10 and 10.11: 1 to 15 input and output channels, at least two grid points, and lut16 tables of 2 to 4096 entries.
  it.each([
    { name: 'no input channels', dimensions: [0, 1, 2], offset: 8 },
    { name: '16 input channels', dimensions: [16, 1, 2], offset: 8 },
    { name: 'no output channels', dimensions: [1, 0, 2], offset: 8 },
    { name: '16 output channels', dimensions: [1, 16, 2], offset: 8 },
    { name: 'no grid points', dimensions: [1, 1, 0], offset: 8 },
    { name: 'one grid point', dimensions: [1, 1, 1], offset: 8 },
  ] as const)('rejects a lut8 tag with $name', ({ dimensions, offset }) => {
    expect(failure(header('lut8', dimensions))).toStrictEqual({ reason: 'bad-tag-data', offset });
  });

  it.each([
    { name: 'input tables of 1 entry', tables: [1, 2] },
    { name: 'input tables of 4097 entries', tables: [4097, 2] },
    { name: 'output tables of 1 entry', tables: [2, 1] },
    { name: 'output tables of 4097 entries', tables: [2, 4097] },
  ] as const)('rejects a lut16 tag with $name', ({ tables }) => {
    expect(failure(header('lut16', [1, 1, 2], tables))).toStrictEqual({ reason: 'bad-tag-data', offset: 48 });
  });

  it('accepts 15 input and 15 output channels and lut16 tables of 2 and 4096 entries', () => {
    const wide = {
      grid: 2,
      matrix,
      input: Array.from({ length: 15 }, (_, channel) => [channel, 255 - channel]),
      clut: Array.from({ length: 15 * 2 ** 15 }, (_, index) => index % 251),
      output: Array.from({ length: 15 }, (_, channel) => [channel, channel + 1]),
    };
    const lut16 = lutTag('lut16', wide);
    expect(readLut(lut16, 0, lut16.length)).toStrictEqual(expected('lut16', wide));
    const long = {
      grid: 2,
      matrix,
      input: [Array.from({ length: 4096 }, (_, index) => index * 16)],
      clut: [1, 2],
      output: [Array.from({ length: 4096 }, (_, index) => 65_535 - index * 16)],
    };
    const tables = lutTag('lut16', long);
    expect(readLut(tables, 0, tables.length)).toStrictEqual(expected('lut16', long));
  });

  it('caps the CLUT at exactly 16,777,216 entries', () => {
    // Six inputs with 16 grid points and one output is exactly the cap, so it passes the cap and fails only as truncated data.
    expect(failure(header('lut8', [6, 1, 16]))).toStrictEqual({ reason: 'bad-tag-data', offset: 0 });
    const over = header('lut8', [6, 2, 16]);
    expect(() => readLut(over, 0, over.length)).toThrow(ResourceLimitError);
  });

  describe('properties', () => {
    it.each(['lut8', 'lut16'] as const)('decodes an encoded %s tag and rejects every truncation of it', kind => {
      fc.assert(
        fc.property(lutSpec(kind), fc.nat(), (lut, cut) => {
          const bytes = lutTag(kind, lut);
          expect(readLut(bytes, 0, bytes.length)).toStrictEqual(expected(kind, lut));
          expect(failure(bytes, cut % bytes.length)).toStrictEqual({ reason: 'bad-tag-data', offset: 0 });
        }),
      );
    });
  });
});
