import { describe, expect, it } from 'vitest';

import { isUint8Array } from './isUint8Array.ts';

class RetaggedUint8Array extends Uint8Array {}
Object.defineProperty(RetaggedUint8Array.prototype, Symbol.toStringTag, { get: () => 'Other' });

describe('Uint8Array brand check', () => {
  it('accepts a Uint8Array and a subclass that overrides its Symbol.toStringTag', () => {
    expect([isUint8Array(new Uint8Array(1)), isUint8Array(new RetaggedUint8Array(1))]).toStrictEqual([true, true]);
  });

  it('rejects other typed arrays, views, arrays and objects that only claim the tag', () => {
    const rejected: ReadonlyArray<unknown> = [
      new Uint8ClampedArray(1),
      new Uint16Array(1),
      new DataView(new ArrayBuffer(1)),
      [1],
      null,
      {},
      { [Symbol.toStringTag]: 'Uint8Array' },
    ];
    expect(rejected.map(value => isUint8Array(value))).toStrictEqual([false, false, false, false, false, false, false]);
  });
});
