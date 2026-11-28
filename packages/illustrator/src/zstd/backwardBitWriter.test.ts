import { InvalidArgumentError } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createBackwardBitWriter } from './backwardBitWriter.ts';

const written = (groups: ReadonlyArray<readonly [value: number, bits: number]>): Uint8Array => {
  const writer = createBackwardBitWriter();
  for (const [value, bits] of groups) {
    writer.write(value, bits);
  }
  return writer.finish();
};

describe('backward bit writer', () => {
  // RFC 8878, 3.1.1.3.2.1.2 and 4.1: bit groups fill each byte from its least significant bit, and a final 1 bit marks where the stream ends.
  it.each([
    { name: 'nothing', groups: [], bytes: [0b1] },
    { name: 'a zero-width group', groups: [[0, 0]], bytes: [0b1] },
    {
      name: 'three bits then one',
      groups: [
        [5, 3],
        [1, 1],
      ],
      bytes: [0b1_1101],
    },
    { name: 'seven bits', groups: [[0, 7]], bytes: [0b1000_0000] },
    { name: 'exactly eight bits', groups: [[0xab, 8]], bytes: [0xab, 0b1] },
    {
      name: 'a group across a byte boundary',
      groups: [
        [5, 3],
        [1023, 10],
      ],
      bytes: [0b1111_1101, 0b11_1111],
    },
    { name: 'the widest group', groups: [[2 ** 24 - 1, 24]], bytes: [0xff, 0xff, 0xff, 0b1] },
  ] as const)('writes $name', ({ groups, bytes }) => {
    expect(written(groups)).toStrictEqual(new Uint8Array(bytes));
  });

  it.each([
    { value: 8, bits: 3 },
    { value: -1, bits: 2 },
    { value: 1.5, bits: 2 },
    { value: 0, bits: 25 },
    { value: 0, bits: -1 },
    { value: 0, bits: 1.5 },
  ])('refuses value $value in $bits bits', ({ value, bits }) => {
    const writer = createBackwardBitWriter();
    expect(() => {
      writer.write(value, bits);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      writer.write(value, bits);
    }).toThrow(/invalid Zstandard bit group/u);
    expect(writer.finish()).toStrictEqual(new Uint8Array([0b1]));
  });
});
