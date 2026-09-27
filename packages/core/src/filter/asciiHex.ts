import { ParseError } from '../error/parseError.ts';
import { isWhitespace } from '../parse/characterClass.ts';

import { BoundedOutput } from './boundedOutput.ts';

const hexValue = (byte: number): number => {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
};

// ISO 32000-1:2008, 7.4.2: "All white-space characters ... shall be ignored. A GREATER-THAN SIGN (3Eh) indicates EOD. Any other characters shall cause an error. If the filter encounters the EOD marker after reading an odd number of hexadecimal digits, it shall behave as if a 0 (zero) followed the last digit."
export const decodeAsciiHex = (data: Uint8Array, maxOutputBytes: number): Uint8Array => {
  const output = new BoundedOutput(maxOutputBytes, 'ASCIIHexDecode');
  let high = -1;
  for (const [offset, byte] of data.entries()) {
    if (byte === 0x3e) break;
    if (isWhitespace(byte)) continue;
    const value = hexValue(byte);
    if (value < 0) throw new ParseError('ASCIIHexDecode data holds a character that is not a hexadecimal digit', offset);
    if (high < 0) high = value;
    else {
      output.push(high * 16 + value);
      high = -1;
    }
  }
  if (high >= 0) output.push(high * 16);
  return output.toUint8Array();
};
