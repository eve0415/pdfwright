import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { MeshBitReader, validateMeshBits } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

describe('mesh bit records', () => {
  // ISO 32000-1:2008, 8.7.4.5.5: fields are packed from the high-order bit down, and each vertex record is padded to a whole byte.
  it('keeps high-bit-first fields and byte padding', () => {
    const writer = new MeshBitWriter();
    const fields = [
      [2, 2],
      [8, 128],
      [8, 64],
      [8, 255],
      [8, 0],
      [8, 128],
    ] as const;
    for (const [bits, value] of fields) {
      writer.write(bits, value);
    }
    writer.alignByte();
    const bytes = writer.finish(6);
    expect(bytes).toStrictEqual(Uint8Array.of(0xa0, 0x10, 0x3f, 0xc0, 0x20, 0x00));
    const reader = new MeshBitReader(bytes);
    expect([reader.read(2), reader.read(8), reader.read(8), reader.read(8), reader.read(8), reader.read(8)]).toStrictEqual([2, 128, 64, 255, 0, 128]);
    reader.alignByte();
    expect(reader.remainingBits).toBe(0);
  });

  it('starts the field after a byte alignment on the next byte', () => {
    const writer = new MeshBitWriter();
    writer.write(1, 1);
    writer.alignByte();
    writer.write(1, 1);
    expect(writer.finish(2)).toStrictEqual(Uint8Array.of(0x80, 0x80));
  });

  it('rejects output beyond the mesh limit', () => {
    const writer = new MeshBitWriter();
    writer.write(8, 1);
    expect(() => writer.finish(0)).toThrow(ResourceLimitError);
    expect(writer.finish(1)).toStrictEqual(Uint8Array.of(0x01));
  });

  it('finishes an empty record as no bytes', () => {
    expect(new MeshBitWriter().finish(0)).toStrictEqual(new Uint8Array());
  });
});

describe('mesh field widths', () => {
  it.each([[0], [33], [1.5], [Number.NaN]])('rejects a %d-bit field', bits => {
    expect(() => {
      validateMeshBits(bits);
    }).toThrow(ParseError);
  });

  it.each([[1], [32]])('accepts a %d-bit field', bits => {
    expect(() => {
      validateMeshBits(bits);
    }).not.toThrow();
  });

  it.each([[0], [33]])('refuses to write a %d-bit field', bits => {
    expect(() => {
      new MeshBitWriter().write(bits, 0);
    }).toThrow(ParseError);
  });
});

describe('mesh field values', () => {
  it.each([
    [8, 256],
    [8, -1],
    [8, 1.5],
    [32, 2 ** 32],
  ])('refuses to write %d bits of %d', (bits, value) => {
    expect(() => {
      new MeshBitWriter().write(bits, value);
    }).toThrow(ParseError);
  });

  it.each([
    [8, 255, Uint8Array.of(0xff)],
    [32, 2 ** 32 - 1, Uint8Array.of(0xff, 0xff, 0xff, 0xff)],
    [32, 2 ** 31 + 1, Uint8Array.of(0x80, 0x00, 0x00, 0x01)],
  ])('writes %d bits of %d', (bits, value, expected) => {
    const writer = new MeshBitWriter();
    writer.write(bits, value);
    expect(writer.finish(4)).toStrictEqual(expected);
  });
});

describe('mesh bit reader', () => {
  it.each([
    [Uint8Array.of(0xff, 0xff, 0xff, 0xff), 4_294_967_295],
    [Uint8Array.of(0x80, 0x00, 0x00, 0x01), 2_147_483_649],
  ])('reads a 32-bit field from %o as an unsigned value', (bytes, expected) => {
    expect(new MeshBitReader(bytes).read(32)).toBe(expected);
  });

  it('reads a field that ends at the last bit and refuses one more', () => {
    const reader = new MeshBitReader(Uint8Array.of(0xff));
    expect(reader.read(8)).toBe(255);
    expect(() => reader.read(1)).toThrow(ParseError);
    expect(() => reader.read(1)).toThrow(expect.objectContaining({ offset: 1 }));
  });

  it('reports the offset of a truncated first field', () => {
    const reader = new MeshBitReader(Uint8Array.of(0xff));
    expect(() => reader.read(9)).toThrow(ParseError);
    expect(() => reader.read(9)).toThrow(expect.objectContaining({ offset: 0 }));
  });

  it('has no bits to read in an empty record', () => {
    const reader = new MeshBitReader(new Uint8Array());
    expect(reader.remainingBits).toBe(0);
    expect(() => reader.read(1)).toThrow(ParseError);
  });

  it.each([
    [0, 16],
    [8, 8],
    [3, 8],
  ])('aligns after %d bits read to leave %d bits', (read, remaining) => {
    const reader = new MeshBitReader(Uint8Array.of(0xff, 0xff));
    if (read > 0) {
      reader.read(read);
    }
    reader.alignByte();
    expect(reader.remainingBits).toBe(remaining);
  });
});

type Field = 'align' | { readonly bits: number; readonly value: number };

const fieldArbitrary: fc.Arbitrary<Field> = fc.oneof(
  fc.constant('align' as const),
  fc
    .integer({ min: 1, max: 32 })
    .chain(bits => fc.record({ bits: fc.constant(bits), value: fc.bigInt({ min: 0n, max: (1n << BigInt(bits)) - 1n }).map(Number) })),
);

const padded = (bits: string): string => bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');

// Concatenates each value's binary digits from the high-order bit down, pads to a byte at each alignment and at the end, and reads the bytes back from that text.
const referencePacking = (fields: ReadonlyArray<Field>): Uint8Array => {
  let bits = '';
  for (const field of fields) {
    bits = field === 'align' ? padded(bits) : bits + field.value.toString(2).padStart(field.bits, '0');
  }
  return Uint8Array.from(padded(bits).match(/.{8}/gu) ?? [], byte => Number.parseInt(byte, 2));
};

describe('properties', () => {
  it('writes the reference packing and reads back every field', () => {
    fc.assert(
      fc.property(fc.array(fieldArbitrary, { maxLength: 40 }), fields => {
        const writer = new MeshBitWriter();
        for (const field of fields) {
          if (field === 'align') {
            writer.alignByte();
          } else {
            writer.write(field.bits, field.value);
          }
        }
        const expected = referencePacking(fields);
        const bytes = writer.finish(expected.length);
        expect(bytes).toStrictEqual(expected);
        const reader = new MeshBitReader(bytes);
        const values = fields.map(field => {
          if (field === 'align') {
            reader.alignByte();
            return field;
          }
          return reader.read(field.bits);
        });
        expect(values).toStrictEqual(fields.map(field => (field === 'align' ? field : field.value)));
        reader.alignByte();
        expect(reader.remainingBits).toBe(0);
      }),
    );
  });
});
