import { describe, expect, it } from 'vitest';

import { ByteSource } from '../parse/byteSource.ts';

import { locateHeader, locateStartxref, sectionStartNear } from './locate.ts';

const source = (text: string, chunk = 0): ByteSource => {
  const bytes = Uint8Array.from(text, character => character.codePointAt(0) ?? 0);
  if (chunk === 0) return new ByteSource(bytes);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunk) chunks.push(bytes.subarray(offset, offset + chunk));
  return new ByteSource(chunks);
};

describe('header and startxref location', () => {
  it('finds the header and its version, also after leading junk', () => {
    expect(locateHeader(source('%PDF-1.7\n%âã\n'))).toStrictEqual({ offset: 0, version: '1.7' });
    const junk = 'junk '.repeat(300);
    expect(locateHeader(source(`${junk}%PDF-2.0\n`))).toStrictEqual({ offset: 1500, version: '2.0' });
    const short = junk.slice(1000);
    expect(locateHeader(source(`${short}%PDF-1.3\n`, 7))).toStrictEqual({ offset: 500, version: '1.3' });
    expect(locateHeader(source('%PDF-x\n'))).toStrictEqual({ offset: 0, version: '' });
    expect(locateHeader(source('no header here'))).toBeUndefined();
  });

  it('reads the last startxref and its offset, ignoring trailing garbage and earlier ones', () => {
    const text = '%PDF-1.4\nstartxref\n0\n%%EOF\nxref\nstartxref\n  1234\r\n%%EOF\r\n\u0000\u0000garbage';
    expect(locateStartxref(source(text))).toStrictEqual({ keyword: 32, offset: 1234 });
    expect(locateStartxref(source(text, 5))).toStrictEqual({ keyword: 32, offset: 1234 });
    const padded = `startxref\n99\n%%EOF${' '.repeat(10_000)}`;
    expect(locateStartxref(source(padded))).toStrictEqual({ keyword: 0, offset: 99 });
    expect(locateStartxref(source('startxref\n%%EOF'))).toBeUndefined();
    expect(locateStartxref(source('%PDF-1.4 no trailer'))).toBeUndefined();
  });

  it('accepts a section start exactly or a few bytes off', () => {
    const text = `${' '.repeat(100)}xref\n0 1\n${' '.repeat(50)}7 0 obj\n<</Type/XRef>>\n8 0 obj\n<</Type/Page>>`;
    expect(sectionStartNear(source(text), 100)).toStrictEqual({ offset: 100, corrected: false });
    expect(sectionStartNear(source(text), 98)).toStrictEqual({ offset: 100, corrected: false });
    expect(sectionStartNear(source(text), 107)).toStrictEqual({ offset: 100, corrected: true });
    expect(sectionStartNear(source(text), 162)).toStrictEqual({ offset: 159, corrected: true });
    expect(sectionStartNear(source('%PDF-1.4 nothing to find'), 5)).toBeUndefined();
  });

  it('corrects only to cross-reference streams, not to other objects', () => {
    const text = `${' '.repeat(100)}xref\n0 1\n${' '.repeat(50)}7 0 obj\n<</Type/XRef>>\n8 0 obj\n<</Type/Page>>`;
    expect(sectionStartNear(source(text), 187)).toStrictEqual({ offset: 159, corrected: true });
  });
});
