import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteWriter } from './byteWriter.ts';

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('growable byte writer', () => {
  it('appends bytes, ASCII and overlapping back-references past its initial capacity', () => {
    const writer = new ByteWriter();
    writer.writeAscii('ab');
    writer.copyBack(2, 5);
    writer.writeBytes(new Uint8Array(300).fill(0x7a));
    writer.writeAscii('xyz!');
    writer.copyBack(4, 2);
    expect([writer.length, latin1(writer.toUint8Array())]).toStrictEqual([313, `abababa${'z'.repeat(300)}xyz!xy`]);
  });

  it.each([
    ['abc', 3, 3, 'abcabc'],
    ['abcd', 4, 3, 'abcdabc'],
    ['abc', 2, 3, 'abcbcb'],
    ['abc', 1, 4, 'abccccc'],
  ])('copies a back-reference into %s at distance %i for %i bytes as %s', (start, distance, length, expected) => {
    const writer = new ByteWriter();
    writer.writeAscii(start);
    writer.copyBack(distance, length);
    expect(latin1(writer.toUint8Array())).toBe(expected);
  });

  it('reports the last byte written, and none before the first write or after draining', () => {
    const writer = new ByteWriter();
    const before = writer.last;
    writer.writeAscii('ab');
    const afterAscii = writer.last;
    writer.writeByte(0x63);
    const afterByte = writer.last;
    writer.drain();
    expect([before, afterAscii, afterByte, writer.last]).toStrictEqual([undefined, 0x62, 0x63, undefined]);
  });

  it('drains its content into an array that later writes do not reach', () => {
    const writer = new ByteWriter();
    writer.writeAscii('ab');
    const drained = writer.drain();
    const lengthAfterDrain = writer.length;
    writer.writeAscii('c');
    expect([latin1(drained), lengthAfterDrain, latin1(writer.toUint8Array())]).toStrictEqual(['ab', 0, 'c']);
  });

  it('returns a copy that writing into does not change the writer', () => {
    const writer = new ByteWriter();
    writer.writeAscii('ab');
    const copy = writer.toUint8Array();
    copy[0] = 0x7a;
    writer.writeAscii('c');
    expect(latin1(writer.toUint8Array())).toBe('abc');
  });

  it.each([
    [255, 1],
    [256, 1],
    [256, 257],
    [10, 2000],
  ])('keeps every byte when %i bytes are followed by a write of %i', (first, second) => {
    const head = Uint8Array.from({ length: first }, (_, index) => index % 251);
    const tail = Uint8Array.from({ length: second }, (_, index) => 250 - (index % 241));
    const writer = new ByteWriter();
    writer.writeBytes(head);
    writer.writeBytes(tail);
    expect(writer.toUint8Array()).toStrictEqual(Uint8Array.from([...head, ...tail]));
  });

  it('leaves the length unchanged for an empty write', () => {
    const writer = new ByteWriter();
    writer.writeAscii('ab');
    writer.writeBytes(new Uint8Array());
    writer.writeAscii('');
    expect([writer.length, latin1(writer.toUint8Array())]).toStrictEqual([2, 'ab']);
  });
});

describe('properties', () => {
  type Step =
    | { readonly kind: 'byte'; readonly byte: number }
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'ascii'; readonly codes: ReadonlyArray<number> }
    | { readonly kind: 'copy'; readonly distance: number; readonly length: number }
    | { readonly kind: 'drain' };

  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.integer({ min: 0, max: 255 }).map(byte => ({ kind: 'byte', byte }) as const),
    fc.uint8Array({ maxLength: 600 }).map(bytes => ({ kind: 'bytes', bytes }) as const),
    fc.array(fc.integer({ min: 0, max: 127 }), { maxLength: 40 }).map(codes => ({ kind: 'ascii', codes }) as const),
    fc
      .record({ distance: fc.integer({ min: 1, max: 300 }), length: fc.integer({ min: 1, max: 300 }) })
      .map(({ distance, length }) => ({ kind: 'copy', distance, length }) as const),
    fc.constant({ kind: 'drain' } as const),
  );

  it('holds the same bytes as a plain array model after every step', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), steps => {
        const writer = new ByteWriter();
        let model: Array<number> = [];
        const states: Array<{ readonly written: Uint8Array; readonly expected: Uint8Array }> = [];
        for (const next of steps) {
          if (next.kind === 'byte') {
            writer.writeByte(next.byte);
            model.push(next.byte);
          } else if (next.kind === 'bytes') {
            writer.writeBytes(next.bytes);
            model.push(...next.bytes);
          } else if (next.kind === 'ascii') {
            writer.writeAscii(String.fromCodePoint(...next.codes));
            model.push(...next.codes);
          } else if (next.kind === 'copy') {
            // A back-reference may only reach bytes already written.
            if (next.distance <= model.length) {
              writer.copyBack(next.distance, next.length);
              const source = model.length - next.distance;
              for (let index = 0; index < next.length; index++) {
                model.push(model[source + index] ?? 0);
              }
            }
          } else {
            states.push({ written: writer.drain(), expected: Uint8Array.from(model) });
            model = [];
          }
          states.push({ written: writer.toUint8Array(), expected: Uint8Array.from(model) });
        }
        expect(states.map(state => state.written)).toStrictEqual(states.map(state => state.expected));
      }),
    );
  });
});
