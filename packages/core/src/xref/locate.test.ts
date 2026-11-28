import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteSource } from '../parse/byteSource.ts';

import { locateHeader, locatedEofEnd, locateStartxref, sectionStartNear } from './locate.ts';

const source = (text: string, chunk = 0): ByteSource => {
  const bytes = Uint8Array.from(text, character => character.codePointAt(0) ?? 0);
  if (chunk === 0) {
    return new ByteSource(bytes);
  }
  const chunks: Array<Uint8Array> = [];
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    chunks.push(bytes.subarray(offset, offset + chunk));
  }
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

  it('finds a displaced header whose own bytes cross a segment boundary', () => {
    // With 7-byte segments, the one at 1498 ends at 1505, so %PDF- at 1502 spans two segments.
    const junk = `${'junk '.repeat(300)}xx`;
    expect(locateHeader(source(`${junk}%PDF-2.0\n`, 7))).toStrictEqual({ offset: 1502, version: '2.0' });
  });

  // The first 1,024 bytes are searched as one copy; a header at 1019 fits in it and one at 1020 ends past it.
  it.each([
    [1019, 0],
    [1019, 1024],
    [1020, 0],
    [1020, 1024],
  ])('finds a header at %i with %i-byte segments', (offset, chunk) => {
    expect(locateHeader(source(`${'x'.repeat(offset)}%PDF-1.6\n`, chunk))).toStrictEqual({ offset, version: '1.6' });
  });

  it('reads the last startxref and its offset, ignoring trailing garbage and earlier ones', () => {
    const text = '%PDF-1.4\nstartxref\n0\n%%EOF\nxref\nstartxref\n  1234\r\n%%EOF\r\n\u0000\u0000garbage';
    expect(locateStartxref(source(text))).toStrictEqual({ keyword: 32, offset: 1234 });
    expect(locateStartxref(source(text, 5))).toStrictEqual({ keyword: 32, offset: 1234 });
    expect(locateStartxref(source('startxref\n%%EOF'))).toBeUndefined();
    expect(locateStartxref(source('%PDF-1.4 no trailer'))).toBeUndefined();
  });

  it('refuses a negative startxref offset', () => {
    expect(locateStartxref(source('startxref\n-5\n%%EOF'))).toBeUndefined();
  });

  // The keyword exactly 4,096 bytes from the end lies in the tail copy, even when the segment holding it is not the last one; one byte further out, the rest of the source is searched, whichever segments hold it.
  it.each([0, 5, 1024])('searches the last 4,096 bytes first and the rest of the source after them, with %i-byte segments', chunk => {
    const atLimit = `${'x'.repeat(100)}\nstartxref\n77\n%%EOF${' '.repeat(4096 - 'startxref\n77\n%%EOF'.length)}`;
    const beyond = `${'x'.repeat(100)}\nstartxref\n77\n%%EOF${' '.repeat(4097 - 'startxref\n77\n%%EOF'.length)}`;
    const padded = `startxref\n99\n%%EOF${' '.repeat(10_000)}`;
    expect([locateStartxref(source(atLimit, chunk)), locateStartxref(source(beyond, chunk)), locateStartxref(source(padded, chunk))]).toStrictEqual([
      { keyword: 101, offset: 77 },
      { keyword: 101, offset: 77 },
      { keyword: 0, offset: 99 },
    ]);
  });

  it('reads the last of two startxref keywords that lie more than 4,096 bytes from the end in different segments', () => {
    const text = `startxref\n11\n%%EOF\n${'x'.repeat(2000)}\nstartxref\n22\n%%EOF${' '.repeat(5000)}`;
    expect(locateStartxref(source(text, 1024))).toStrictEqual({ keyword: 2020, offset: 22 });
  });

  it('finds the %%EOF that follows the located startxref', () => {
    const text = 'startxref\n99\n%%EOF\n';
    expect(locatedEofEnd(source(text), 0)).toBe(18);
    expect(locatedEofEnd(source(`xx${text}`, 3), 2)).toBe(20);
    expect(locatedEofEnd(source('startxref\n99\n'), 0)).toBeUndefined();
    expect(locatedEofEnd(source(`startxref\n99\n${' '.repeat(300)}%%EOF`), 0)).toBeUndefined();
  });

  it('finds a %%EOF that ends 256 bytes after the keyword and not one that ends 257 bytes after it', () => {
    // The keyword sits at 2, so a window measured from the start of the file would end 2 bytes early.
    const head = 'xxstartxref\n99\n';
    const atLimit = `${head}${' '.repeat(2 + 256 - '%%EOF'.length - head.length)}%%EOF\n`;
    const beyond = `${head}${' '.repeat(2 + 257 - '%%EOF'.length - head.length)}%%EOF\n`;
    expect(locatedEofEnd(source(atLimit), 2)).toBe(258);
    expect(locatedEofEnd(source(atLimit, 7), 2)).toBe(258);
    expect(locatedEofEnd(source(beyond), 2)).toBeUndefined();
    expect(locatedEofEnd(source(beyond, 7), 2)).toBeUndefined();
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

  it('corrects by at most 64 bytes, preferring the lower offset at equal distance', () => {
    const lone = `\nxref\n0 1\n${'z'.repeat(200)}`;
    expect(sectionStartNear(source(lone), 65)).toStrictEqual({ offset: 1, corrected: true });
    expect(sectionStartNear(source(lone), 66)).toBeUndefined();
    const two = `\nxref\n${'z'.repeat(34)}\nxref\n0 0\n`;
    expect(sectionStartNear(source(two), 21)).toStrictEqual({ offset: 1, corrected: true });
    expect(sectionStartNear(source(two), 22)).toStrictEqual({ offset: 41, corrected: true });
  });

  it.each([
    ['a regular byte before xref', ' axref\n0 0\n', 2],
    ['a regular byte after xref', ' xrefs\n0 0\n', 1],
  ])('does not read a keyword with %s as a section', (_, text, offset) => {
    expect(sectionStartNear(source(text), offset)).toBeUndefined();
  });

  it('treats a stream dictionary nested deeper than 64 as no section rather than an error', () => {
    // The dictionary is level 1 and each array adds one, so 63 arrays reach level 64 and 64 arrays reach level 65.
    const deep = `7 0 obj\n<</Type/XRef/A${'['.repeat(64)}${']'.repeat(64)}>>`;
    const shallow = `7 0 obj\n<</Type/XRef/A${'['.repeat(63)}${']'.repeat(63)}>>`;
    expect([sectionStartNear(source(deep), 0), sectionStartNear(source(shallow), 0)]).toStrictEqual([undefined, { offset: 0, corrected: false }]);
  });

  it.each([0, 7, 1024])('recognises a large cross-reference stream dictionary with %i-byte chunks', chunk => {
    const index = Array.from({ length: 2400 }, (_, number) => `${String(3 * number)} 1`).join(' ');
    const text = `${' '.repeat(100)}7 0 obj\n<</Index[${index}]/Type/XRef>>`;
    const bytes = source(text, chunk);
    expect(sectionStartNear(bytes, 100)).toStrictEqual({ offset: 100, corrected: false });
    expect(sectionStartNear(bytes, 98)).toStrictEqual({ offset: 100, corrected: false });
    expect(sectionStartNear(bytes, 107)).toStrictEqual({ offset: 100, corrected: true });
    const truncated = source(text.slice(0, -1), chunk);
    const page = source(text.replace('/Type/XRef', '/Type/Page'), chunk);
    expect(sectionStartNear(truncated, 100)).toBeUndefined();
    expect(sectionStartNear(page, 100)).toBeUndefined();
  });
});

describe('properties', () => {
  const chunk = fc.constantFrom(0, 1, 3, 7, 64);

  it('finds a lone section from any offset within 64 bytes, and reports a correction unless only white space lies between', () => {
    // Padding of white space and one regular letter holds no keyword xref and no "n g obj" header; 80 bytes on each side keep every drawn offset inside the file.
    const padding = fc.array(fc.constantFrom(' ', '\n', '\r', 'z'), { minLength: 80, maxLength: 160 }).map(characters => characters.join(''));
    // A regular byte before the line ending ends the white space there; a long run of white space lets the skip reach past the window.
    const separator = fc.constantFrom('z', ' \r\n'.repeat(30));
    // Half the distances sit on either side of the 64-byte edge of the window.
    const distance = fc.oneof(fc.constantFrom(-65, -64, 64, 65), fc.integer({ min: -80, max: 80 }));
    fc.assert(
      fc.property(padding, separator, padding, chunk, distance, (before, between, after, size, delta) => {
        const prefix = `${before}${between}\n`;
        const start = prefix.length;
        const text = `${prefix}xref\n0 1\n${after}`;
        const offset = start + delta;
        const blank = offset <= start && /^[ \n\r]*$/u.test(text.slice(offset, start));
        const near = Math.abs(offset - start) <= 64;
        expect(sectionStartNear(source(text, size), offset)).toStrictEqual(blank || near ? { offset: start, corrected: !blank } : undefined);
      }),
    );
  });

  it('locates the same startxref whatever the segment sizes', () => {
    // Up to 6,000 bytes after %%EOF puts the keyword on either side of the 4,096-byte tail.
    fc.assert(
      fc.property(fc.nat(6000), fc.nat(6000), fc.constantFrom(5, 1024), (before, after, size) => {
        const text = `${'x'.repeat(before)}\nstartxref\n99\n%%EOF${' '.repeat(after)}`;
        expect(locateStartxref(source(text, size))).toStrictEqual({ keyword: before + 1, offset: 99 });
      }),
    );
  });

  it('locates the same header whatever the segment sizes', () => {
    fc.assert(
      fc.property(fc.nat(2100), chunk, fc.constantFrom('1.4', '1.7', '2.0'), (offset, size, version) => {
        expect(locateHeader(source(`${'x'.repeat(offset)}%PDF-${version}\n`, size))).toStrictEqual({ offset, version });
      }),
    );
  });
});
