import type { RawIccTagRecord } from '../testing/iccProfileBytes.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { iccProfileBytes, rawIccProfileBytes } from '../testing/iccProfileBytes.ts';

import { iccIdentity } from './iccIdentity.ts';
import { parseIccStructure } from './iccStructure.ts';

const ascii = (bytes: Uint8Array, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index++) {
    bytes[offset + index] = value.codePointAt(index) ?? 0;
  }
};

const profile = (): Uint8Array => {
  const bytes = new Uint8Array(172);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes[8] = 4;
  // Minor 3 and bugfix 1 in one byte, so neither half reads as zero by accident.
  bytes[9] = 0x31;
  ascii(bytes, 12, 'prtr');
  ascii(bytes, 16, 'CMYK');
  ascii(bytes, 20, 'Lab ');
  ascii(bytes, 36, 'acsp');
  view.setUint32(64, 2);
  view.setInt32(68, 0x00_00_f6_d6);
  view.setInt32(72, 0x00_01_00_00);
  view.setInt32(76, 0x00_00_d3_2d);
  view.setUint32(128, 2);
  ascii(bytes, 132, 'A2B0');
  view.setUint32(136, 156);
  view.setUint32(140, 16);
  ascii(bytes, 144, 'A2B1');
  view.setUint32(148, 156);
  view.setUint32(152, 16);
  ascii(bytes, 156, 'mft2');
  return bytes;
};

const raw = (tags: ReadonlyArray<RawIccTagRecord>, length: number): Uint8Array =>
  rawIccProfileBytes({ profileClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', length, tags });

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

// A 132-byte profile with no tags, with each edit written over it: a string as ASCII, bytes as they are.
const header = (...edits: ReadonlyArray<readonly [number, string | Uint8Array]>): Uint8Array => {
  const bytes = raw([], 132);
  for (const [offset, value] of edits) {
    if (typeof value === 'string') {
      ascii(bytes, offset, value);
    } else {
      bytes.set(value, offset);
    }
  }
  return bytes;
};

// Returns the reason and location of an InvalidProfileError, and lets any other error fail the test.
const failure = (bytes: Uint8Array): 'accepted' | { reason: string; offset: number; tag: string | undefined } => {
  try {
    parseIccStructure(bytes);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError) {
      return { reason: error.reason, offset: error.offset, tag: error.tag };
    }
    throw error;
  }
};

describe('icc structure', () => {
  it('reads a header and shared tag data through a sliced byte view', () => {
    const bytes = profile();
    const padded = new Uint8Array(bytes.length + 4);
    padded.set(bytes, 3);
    const parsed = parseIccStructure(padded.subarray(3, 3 + bytes.length));
    // ICC.1:2022, 7.2.1 Table 17 places the version at 8, the intent at 64 and the illuminant at 68.
    expect(parsed.header).toStrictEqual({
      size: 172,
      version: { major: 4, minor: 3, bugfix: 1 },
      profileClass: 'output',
      colorSpace: 'CMYK',
      pcs: 'Lab',
      renderingIntent: 'saturation',
      illuminant: { x: 0xf6_d6 / 65_536, y: 1, z: 0xd3_2d / 65_536 },
      profileId: new Uint8Array(16),
    });
    expect(parsed.tags).toStrictEqual([
      { signature: 'A2B0', offset: 156, size: 16 },
      { signature: 'A2B1', offset: 156, size: 16 },
    ]);
    // The parsed bytes and profile ID are copies: writing to the bytes the parser was given changes neither.
    padded[3 + 156] = 0;
    padded.fill(9, 3 + 84, 3 + 100);
    expect(parsed.bytes[156]).toBe('m'.codePointAt(0));
    expect(parsed.header.profileId).toStrictEqual(new Uint8Array(16));
  });

  it('rejects overlapping and out-of-bounds tags with typed reasons', () => {
    const short = raw([{ signature: 'A2B0', offset: 156, size: 17 }], 172);
    expect(() => parseIccStructure(short)).toThrow(InvalidProfileError);
    expect(failure(short)).toStrictEqual({ reason: 'tag-out-of-bounds', offset: 136, tag: 'A2B0' });
    const overlapping = raw(
      [
        { signature: 'A2B0', offset: 156, size: 16 },
        { signature: 'A2B1', offset: 160, size: 12 },
      ],
      172,
    );
    expect(() => parseIccStructure(overlapping)).toThrow(InvalidProfileError);
    // The error points at the offset field of the later record, the one that starts inside its neighbour.
    expect(failure(overlapping)).toStrictEqual({ reason: 'tag-overlap', offset: 148, tag: 'A2B1' });
  });

  it('bounds the tag table before comparing shared ranges', () => {
    const count = 8193;
    const offset = 132 + count * 12;
    const bytes = new Uint8Array(offset + 8);
    bytes.set(profile().subarray(0, 128));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    view.setUint32(128, count);
    for (let index = 0; index < count; index++) {
      const record = 132 + index * 12;
      view.setUint32(record, index);
      view.setUint32(record + 4, offset);
      view.setUint32(record + 8, 8);
    }
    expect(() => parseIccStructure(bytes)).toThrow(ResourceLimitError);
  });

  it('accepts a tag table of exactly 8192 shared tags', () => {
    const count = 8192;
    const offset = 132 + count * 12;
    const tags = Array.from({ length: count }, (_, index) => ({ signature: index.toString(16).padStart(4, '0'), offset, size: 8 }));
    expect(parseIccStructure(raw(tags, offset + 8)).tags).toHaveLength(count);
  });

  it('reads the declared size against the bytes supplied', () => {
    // ICC.1:2022, 7.2.2: the size field counts the whole profile, which is at least the 128-byte header and the tag count.
    expect(failure(header([0, u32(131)]))).toStrictEqual({ reason: 'size-mismatch', offset: 0, tag: undefined });
    expect(failure(header([0, u32(133)]))).toStrictEqual({ reason: 'size-mismatch', offset: 0, tag: undefined });
    expect(parseIccStructure(header()).header.size).toBe(132);
    expect(() => parseIccStructure(new Uint8Array(131))).toThrow(InvalidProfileError);
    expect(() => parseIccStructure(new Uint8Array(131))).toThrow(expect.objectContaining({ reason: 'truncated', offset: 131 }));
  });

  it.each([
    { major: 1, expected: 'unsupported-version' },
    { major: 3, expected: 'unsupported-version' },
    { major: 6, expected: 'unsupported-version' },
  ])('rejects major version $major', ({ major, expected }) => {
    expect(failure(header([8, Uint8Array.of(major)]))).toStrictEqual({ reason: expected, offset: 8, tag: undefined });
  });

  it('accepts major versions 2 and 4 and reports version 5 as unsupported', () => {
    // ICC.1:2022, 7.2.4: the major version is byte 8 and byte 9 holds the minor and bugfix digits as two nibbles.
    expect(parseIccStructure(header([8, Uint8Array.of(2, 0x10)])).header.version).toStrictEqual({ major: 2, minor: 1, bugfix: 0 });
    expect(parseIccStructure(header([8, Uint8Array.of(4, 0x31)])).header.version).toStrictEqual({ major: 4, minor: 3, bugfix: 1 });
    expect(() => parseIccStructure(header([8, Uint8Array.of(5)]))).toThrow(UnsupportedFeatureError);
  });

  // ICC.1:2022, 7.2.5 Table 18 lists the seven profile class signatures.
  it.each([
    ['scnr', 'input'],
    ['mntr', 'display'],
    ['prtr', 'output'],
    ['link', 'deviceLink'],
    ['spac', 'colorSpace'],
    ['abst', 'abstract'],
    ['nmcl', 'namedColor'],
  ])('reads profile class %s as %s', (signature, expected) => {
    expect(parseIccStructure(header([12, signature])).header.profileClass).toBe(expected);
  });

  it('rejects an unknown profile class', () => {
    expect(failure(header([12, 'mntx']))).toStrictEqual({ reason: 'unknown-class', offset: 12, tag: undefined });
  });

  // ICC.1:2022, 7.2.6 Table 19 lists the data colour space signatures, with nCLR for 2 to 15 colourants.
  it.each([
    ['XYZ ', 'XYZ'],
    ['Lab ', 'Lab'],
    ['Luv ', 'Luv'],
    ['YCbr', 'YCbCr'],
    ['Yxy ', 'Yxy'],
    ['RGB ', 'RGB'],
    ['GRAY', 'Gray'],
    ['HSV ', 'HSV'],
    ['HLS ', 'HLS'],
    ['CMYK', 'CMYK'],
    ['CMY ', 'CMY'],
    ['2CLR', { colorants: 2 }],
    ['9CLR', { colorants: 9 }],
    ['ACLR', { colorants: 10 }],
    ['FCLR', { colorants: 15 }],
  ])('reads data colour space %s', (signature, expected) => {
    expect(parseIccStructure(header([16, signature])).header.colorSpace).toStrictEqual(expected);
  });

  it.each(['1CLR', 'GCLR', 'RGBA'])('rejects data colour space %s', signature => {
    expect(failure(header([16, signature]))).toStrictEqual({ reason: 'unknown-color-space', offset: 16, tag: undefined });
  });

  it('requires an XYZ or Lab PCS except in a device link', () => {
    // ICC.1:2022, 7.2.7: the PCS field of a device link holds the output colour space instead.
    expect(failure(header([20, 'RGB ']))).toStrictEqual({ reason: 'unknown-color-space', offset: 20, tag: undefined });
    expect(failure(header([12, 'abstRGB RGB ']))).toStrictEqual({ reason: 'unknown-color-space', offset: 20, tag: undefined });
    expect(parseIccStructure(header([12, 'linkRGB CMYK'])).header.pcs).toBe('CMYK');
    expect(parseIccStructure(header([20, 'Lab '])).header.pcs).toBe('Lab');
  });

  // ICC.1:2022, 7.2.15 Table 23 numbers the rendering intents 0 to 3.
  it.each([
    [0, 'perceptual'],
    [1, 'relativeColorimetric'],
    [2, 'saturation'],
    [3, 'absoluteColorimetric'],
  ])('reads rendering intent %i as %s', (value, expected) => {
    expect(parseIccStructure(header([64, u32(value)])).header.renderingIntent).toBe(expected);
  });

  it('rejects rendering intent 4', () => {
    expect(failure(header([64, u32(4)]))).toStrictEqual({ reason: 'bad-tag-data', offset: 64, tag: undefined });
  });

  it('reads a negative s15Fixed16 illuminant component', () => {
    // ICC.1:2022, 4.6: s15Fixed16Number is signed, so FFFF0000h is -1.
    const parsed = parseIccStructure(header([68, u32(0xff_ff_00_00)]));
    expect(parsed.header.illuminant).toStrictEqual({ x: -1, y: 1, z: Math.round(0.8249 * 65_536) / 65_536 });
  });

  it.each([
    { count: 1, expected: 'accepted' },
    { count: 2, expected: { reason: 'tag-table-out-of-bounds', offset: 128, tag: undefined } },
  ])('fits $count tag records into a profile with room for one', ({ count, expected }) => {
    const bytes = raw([{ signature: 'zzzz', offset: 144, size: 8 }], 152);
    new DataView(bytes.buffer).setUint32(128, count);
    expect(failure(bytes)).toStrictEqual(expected);
  });

  // ICC.1:2022, 7.3.1 Table 24: a tag starts after the tag table, holds at least its 8-byte type header and ends inside the declared size.
  it.each([
    { name: 'starts one byte inside the tag table', offset: 143, size: 8, expected: { reason: 'tag-out-of-bounds', offset: 136, tag: 'zzzz' } },
    { name: 'starts right after the tag table', offset: 144, size: 8, expected: 'accepted' },
    { name: 'is 7 bytes long', offset: 144, size: 7, expected: { reason: 'tag-out-of-bounds', offset: 136, tag: 'zzzz' } },
    { name: 'ends at the declared size', offset: 144, size: 16, expected: 'accepted' },
    { name: 'ends one byte past the declared size', offset: 144, size: 17, expected: { reason: 'tag-out-of-bounds', offset: 136, tag: 'zzzz' } },
    { name: 'starts past the declared size', offset: 164, size: 8, expected: { reason: 'tag-out-of-bounds', offset: 136, tag: 'zzzz' } },
  ])('a tag that $name', ({ offset, size, expected }) => {
    expect(failure(raw([{ signature: 'zzzz', offset, size }], 160))).toStrictEqual(expected);
  });

  it('bounds tags by the declared size rather than the bytes supplied', () => {
    const bytes = new Uint8Array(168);
    bytes.set(raw([{ signature: 'zzzz', offset: 152, size: 16 }], 160));
    expect(failure(bytes)).toStrictEqual({ reason: 'tag-out-of-bounds', offset: 136, tag: 'zzzz' });
    bytes.set(raw([{ signature: 'zzzz', offset: 152, size: 8 }], 160));
    expect(parseIccStructure(bytes).warnings).toStrictEqual([{ code: 'trailing-data', offset: 160 }]);
  });

  it('reports a duplicate signature at its second record', () => {
    const bytes = raw(
      [
        { signature: 'rTRC', offset: 168, size: 8 },
        { signature: 'gTRC', offset: 176, size: 8 },
        { signature: 'rTRC', offset: 184, size: 8 },
      ],
      192,
    );
    // The third record is the second rTRC, and the error points at its start.
    expect(failure(bytes)).toStrictEqual({ reason: 'duplicate-tag', offset: 156, tag: 'rTRC' });
  });

  it('accepts a zero or a matching profile ID and warns about a different one', () => {
    // ICC.1:2022, 7.2.18: a profile ID of zero means the ID was not calculated.
    const bytes = raw([{ signature: 'zzzz', offset: 144, size: 8 }], 152);
    expect(parseIccStructure(bytes).warnings).toStrictEqual([]);
    const identity = iccIdentity(bytes);
    bytes.set(identity, 84);
    expect(parseIccStructure(bytes).warnings).toStrictEqual([]);
    bytes[99] = (identity[15] ?? 0) ^ 1;
    expect(parseIccStructure(bytes).warnings).toStrictEqual([{ code: 'profile-id-mismatch', offset: 84 }]);
  });

  describe('properties', () => {
    const signatures = fc
      .uniqueArray(fc.stringMatching(/^[a-z]{4}$/u), { minLength: 0, maxLength: 6 })
      .map(names => names.filter(name => !['desc', 'cprt', 'wtpt'].includes(name)));

    it('reads back each tag a builder wrote, and accepts the identity as profile ID', () => {
      fc.assert(
        fc.property(
          signatures.chain(names =>
            fc.tuple(fc.constant(names), fc.array(fc.uint8Array({ minLength: 8, maxLength: 40 }), { minLength: names.length, maxLength: names.length })),
          ),
          ([names, data]) => {
            const tags = names.map((name, index): readonly [string, Uint8Array] => [name, data[index] ?? new Uint8Array(8)]);
            const bytes = iccProfileBytes({ profileClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', tags });
            const parsed = parseIccStructure(bytes);
            expect(parsed.tags.slice(3).map(tag => [tag.signature, parsed.bytes.slice(tag.offset, tag.offset + tag.size)])).toStrictEqual(tags);
            bytes.set(parsed.identity, 84);
            expect(parseIccStructure(bytes).warnings).toStrictEqual([]);
          },
        ),
      );
    });

    it('accepts a tag table exactly when every two tags are disjoint or identical', () => {
      // ICC.1:2022, 7.3.1: tags may share one data element but must not partially overlap.
      const record = fc.record({ step: fc.integer({ min: 0, max: 8 }), size: fc.constantFrom(8, 12, 16, 20) });
      fc.assert(
        fc.property(fc.array(record, { minLength: 1, maxLength: 5 }), records => {
          const tableEnd = 132 + records.length * 12;
          const tags = records.map(({ step, size }, index) => ({ signature: `t${String(index).padStart(3, '0')}`, offset: tableEnd + step * 4, size }));
          const separate = tags.every((first, index) =>
            tags
              .slice(index + 1)
              .every(
                second =>
                  (first.offset === second.offset && first.size === second.size) ||
                  first.offset + first.size <= second.offset ||
                  second.offset + second.size <= first.offset,
              ),
          );
          const outcome = failure(raw(tags, tableEnd + 8 * 4 + 20));
          expect(outcome === 'accepted' ? 'accepted' : outcome.reason).toBe(separate ? 'accepted' : 'tag-overlap');
        }),
      );
    });
  });
});
