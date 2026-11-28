import { describe, expect, inject, it } from 'vitest';

import { isUint8Array } from './isUint8Array.ts';

class RetaggedUint8Array extends Uint8Array {}
Object.defineProperty(RetaggedUint8Array.prototype, Symbol.toStringTag, { get: () => 'Other' });

interface FrameElement {
  readonly contentWindow: unknown;
}

interface FrameDocument {
  readonly createElement: (tag: 'iframe') => FrameElement;
  readonly body: { readonly append: (node: FrameElement) => void };
}

const isFrameDocument = (value: unknown): value is FrameDocument =>
  typeof value === 'object' &&
  value !== null &&
  'createElement' in value &&
  typeof value.createElement === 'function' &&
  'body' in value &&
  typeof value.body === 'object' &&
  value.body !== null &&
  'append' in value.body &&
  typeof value.body.append === 'function';

const isArrayConstructor = (value: unknown): value is new (length: number) => object => typeof value === 'function';

interface RealmCheck {
  readonly sameRealm: boolean;
  readonly accepted: boolean;
}

// Builds a Uint8Array in a new iframe's realm, the one input whose prototype chain does not reach this realm's Uint8Array.
const foreignUint8Array = (): RealmCheck => {
  const scope: object = globalThis;
  const document: unknown = 'document' in scope ? scope.document : undefined;
  if (!isFrameDocument(document)) {
    throw new TypeError('no document to create an iframe in');
  }
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const window = frame.contentWindow;
  const ForeignUint8Array: unknown = typeof window === 'object' && window !== null && 'Uint8Array' in window ? window.Uint8Array : undefined;
  if (!isArrayConstructor(ForeignUint8Array)) {
    throw new TypeError('the iframe has no Uint8Array');
  }
  const array = new ForeignUint8Array(1);
  return { sameRealm: Object.getPrototypeOf(array) === Uint8Array.prototype, accepted: isUint8Array(array) };
};

describe('Uint8Array brand check', () => {
  it('accepts a Uint8Array and a subclass that overrides its Symbol.toStringTag', () => {
    expect([isUint8Array(new Uint8Array(1)), isUint8Array(new RetaggedUint8Array(1))]).toStrictEqual([true, true]);
  });

  it('rejects other typed arrays, views, arrays, primitives and objects that only claim the tag', () => {
    const rejected: ReadonlyArray<unknown> = [
      new Uint8ClampedArray(1),
      new Uint16Array(1),
      new DataView(new ArrayBuffer(1)),
      [1],
      null,
      undefined,
      0,
      'Uint8Array',
      {},
      { [Symbol.toStringTag]: 'Uint8Array' },
    ];
    expect(rejected.map(value => isUint8Array(value))).toStrictEqual(rejected.map(() => false));
  });

  // Only a browser offers a test file a second realm, through an iframe.
  it.runIf(inject('runtime') === 'browser')('accepts a Uint8Array from another realm', () => {
    expect(foreignUint8Array()).toStrictEqual({ sameRealm: false, accepted: true });
  });
});
