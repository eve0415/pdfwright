import { ParseError } from '../error/parseError.ts';

import { BoundedOutput } from './boundedOutput.ts';

const CLEAR = 256;
const EOD = 257;

/**
 * ISO 32000-1:2008, 7.4.4.2: codes of 9 to 12 bits, 256 clears the table and 257 marks EOD.
 * With EarlyChange 1 (the default, Table 8) the code length grows one code early.
 */
export const decodeLzw = (data: Uint8Array, options: { readonly earlyChange: number; readonly maxOutputBytes: number }): Uint8Array => {
  const output = new BoundedOutput(options.maxOutputBytes, 'LZWDecode');
  const early = options.earlyChange === 0 ? 0 : 1;
  const table: Uint8Array[] = [];
  for (let byte = 0; byte < 256; byte++) table.push(Uint8Array.of(byte));
  table.push(new Uint8Array(), new Uint8Array());
  let width = 9;
  let buffer = 0;
  let bits = 0;
  let previous: Uint8Array | undefined = undefined;
  for (const [offset, byte] of data.entries()) {
    buffer = buffer * 256 + byte;
    bits += 8;
    while (bits >= width) {
      const divisor = 2 ** (bits - width);
      const code = Math.floor(buffer / divisor);
      buffer %= divisor;
      bits -= width;
      if (code === EOD) return output.toUint8Array();
      if (code === CLEAR) {
        table.length = 258;
        width = 9;
        previous = undefined;
        continue;
      }
      let entry = table[code];
      if (entry === undefined) {
        // The code being defined by this step: the previous sequence followed by its own first byte.
        if (code !== table.length || previous === undefined) throw new ParseError('LZWDecode data holds a code that is not in the table', offset);
        entry = Uint8Array.of(...previous, previous[0] ?? 0);
      }
      output.pushBytes(entry);
      if (previous !== undefined && table.length < 4096) table.push(Uint8Array.of(...previous, entry[0] ?? 0));
      previous = entry;
      if (table.length + early >= 2 ** width && width < 12) width++;
    }
  }
  return output.toUint8Array();
};
