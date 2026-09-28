import { describe, expect, it } from 'vitest';

import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

describe('mesh bit records', () => {
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
    const reader = new MeshBitReader(bytes);
    expect([reader.read(2), reader.read(8), reader.read(8), reader.read(8), reader.read(8), reader.read(8)]).toStrictEqual([2, 128, 64, 255, 0, 128]);
    reader.alignByte();
    expect(reader.remainingBits).toBe(0);
  });

  it('rejects output beyond the mesh limit', () => {
    const writer = new MeshBitWriter();
    writer.write(8, 1);
    expect(() => writer.finish(0)).toThrow(ResourceLimitError);
  });
});
