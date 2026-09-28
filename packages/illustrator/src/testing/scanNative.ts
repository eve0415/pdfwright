import { tokenizeNative } from './nativeTokenizer.ts';

const EXPONENT = /(?<![A-Za-z0-9_.])[-+]?(?:\d+(?:\.\d*)?|\.\d+)[eE][-+]?\d+(?![A-Za-z0-9_.])/gu;

const withoutLiteralStrings = (line: string): string => {
  let output = '';
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '\\' && depth > 0) {
      index++;
    } else if (character === '(') {
      depth++;
    } else if (character === ')' && depth > 0) {
      depth--;
    } else if (depth === 0) {
      output += character;
    }
  }
  return output;
};

/** Reports exponent-form numeric tokens outside native strings and binary or ASCII85 data. */
export const findExponentTokens = (native: Uint8Array): string[] => {
  const found: string[] = [];
  let ascii85 = false;
  let hexPayload = false;
  for (const record of tokenizeNative(native)) {
    if (record.kind === 'rasterData') continue;
    const { text } = record;
    if (ascii85) {
      if (text.includes('~>')) ascii85 = false;
      continue;
    }
    if (hexPayload) {
      if (text === '%%EndData') hexPayload = false;
      continue;
    }
    if (text.includes('/ASCII85Decode ,')) {
      ascii85 = !text.includes('~>');
      continue;
    }
    if (/^%%BeginData: \d+ Hex Bytes$/u.test(text)) {
      hexPayload = true;
      continue;
    }
    for (const match of withoutLiteralStrings(text).matchAll(EXPONENT)) found.push(match[0]);
  }
  return found;
};
