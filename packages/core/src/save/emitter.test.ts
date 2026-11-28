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

  it('counts viewed, written and produced bytes in the offset, skips empty views and keeps viewed arrays by identity', () => {
    const emitter = new PdfEmitter();
    const viewed = Uint8Array.of(1, 2, 3);
    emitter.view(viewed);
    emitter.writer.writeAscii('ab');
    emitter.view(new Uint8Array());
    const afterWrite = emitter.offset;
    emitter.produced(5, function* () {
      yield Uint8Array.of(4, 5);
      yield Uint8Array.of(6, 7, 8);
    });
    emitter.writer.writeAscii('z');
    const parts = emitter.finishParts();
    expect([afterWrite, emitter.offset, parts.length, parts[0] === viewed]).toStrictEqual([5, 11, 4, true]);
    expect([...emittedChunks(parts)].map(chunk => [...chunk])).toStrictEqual([[1, 2, 3], [0x61, 0x62], [4, 5], [6, 7, 8], [0x7a]]);
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
