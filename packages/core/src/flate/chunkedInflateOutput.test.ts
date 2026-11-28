import { describe, expect, it } from 'vitest';

import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { ChunkedInflateOutput } from './chunkedInflateOutput.ts';

// A byte sequence whose period is longer than the 32 KiB window, so a copy from the wrong position gives a different byte.
const byteAt = (position: number): number => (position * 7 + (position >>> 8)) & 255;

const pushed = (count: number, limit = 1_048_576): ChunkedInflateOutput => {
  const output = new ChunkedInflateOutput(limit);
  for (let position = 0; position < count; position++) {
    output.push(byteAt(position));
  }
  return output;
};

const collect = (output: ChunkedInflateOutput): Array<number> => {
  const bytes: Array<number> = [];
  for (let chunk = output.take(); chunk !== undefined; chunk = output.take()) {
    bytes.push(...chunk);
  }
  return [...bytes, ...output.finish()];
};

describe('chunked inflate output', () => {
  it('hands out a chunk once 65,536 bytes are pushed and the rest from finish', () => {
    const output = new ChunkedInflateOutput(65_537);
    expect(output.take()).toBeUndefined();
    for (let position = 0; position < 65_536; position++) {
      output.push(byteAt(position));
    }
    expect(output.take()).toStrictEqual(Uint8Array.from({ length: 65_536 }, (_, position) => byteAt(position)));
    expect(output.take()).toBeUndefined();
    output.push(66);
    expect(output.finish()).toStrictEqual(Uint8Array.of(66));
  });

  it('accepts pushes and copies up to the limit and refuses the byte past it', () => {
    const output = pushed(3, 3);
    expect(() => {
      output.push(0);
    }).toThrow(ResourceLimitError);
    expect(output.finish()).toStrictEqual(Uint8Array.of(byteAt(0), byteAt(1), byteAt(2)));
    const copied = pushed(1, 3);
    copied.copy(1, 2, 0);
    expect(copied.finish()).toStrictEqual(Uint8Array.of(byteAt(0), byteAt(0), byteAt(0)));
    expect(() => {
      pushed(1, 3).copy(1, 3, 0);
    }).toThrow(ResourceLimitError);
  });

  // RFC 1951, 3.2: distances reach back at most 32,768 bytes, and never before the start of the output.
  it.each([
    ['distance 0', 10, 0],
    ['a distance longer than the output', 10, 11],
    ['distance 32,769 after 40,000 bytes', 40_000, 32_769],
  ])('refuses %s and reports the offset it is given', (_, count, distance) => {
    expect(() => {
      pushed(count).copy(distance, 1, 99);
    }).toThrow(expect.objectContaining({ name: 'ParseError', offset: 99 }));
    expect(() => {
      pushed(count).copy(distance, 1, 99);
    }).toThrow(ParseError);
  });

  it.each([
    ['the first byte, as far back as the output reaches', 10, 10, 0],
    ['the byte 32,768 positions back, through the ring buffer', 40_000, 32_768, 40_000 - 32_768],
    ['the byte 32,767 positions back', 40_000, 32_767, 40_000 - 32_767],
  ])('copies %s', (_, count, distance, source) => {
    const output = pushed(count);
    output.copy(distance, 2, 0);
    expect(collect(output).slice(count)).toStrictEqual([byteAt(source), byteAt(source + 1)]);
  });

  it('repeats the last byte for a copy that overlaps itself', () => {
    const output = pushed(2);
    output.copy(1, 5, 0);
    expect(collect(output)).toStrictEqual([byteAt(0), ...Array.from({ length: 6 }, () => byteAt(1))]);
  });
});
