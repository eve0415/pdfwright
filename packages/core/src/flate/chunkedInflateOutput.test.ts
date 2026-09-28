import { describe, expect, it } from 'vitest';

import { ChunkedInflateOutput } from './chunkedInflateOutput.ts';

describe('chunked inflate output', () => {
  it('takes ready chunks without allocating a collection per symbol', () => {
    const output = new ChunkedInflateOutput(65537);
    expect(output.take()).toBeUndefined();
    for (let index = 0; index < 65536; index++) output.push(65);
    expect(output.take()).toHaveLength(65536);
    expect(output.take()).toBeUndefined();
    output.push(66);
    expect(output.finish()).toStrictEqual(Uint8Array.of(66));
  });
});
