import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';

const encoder = new TextEncoder();

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
};

describe('native writer', () => {
  it('writes CR-terminated lines and raw raster bytes at exact offsets', () => {
    const writer = createNativeWriter();
    writer.line('(', { utf8: '非表示' }, ') Ln');
    const length = writer.offset;
    writer.raw(new Uint8Array([0, 13, 10, 255]));
    expect(length).toBe(new TextEncoder().encode('( (非表示) ) Ln\r').length);
    expect(writer.finish().slice(length)).toStrictEqual(new Uint8Array([0, 13, 10, 255]));
  });

  it('writes a bare CR for a line without tokens', () => {
    const writer = createNativeWriter();
    writer.raw(new Uint8Array([65]));
    writer.line();
    expect(writer.offset).toBe(2);
    expect(writer.finish()).toStrictEqual(new Uint8Array([65, 13]));
  });

  it('keeps writing after finish and returns the same bytes from repeated calls', () => {
    const writer = createNativeWriter();
    writer.line('a');
    const first = writer.finish();
    expect(writer.finish()).toStrictEqual(first);
    writer.line('b');
    expect(writer.finish()).toStrictEqual(new Uint8Array([97, 13, 98, 13]));
    expect(first).toStrictEqual(new Uint8Array([97, 13]));
  });
});

describe('properties', () => {
  const call = fc.oneof(
    fc.record({ kind: fc.constant('raw'), bytes: fc.uint8Array({ maxLength: 8 }) }),
    fc.record({ kind: fc.constant('line'), tokens: fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 }) }),
  );

  it('concatenates each call’s bytes and counts them in offset', () => {
    fc.assert(
      fc.property(fc.array(call, { maxLength: 12 }), calls => {
        const writer = createNativeWriter();
        const expected: Array<Uint8Array> = [];
        for (const entry of calls) {
          if (entry.kind === 'raw') {
            writer.raw(entry.bytes);
            expected.push(entry.bytes);
          } else {
            writer.line(...entry.tokens);
            expected.push(encoder.encode(`${entry.tokens.join(' ')}\r`));
          }
          expect(writer.offset).toBe(concat(expected).length);
        }
        expect(writer.finish()).toStrictEqual(concat(expected));
      }),
    );
  });
});
