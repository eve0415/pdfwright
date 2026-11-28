import { describe, expect, it } from 'vitest';

import { emittedChunks, PdfEmitter } from './emitter.ts';

const produced = new Uint8Array([9]);
const withProduce = (): Uint8Array =>
  Object.assign(new Uint8Array([1, 2]), {
    *produce(): Generator<Uint8Array> {
      yield produced;
    },
  });

describe('emitted parts', () => {
  it('passes a Uint8Array through as bytes even when it carries a produce property', () => {
    expect([...emittedChunks([withProduce()])].map(chunk => [...chunk])).toStrictEqual([[1, 2]]);
  });

  it('finishes a viewed Uint8Array that carries a produce property as bytes', () => {
    const emitter = new PdfEmitter();
    emitter.view(withProduce());
    expect(emitter.finish().map(chunk => [...chunk])).toStrictEqual([[1, 2]]);
  });

  it('produces a reserved stream and refuses to finish it without streaming', () => {
    const emitter = new PdfEmitter();
    emitter.produced(1, function* () {
      yield produced;
    });
    expect([...emittedChunks(emitter.finishParts())].map(chunk => [...chunk])).toStrictEqual([[9]]);
    expect(() => emitter.finish()).toThrow('produced output requires a streamed save');
  });
});
