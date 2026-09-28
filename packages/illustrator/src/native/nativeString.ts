import { ValidationError } from '@pdfwright/core';

const encoder = new TextEncoder();

/** Encodes a PostScript literal string, preserving UTF-8 bytes in name fields. */
export const escapeNativeString = (value: string, encoding: 'utf8' | 'ascii' = 'utf8'): Uint8Array => {
  const bytes = encoder.encode(value);
  const escaped: number[] = [40];
  for (const byte of bytes) {
    if (byte < 32 || byte === 127) throw new ValidationError('native strings cannot contain control characters');
    if (encoding === 'ascii' && byte > 127) throw new ValidationError('native field requires ASCII');
    if (byte === 40 || byte === 41 || byte === 92) escaped.push(92);
    escaped.push(byte);
  }
  escaped.push(41);
  return new Uint8Array(escaped);
};

/** Makes a stable XMLUID from a layer name. */
export const escapeXmlIdentifier = (name: string): string => {
  let output = '';
  for (const character of name) {
    if (character === ' ') {
      output += '_';
    } else if (character === '%') {
      output += '_x25_';
    } else if (output.length === 0 ? /^[\p{L}_]$/u.test(character) : /^[\p{L}\p{M}\p{N}_.-]$/u.test(character)) {
      output += character;
    } else {
      output += `_x${String(character.codePointAt(0)?.toString(16))}_`;
    }
  }
  return output;
};
