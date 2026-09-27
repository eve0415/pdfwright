import { ParseError } from '../error/parseError.ts';

import { BoundedOutput } from './boundedOutput.ts';

// ISO 32000-1:2008, 7.4.5: a length byte of 0 to 127 copies the next length + 1 bytes, 129 to 255 repeats the next byte 257 - length times, and 128 marks EOD.
export const decodeRunLength = (data: Uint8Array, maxOutputBytes: number): Uint8Array => {
  const output = new BoundedOutput(maxOutputBytes, 'RunLengthDecode');
  let position = 0;
  while (position < data.length) {
    const length = data[position] ?? 128;
    if (length === 128) break;
    if (length < 128) {
      if (position + 1 + length + 1 > data.length) throw new ParseError('RunLengthDecode data ends inside a literal run', position);
      output.pushBytes(data.subarray(position + 1, position + 2 + length));
      position += length + 2;
    } else {
      if (position + 1 >= data.length) throw new ParseError('RunLengthDecode data ends inside a repeated run', position);
      const byte = data[position + 1] ?? 0;
      for (let count = 0; count < 257 - length; count++) output.push(byte);
      position += 2;
    }
  }
  return output.toUint8Array();
};
