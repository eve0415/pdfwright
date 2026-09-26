import { InvalidArgumentError } from '../error/invalidArgumentError.ts';

import { adler32 } from './adler32.ts';
import { BitWriter } from './bitWriter.ts';
import { writeCompressedBlock } from './deflateBlock.ts';
import { tokenize } from './lz77.ts';

export interface DeflateOptions {
  level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

const compressionLevel = (options?: DeflateOptions): number => {
  const level = options?.level ?? 6;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new InvalidArgumentError('compression level must be from 0 to 9');
  return level;
};

export const deflateRaw = (data: Uint8Array, options?: DeflateOptions): Uint8Array => {
  const level = compressionLevel(options);
  const writer = new BitWriter();
  if (level === 0) {
    // RFC 1951, 3.2.4 limits stored blocks to 65,535 bytes and writes LEN followed by one's complement NLEN.
    let offset = 0;
    do {
      const length = Math.min(65535, data.length - offset);
      const final = offset + length === data.length;
      writer.writeBits(final ? 1 : 0, 3);
      writer.alignByte();
      writer.writeByte(length & 255);
      writer.writeByte(length >>> 8);
      writer.writeByte(~length & 255);
      writer.writeByte((~length >>> 8) & 255);
      writer.writeBytes(data.subarray(offset, offset + length));
      offset += length;
    } while (offset < data.length);
  } else if (data.length === 0) writeCompressedBlock(writer, [], true);
  else {
    for (let offset = 0; offset < data.length; offset += 1024 * 1024) {
      const end = Math.min(offset + 1024 * 1024, data.length);
      const tokens = tokenize(data.subarray(offset, end), level);
      writeCompressedBlock(writer, tokens, end === data.length);
    }
  }
  return writer.finish();
};

export const deflateZlib = (data: Uint8Array, options?: DeflateOptions): Uint8Array => {
  const level = compressionLevel(options);
  const raw = deflateRaw(data, options);
  // RFC 1950, 2.2 stores CMF/FLG with FCHECK making the header divisible by 31, then an Adler-32 trailer in big-endian order.
  let flevel = 3;
  if (level <= 1) flevel = 0;
  else if (level <= 5) flevel = 1;
  else if (level === 6) flevel = 2;
  const baseFlag = flevel << 6;
  const check = (31 - ((0x78 * 256 + baseFlag) % 31)) % 31;
  const result = new Uint8Array(raw.length + 6);
  result[0] = 0x78;
  result[1] = baseFlag + check;
  result.set(raw, 2);
  const checksum = adler32(data);
  result[result.length - 4] = checksum >>> 24;
  result[result.length - 3] = (checksum >>> 16) & 255;
  result[result.length - 2] = (checksum >>> 8) & 255;
  result[result.length - 1] = checksum & 255;
  return result;
};
