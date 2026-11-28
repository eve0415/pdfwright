import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import fograV4Bytes from '../../../../tests/fixtures/icc/fogra28l-v4.icc?icc-bytes';
import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import srgbV4Bytes from '../../../../tests/fixtures/icc/sRGB-v4.icc?icc-bytes';
import srgbArgyllBytes from '../../../../tests/fixtures/icc/sRGB.icm?icc-bytes';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { gammaCurveTag, iccProfileBytes, matrixLutTag, rawIccProfileBytes, sampledCurveTag, xyzTag } from '../testing/iccProfileBytes.ts';

import { parseIccProfile } from './iccProfile.ts';
import { parseIccStructure } from './iccStructure.ts';

const sharedLutProfile = (): Uint8Array => {
  const offset = 204;
  const length = 48 + 3 * 256 + 2 ** 3 * 3 + 3 * 256;
  const bytes = new Uint8Array(offset + length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes[8] = 2;
  bytes.set(new TextEncoder().encode('mntrRGB Lab '), 12);
  bytes.set(new TextEncoder().encode('acsp'), 36);
  view.setUint32(128, 6);
  for (let index = 0; index < 6; index++) {
    bytes.set(new TextEncoder().encode(index < 3 ? `A2B${String(index)}` : `B2A${String(index - 3)}`), 132 + index * 12);
    view.setUint32(136 + index * 12, offset);
    view.setUint32(140 + index * 12, length);
  }
  bytes.set(new TextEncoder().encode('mft1'), offset);
  bytes[offset + 8] = 3;
  bytes[offset + 9] = 3;
  bytes[offset + 10] = 2;
  return bytes;
};

describe('icc profile basic tags', () => {
  it('shares one decoded LUT across six intent tags', () => {
    const profile = parseIccProfile(sharedLutProfile());
    for (const intent of [0, 1, 2] as const) {
      expect(profile.deviceToPcs[intent]).toBe(profile.deviceToPcs[0]);
      expect(profile.pcsToDevice[intent]).toBe(profile.deviceToPcs[0]);
    }
    expect(profile.deviceToPcs[0]?.clut?.values).toBeInstanceOf(Uint8Array);
  });

  it('limits profile bytes before parsing and accepts an explicit larger limit', () => {
    const bytes = sharedLutProfile();
    expect(() => parseIccProfile(bytes, { maxIccProfileBytes: bytes.length - 1 })).toThrow(ResourceLimitError);
    expect(parseIccProfile(bytes, { maxIccProfileBytes: bytes.length }).header.size).toBe(bytes.length);
    expect(() => parseIccProfile(new Uint8Array(24 * 1024 * 1024 + 1))).toThrow(ResourceLimitError);
  });

  it('exposes gray TRC and media white point from a complete profile', () => {
    const bytes = new Uint8Array(192);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 4;
    bytes.set(new TextEncoder().encode('mntrGRAYXYZ '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 2);
    bytes.set(new TextEncoder().encode('kTRC'), 132);
    view.setUint32(136, 156);
    view.setUint32(140, 16);
    bytes.set(new TextEncoder().encode('wtpt'), 144);
    view.setUint32(148, 172);
    view.setUint32(152, 20);
    bytes.set(new TextEncoder().encode('curv'), 156);
    view.setUint32(164, 1);
    view.setUint16(168, 0x02_00);
    bytes.set(new TextEncoder().encode('XYZ '), 172);
    view.setInt32(180, 0x00_00_f6_d6);
    view.setInt32(184, 0x00_01_00_00);
    view.setInt32(188, 0x00_00_d3_2d);
    const profile = parseIccProfile(bytes);
    expect(profile.trc).toStrictEqual({ gray: { kind: 'gamma', gamma: 2 } });
    expect(profile.mediaWhitePoint).toStrictEqual({ x: 0xf6_d6 / 65_536, y: 1, z: 0xd3_2d / 65_536 });
    expect(profile.identity).toHaveLength(16);
  });

  it('attaches a lut16 A2B tag with header-matching channel counts', () => {
    const bytes = new Uint8Array(224);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 2;
    bytes.set(new TextEncoder().encode('mntrGRAYLab '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 1);
    bytes.set(new TextEncoder().encode('A2B0'), 132);
    view.setUint32(136, 144);
    view.setUint32(140, 80);
    bytes.set(new TextEncoder().encode('mft2'), 144);
    bytes[152] = 1;
    bytes[153] = 3;
    bytes[154] = 2;
    view.setUint16(192, 2);
    view.setUint16(194, 2);
    expect(parseIccProfile(bytes).deviceToPcs[0]?.clut?.outputChannels).toBe(3);
    bytes.set(new TextEncoder().encode('RGB '), 16);
    expect(() => parseIccProfile(bytes)).toThrow('channel count disagrees');
  });

  it('attaches an mAB pipeline to a v4 profile', () => {
    const bytes = new Uint8Array(212);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[8] = 4;
    bytes.set(new TextEncoder().encode('mntrRGB Lab '), 12);
    bytes.set(new TextEncoder().encode('acsp'), 36);
    view.setUint32(128, 1);
    bytes.set(new TextEncoder().encode('A2B0'), 132);
    view.setUint32(136, 144);
    view.setUint32(140, 68);
    bytes.set(new TextEncoder().encode('mAB '), 144);
    bytes[152] = 3;
    bytes[153] = 3;
    view.setUint32(156, 32);
    for (let index = 0; index < 3; index++) {
      bytes.set(new TextEncoder().encode('curv'), 176 + index * 12);
    }
    expect(parseIccProfile(bytes).deviceToPcs[0]?.kind).toBe('lutAtoB');
  });
});

// A lut8Type with zero tables and a two-point CLUT, under ICC.1:2022, 10.11; the first input value marks which tag it came from.
const lut8Tag = (inputs: number, outputs: number, mark = 0): Uint8Array => {
  const bytes = new Uint8Array(48 + inputs * 256 + outputs * 2 ** inputs + outputs * 256);
  bytes.set(new TextEncoder().encode('mft1'));
  bytes.set([inputs, outputs, 2], 8);
  bytes[48] = mark;
  return bytes;
};

const profileWith = (colorSpace: string, pcs: 'XYZ ' | 'Lab ', tags: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array =>
  iccProfileBytes({ profileClass: 'prtr', colorSpace, pcs, tags });

// Returns the reason, offset and tag of an InvalidProfileError, and lets any other outcome fail the test.
const failure = (bytes: Uint8Array): 'accepted' | { readonly reason: string; readonly offset: number; readonly tag: string | undefined } => {
  try {
    parseIccProfile(bytes);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError) {
      return { reason: error.reason, offset: error.offset, tag: error.tag };
    }
    throw error;
  }
};

const tagOffset = (bytes: Uint8Array, signature: string): number | undefined => parseIccStructure(bytes).tags.find(tag => tag.signature === signature)?.offset;

// The header with the tag table, and the first 52 bytes of each tag: the counts, channels, offsets and lengths that the readers check, rather than sample values.
const regions = (bytes: Uint8Array): Array<readonly [number, number]> => {
  const structure = parseIccStructure(bytes);
  const heads = new Map(structure.tags.map(tag => [tag.offset, Math.min(tag.offset + 52, tag.offset + tag.size)]));
  return [[0, 132 + structure.tags.length * 12], ...heads];
};

const outcome = (bytes: Uint8Array): string => {
  try {
    parseIccProfile(bytes);
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidProfileError || error instanceof UnsupportedFeatureError || error instanceof ResourceLimitError) {
      return 'refused';
    }
    throw error;
  }
};

describe('icc profile options', () => {
  // 132.5 and 2^53 are finite and at least 132, so only the safe-integer check rejects them.
  it.each([131, 1.5, 132.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects maxIccProfileBytes %d', maxIccProfileBytes => {
    expect(() => parseIccProfile(sharedLutProfile(), { maxIccProfileBytes })).toThrow(InvalidArgumentError);
  });

  it('accepts maxIccProfileBytes 132 for a 132-byte profile', () => {
    const bytes = rawIccProfileBytes({ profileClass: 'mntr', colorSpace: 'RGB ', pcs: 'XYZ ', length: 132, tags: [] });
    expect(parseIccProfile(bytes, { maxIccProfileBytes: 132 }).header.size).toBe(132);
  });

  it('parses a profile of exactly the default 24 MiB limit', () => {
    // The limit admits 24 MiB itself, so a zero-filled buffer of that length reaches the header check rather than the limit.
    expect(() => parseIccProfile(new Uint8Array(24 * 1024 * 1024))).toThrow(expect.objectContaining({ reason: 'size-mismatch', offset: 0 }));
  });
});

describe('icc profile tags', () => {
  // ICC.1:2022, 8.10.2 Table 26: DToB0–3 and BToD0–3 take precedence over the AToB and BToA tags.
  it.each(['D2B0', 'D2B3', 'B2D0', 'B2D3'])('refuses the multi-process element tag %s', signature => {
    const bytes = profileWith('RGB ', 'XYZ ', [[signature, new TextEncoder().encode('mpet\0\0\0\0')]]);
    expect(() => parseIccProfile(bytes)).toThrow(UnsupportedFeatureError);
    expect(() => parseIccProfile(bytes)).toThrow(expect.objectContaining({ reason: 'icc-mpet' }));
  });

  it.each(['D2B4', 'D2Bx', 'B2D4'])('ignores the tag %s, which names no rendering intent', signature => {
    const bytes = profileWith('RGB ', 'XYZ ', [[signature, new TextEncoder().encode('mpet\0\0\0\0')]]);
    expect(parseIccProfile(bytes).deviceToPcs).toStrictEqual({});
  });

  it.each([
    { signature: 'A2B0', type: 'mBA ' },
    { signature: 'B2A0', type: 'mAB ' },
  ] as const)('rejects an $type element under $signature', ({ signature, type }) => {
    const bytes = profileWith('RGB ', 'XYZ ', [
      [
        signature,
        matrixLutTag(
          type,
          Array.from({ length: 12 }, (_, index) => index / 8),
        ),
      ],
    ]);
    expect(failure(bytes)).toStrictEqual({ reason: 'tag-type-mismatch', offset: tagOffset(bytes, signature), tag: signature });
  });

  // ICC.1:2022, 10.10 and 10.11: an AToB LUT maps the data colour space to the PCS, and a BToA LUT the PCS to the data colour space.
  it.each([
    { name: 'an A2B0 from CMYK to Lab', tags: [['A2B0', lut8Tag(4, 3)]], expected: 'accepted' },
    { name: 'an A2B0 whose output disagrees with the PCS', tags: [['A2B0', lut8Tag(4, 4)]], expected: 'A2B0' },
    { name: 'an A2B0 whose input disagrees with the data colour space', tags: [['A2B0', lut8Tag(3, 3)]], expected: 'A2B0' },
    { name: 'a B2A0 from Lab to CMYK', tags: [['B2A0', lut8Tag(3, 4)]], expected: 'accepted' },
    { name: 'a B2A0 from CMYK to Lab', tags: [['B2A0', lut8Tag(4, 3)]], expected: 'B2A0' },
  ] as const)('checks channel counts for $name', ({ tags, expected }) => {
    const bytes = profileWith('CMYK', 'Lab ', tags);
    const [signature] = tags[0];
    expect(failure(bytes)).toStrictEqual(
      expected === 'accepted' ? 'accepted' : { reason: 'channel-mismatch', offset: tagOffset(bytes, signature), tag: signature },
    );
  });

  it('rejects one element shared by an A2B0 and a B2A0 of a CMYK profile', () => {
    // ICC.1:2022, 7.3.1 lets tags share an element, but a 4→3 LUT cannot also be the 3→4 one.
    const lut = lut8Tag(4, 3);
    const bytes = rawIccProfileBytes({
      profileClass: 'prtr',
      colorSpace: 'CMYK',
      pcs: 'Lab ',
      length: 156 + lut.length,
      tags: [
        { signature: 'A2B0', offset: 156, size: lut.length },
        { signature: 'B2A0', offset: 156, size: lut.length },
      ],
      data: [[156, lut]],
    });
    expect(failure(bytes)).toStrictEqual({ reason: 'channel-mismatch', offset: 156, tag: 'B2A0' });
  });

  it('reads each intent from its own tag', () => {
    const bytes = profileWith('CMYK', 'Lab ', [
      ['A2B0', lut8Tag(4, 3, 10)],
      ['A2B1', lut8Tag(4, 3, 11)],
    ]);
    const profile = parseIccProfile(bytes);
    const mark = (intent: 0 | 1 | 2): number | undefined => {
      const lut = profile.deviceToPcs[intent];
      const curve = lut?.kind === 'lut8' ? lut.input[0] : undefined;
      return curve?.kind === 'table' ? curve.values[0] : undefined;
    };
    expect([mark(0), mark(1), profile.deviceToPcs[2], profile.pcsToDevice]).toStrictEqual([10, 11, undefined, {}]);
  });

  it('reads colorants, curves, adaptation, black point and texts from their tags', () => {
    const chad = new Uint8Array(44);
    chad.set(new TextEncoder().encode('sf32'));
    for (let index = 0; index < 9; index++) {
      new DataView(chad.buffer).setInt32(8 + index * 4, (index - 4) * 0x40_00);
    }
    const bytes = iccProfileBytes({
      profileClass: 'mntr',
      colorSpace: 'RGB ',
      pcs: 'XYZ ',
      tags: [
        ['rXYZ', xyzTag([0.5, 0.25, 0.125])],
        ['gXYZ', xyzTag([0.375, 0.75, 0.0625])],
        ['bXYZ', xyzTag([-0.125, 0.0625, 0.625])],
        ['rTRC', gammaCurveTag(2.5)],
        ['gTRC', sampledCurveTag([0, 100, 65_535])],
        ['bTRC', gammaCurveTag(1.5)],
        ['kTRC', gammaCurveTag(3)],
        ['bkpt', xyzTag([0.0078125, 0.00390625, 0.001953125])],
        ['chad', chad],
      ],
    });
    const profile = parseIccProfile(bytes);
    expect({
      description: profile.description,
      copyright: profile.copyright,
      colorants: profile.colorants,
      trc: profile.trc,
      mediaBlackPoint: profile.mediaBlackPoint,
      chromaticAdaptation: profile.chromaticAdaptation,
    }).toStrictEqual({
      description: 'Test profile',
      copyright: 'No copyright, use freely',
      colorants: { red: { x: 0.5, y: 0.25, z: 0.125 }, green: { x: 0.375, y: 0.75, z: 0.0625 }, blue: { x: -0.125, y: 0.0625, z: 0.625 } },
      trc: {
        red: { kind: 'parametric', functionType: 0, params: [2.5] },
        green: { kind: 'table', values: Uint16Array.of(0, 100, 65_535) },
        blue: { kind: 'parametric', functionType: 0, params: [1.5] },
      },
      mediaBlackPoint: { x: 0.0078125, y: 0.00390625, z: 0.001953125 },
      chromaticAdaptation: [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1],
    });
  });

  it('falls back to the gray curve and leaves colorants unset when a channel is missing', () => {
    const bytes = iccProfileBytes({
      profileClass: 'mntr',
      colorSpace: 'RGB ',
      pcs: 'XYZ ',
      tags: [
        ['rXYZ', xyzTag([0.5, 0.25, 0.125])],
        ['gXYZ', xyzTag([0.375, 0.75, 0.0625])],
        ['rTRC', gammaCurveTag(2.5)],
        ['gTRC', gammaCurveTag(2)],
        ['kTRC', gammaCurveTag(3)],
      ],
    });
    const profile = parseIccProfile(bytes);
    expect([profile.colorants, profile.trc]).toStrictEqual([undefined, { gray: { kind: 'parametric', functionType: 0, params: [3] } }]);
  });

  it('rejects an XYZ element under rTRC', () => {
    const bytes = profileWith('RGB ', 'XYZ ', [['rTRC', xyzTag([0.5, 0.25, 0.125])]]);
    expect(failure(bytes)).toStrictEqual({ reason: 'tag-type-mismatch', offset: tagOffset(bytes, 'rTRC'), tag: undefined });
  });

  describe('properties', () => {
    const fixtures = [srgbV4Bytes, srgbArgyllBytes, fograBytes, fograV4Bytes];

    it('returns or refuses a committed profile with any one byte of a header or tag head changed', () => {
      fc.assert(
        fc.property(fc.constantFrom(...fixtures), fc.nat(), fc.integer({ min: 0, max: 255 }), (fixture, pick, value) => {
          const choices = regions(fixture);
          const [start, end] = choices[pick % choices.length] ?? [0, 0];
          const changed = Uint8Array.from(fixture);
          for (let position = start; position < end; position++) {
            const original = changed[position] ?? 0;
            changed[position] = value;
            expect(['accepted', 'refused']).toContain(outcome(changed));
            changed[position] = original;
          }
        }),
      );
    });

    it('returns or refuses a committed profile cut short with its size field rewritten', () => {
      fc.assert(
        fc.property(fc.constantFrom(...fixtures), fc.nat(), (fixture, cut) => {
          const length = 132 + (cut % (fixture.length - 132));
          const truncated = Uint8Array.from(fixture.subarray(0, length));
          new DataView(truncated.buffer).setUint32(0, length);
          expect(['accepted', 'refused']).toContain(outcome(truncated));
        }),
      );
    });
  });
});
