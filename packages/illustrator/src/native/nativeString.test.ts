import { ValidationError } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseNativeLiteral } from '../read/nativeTokenizer.ts';

import { escapeNativeString, escapeXmlIdentifier } from './nativeString.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const hasControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
};

describe('native strings', () => {
  it('escapes PostScript punctuation while keeping UTF-8 name bytes', () => {
    expect(decode(escapeNativeString(String.raw`Die (outer) \ ＣＵＴ`))).toBe(String.raw`(Die \(outer\) \\ ＣＵＴ)`);
    expect(decode(escapeNativeString(''))).toBe('()');
  });

  it('rejects control characters and non-ASCII values in ASCII-only fields', () => {
    expect(() => escapeNativeString('line\nfeed')).toThrow(ValidationError);
    expect(() => escapeNativeString('日本語', 'ascii')).toThrow(ValidationError);
    expect(decode(escapeNativeString('Title (one)', 'ascii'))).toBe(String.raw`(Title \(one\))`);
  });

  it.each([
    ['the last C0 control', '\u001F', 'utf8'],
    ['DEL', '\u007F', 'utf8'],
    ['a lone high surrogate', '\uD800', 'utf8'],
    ['a lone low surrogate between letters', 'a\uDFFFb', 'utf8'],
    ['the first non-ASCII character in an ASCII field', '\u0080', 'ascii'],
  ] as const)('rejects %s', (_name, value, encoding) => {
    expect(() => escapeNativeString(value, encoding)).toThrow(ValidationError);
    expect(() => escapeNativeString(value, encoding)).toThrow(expect.objectContaining({ reason: 'illustrator-model' }));
  });

  it.each([
    ['a space, the first printable character', ' ', 'ascii', [40, 32, 41]],
    ['a tilde, the last printable ASCII character', '~', 'ascii', [40, 126, 41]],
    ['the first non-ASCII character as UTF-8', '\u0080', 'utf8', [40, 0xc2, 0x80, 41]],
    ['an astral character as four UTF-8 bytes', '😀', 'utf8', [40, 0xf0, 0x9f, 0x98, 0x80, 41]],
  ] as const)('writes %s', (_name, value, encoding, expected) => {
    expect(escapeNativeString(value, encoding)).toStrictEqual(new Uint8Array(expected));
  });

  it('escapes XML identifiers without losing Unicode names', () => {
    expect(escapeXmlIdentifier('Base 30%')).toBe('Base_30_x25_');
    expect(escapeXmlIdentifier('レイヤー 1')).toBe('レイヤー_1');
    expect(escapeXmlIdentifier('Die (outer)')).toBe('Die__x28_outer_x29_');
    expect(escapeXmlIdentifier('3 plates')).toBe('_x33__plates');
  });

  it.each([
    ['an underscore inside a name', 'A_B', 'A_x5f_B'],
    ['a leading underscore', '_a', '_x5f_a'],
    ['a full stop and a hyphen after a letter', 'a.b-c', 'a.b-c'],
    ['a leading full stop', '.a', '_x2e_a'],
    ['a leading hyphen', '-a', '_x2d_a'],
    ['a leading combining mark', '́a', '_x301_a'],
    ['an astral character as one code point', '😀', '_x1f600_'],
    ['a digit after a leading space', ' 3', '_3'],
    ['an empty name', '', ''],
  ] as const)('escapes %s in an XML identifier', (_name, value, expected) => {
    expect(escapeXmlIdentifier(value)).toBe(expected);
  });

  it('keeps a space apart from an underscore and a percent sign apart from its escape text', () => {
    expect(escapeXmlIdentifier('A B')).not.toBe(escapeXmlIdentifier('A_B'));
    expect(escapeXmlIdentifier('A%')).not.toBe(escapeXmlIdentifier('A_x25_'));
  });
});

describe('properties', () => {
  const punctuated = fc.string({ unit: fc.constantFrom('(', ')', '\\', ' ', '_', '%', '.', '-', '3', 'a', 'é', '́', 'Ａ', '😀') });
  const printable = fc.oneof(
    punctuated,
    fc.string({ unit: 'binary' }).filter(value => value.isWellFormed() && !hasControl(value)),
  );

  it('reads back every printable string it escapes', () => {
    fc.assert(
      fc.property(printable, value => {
        expect(parseNativeLiteral(decode(escapeNativeString(value)), 0)).toBe(value);
      }),
    );
  });

  it('writes only XML name characters, starting with a letter or underscore', () => {
    fc.assert(
      fc.property(printable, value => {
        expect(escapeXmlIdentifier(value)).toMatch(/^(?:[\p{L}_][\p{L}\p{M}\p{N}_.-]*)?$/u);
      }),
    );
  });
});
