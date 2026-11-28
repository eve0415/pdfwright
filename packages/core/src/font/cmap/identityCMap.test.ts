import { describe, expect, it } from 'vitest';

import { latin1Bytes } from '../../testing/pdfBuilder.ts';

import { identityCMap } from './identityCMap.ts';

describe('the Identity CMaps', () => {
  it.each([
    { name: 'Identity-H', writingMode: 0 },
    { name: 'Identity-V', writingMode: 1 },
  ] as const)('reads $name as 2-byte codes, each its own CID, in writing mode $writingMode', ({ name, writingMode }) => {
    // ISO 32000-1:2008, Table 118: Identity-H "maps 2-byte character codes ranging from 0 to 65,535 to the same 2-byte CID value"; Table 119 gives the character collection Adobe-Identity-0.
    const cmap = identityCMap(name);
    expect([
      cmap.read(Uint8Array.of(0xff, 0xff, 0x41), 0),
      cmap.cid({ value: 0xff_ff, length: 2 }),
      cmap.mapped({ value: 0, length: 2 }),
      cmap.writingMode,
      cmap.cidSystemInfo,
    ]).toStrictEqual([
      { code: { value: 0xff_ff, length: 2 }, valid: true },
      0xff_ff,
      0,
      writingMode,
      { registry: latin1Bytes('Adobe'), ordering: latin1Bytes('Identity'), supplement: 0 },
    ]);
  });

  it('reads a lone last byte as an invalid 1-byte code', () => {
    expect(identityCMap('Identity-H').read(Uint8Array.of(0x00, 0x41, 0x41), 2)).toStrictEqual({ code: { value: 0x41, length: 1 }, valid: false });
  });
});
