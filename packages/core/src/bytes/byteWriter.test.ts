import { describe, expect, it } from 'vitest';

import { ByteWriter } from './byteWriter.ts';

describe('growable byte writer', () => {
  it('appends bytes, ASCII and overlapping back-references past its initial capacity', () => {
    const writer = new ByteWriter();
    writer.writeAscii('ab');
    writer.copyBack(2, 5);
    writer.writeBytes(new Uint8Array(300).fill(0x7a));
    writer.writeByte(0x21);
    writer.copyBack(4, 2);
    const text = new TextDecoder('latin1').decode(writer.toUint8Array());
    expect([writer.length, text]).toStrictEqual([310, `abababa${'z'.repeat(300)}!zz`]);
  });
});
