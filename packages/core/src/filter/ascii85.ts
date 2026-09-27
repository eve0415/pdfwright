import { ParseError } from '../error/parseError.ts';
import { isWhitespace } from '../parse/characterClass.ts';

import { BoundedOutput } from './boundedOutput.ts';

const writeGroup = (output: BoundedOutput, value: number, count: number): void => {
  const bytes = [Math.floor(value / 16_777_216) % 256, Math.floor(value / 65_536) % 256, Math.floor(value / 256) % 256, value % 256];
  for (let index = 0; index < count; index++) output.push(bytes[index] ?? 0);
};

// ISO 32000-1:2008, 7.4.3: characters ! through u carry base-85 digits, z stands for four zero bytes, ~> ends the data and white space is ignored.
export const decodeAscii85 = (data: Uint8Array, maxOutputBytes: number): Uint8Array => {
  const output = new BoundedOutput(maxOutputBytes, 'ASCII85Decode');
  let value = 0;
  let digits = 0;
  for (const [offset, byte] of data.entries()) {
    if (byte === 0x7e) break;
    if (isWhitespace(byte)) continue;
    if (byte === 0x7a) {
      // "A z character occurs in the middle of a group" shall never occur.
      if (digits !== 0) throw new ParseError('ASCII85Decode data holds z inside a group', offset);
      writeGroup(output, 0, 4);
      continue;
    }
    if (byte < 0x21 || byte > 0x75) throw new ParseError('ASCII85Decode data holds a character outside ! to u', offset);
    value = value * 85 + (byte - 0x21);
    digits++;
    if (digits === 5) {
      // "The value represented by a group of 5 characters is greater than 2^32 - 1" shall never occur.
      if (value > 0xff_ff_ff_ff) throw new ParseError('an ASCII85Decode group exceeds 2^32 - 1', offset);
      writeGroup(output, value, 4);
      value = 0;
      digits = 0;
    }
  }
  if (digits === 1) throw new ParseError('the final ASCII85Decode group holds only one character', data.length);
  if (digits > 1) {
    // A final group of n + 1 characters stands for n bytes; the encoder padded it with zero bytes, so the decoder pads with u, the highest digit.
    for (let index = digits; index < 5; index++) value = value * 85 + 84;
    writeGroup(output, value, digits - 1);
  }
  return output.toUint8Array();
};
