import { ValidationError } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { escapeNativeString, escapeXmlIdentifier } from './nativeString.ts';
import { createNativeWriter } from './nativeWriter.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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

  it('escapes XML identifiers without losing Unicode names', () => {
    expect(escapeXmlIdentifier('Base 30%')).toBe('Base_30_x25_');
    expect(escapeXmlIdentifier('レイヤー 1')).toBe('レイヤー_1');
    expect(escapeXmlIdentifier('Die (outer)')).toBe('Die__x28_outer_x29_');
    expect(escapeXmlIdentifier('3 plates')).toBe('_x33__plates');
  });

  it('writes CR-terminated lines and raw raster bytes at exact offsets', () => {
    const writer = createNativeWriter();
    writer.line('(', { utf8: '非表示' }, ') Ln');
    const length = writer.offset;
    writer.raw(new Uint8Array([0, 13, 10, 255]));
    expect(length).toBe(new TextEncoder().encode('( (非表示) ) Ln\r').length);
    expect(writer.finish().slice(length)).toStrictEqual(new Uint8Array([0, 13, 10, 255]));
  });
});
