import type { IccProfile } from '../icc/iccProfile.ts';
import type { Xyz } from '../icc/iccStructure.ts';
import type { ColorSource, ColorTransform, ColorTransformOptions } from './createColorTransform.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import fograBytes from '../../../../tests/fixtures/icc/fogra28l.icc?icc-bytes';
import { samples } from '../../../../tests/fixtures/icc/samples.ts';
import srgbV4Bytes from '../../../../tests/fixtures/icc/sRGB-v4.icc?icc-bytes';
import syntheticBytes from '../../../../tests/fixtures/icc/synthetic-cmyk.icc?icc-bytes';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { md5 } from '../hash/md5.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';

import { createColorTransform } from './createColorTransform.ts';
import { destinationEvaluator, sourceEvaluator } from './profilePipeline.ts';
import { IDENTITY_CURVE, iccProfile, lut8, PCS_D50 } from './testing/iccProfiles.ts';
import { largestDifference } from './testing/largestDifference.ts';

const D50 = PCS_D50;
const identity = IDENTITY_CURVE;

const relative = { intent: 'relativeColorimetric', blackPointCompensation: false } as const;

const converted = (source: ColorSource, destinationProfile: IccProfile, options: ColorTransformOptions, input: ReadonlyArray<number>): Array<number> => {
  const transform = createColorTransform(source, destinationProfile, options);
  const output = new Float64Array(transform.outputChannels);
  transform.convert(Float64Array.from(input), output);
  return [...output];
};

// CIE 15:2004, 8.2.1: L*a*b* to XYZ relative to the D50 PCS white.
const cieInverse = (value: number): number => (value > 6 / 29 ? value ** 3 : 3 * (6 / 29) ** 2 * (value - 4 / 29));
const cieXyz = ([lightness = 0, a = 0, b = 0]: ReadonlyArray<number>): Array<number> => {
  const fy = (lightness + 16) / 116;
  return [D50.x * cieInverse(fy + a / 500), cieInverse(fy), D50.z * cieInverse(fy - b / 200)];
};

// A calibrated source with three distinct colorants, so colours that differ in any component convert differently.
const calRgb: ColorSource = { kind: 'calRGB', whitePoint: D50, gamma: [1.8, 2.2, 2.6], matrix: [0.4, 0.1, 0.2, 0.3, 0.5, 0.3, 0.2642, 0.4, 0.3249] };

// A singular source whose only non-zero colorant is red, at D50, so every colour it gives is neutral.
const source = (): IccProfile => iccProfile({ colorants: { red: D50, green: { x: 0, y: 0, z: 0 }, blue: { x: 0, y: 0, z: 0 } } });

const grayProfile = (pcs: 'XYZ' | 'Lab'): IccProfile => iccProfile({ header: { colorSpace: 'Gray', pcs }, colorants: undefined, trc: { gray: identity } });

// A lut8 Lab CMYK destination whose CLUT writes a to channel 0, b to channel 1, L to channel 2 and 0 to channel 3; the CLUT is affine in every channel.
const destination = (): IccProfile =>
  iccProfile({
    header: { profileClass: 'output', colorSpace: 'CMYK', pcs: 'Lab' },
    colorants: undefined,
    trc: undefined,
    pcsToDevice: { 1: lut8(3, 4, ([l = 0, a = 0, b = 0]) => [a * 255, b * 255, l * 255, 0]) },
  });

const rgbToLab = (): ColorTransform => createColorTransform({ kind: 'icc', profile: source() }, destination(), relative);

// A version 2 output profile, so no intent forces black-point compensation, with the Lab destination table under tag 0, which every intent can read.
const anyIntentDestination = (): IccProfile => ({
  ...destination(),
  header: { ...destination().header, version: { major: 2, minor: 1, bugfix: 0 } },
  pcsToDevice: { 0: lut8(3, 4, ([l = 0, a = 0, b = 0]) => [a * 255, b * 255, l * 255, 0]) },
});

// ICC.1:2022, 6.3.2.2: ICC-absolute colorimetry scales each XYZ axis by the source media white over the destination media white.
const scaled = ([x = 0, y = 0, z = 0]: ReadonlyArray<number>, from: Xyz, to: Xyz): Array<number> => [
  (x * from.x) / to.x,
  (y * from.y) / to.y,
  (z * from.z) / to.z,
];

// A Lab CMYK destination whose four channels are a, b, L* and a mix of L* and a, so the channels of a non-neutral colour differ.
const rowDestination = (): IccProfile => ({
  ...destination(),
  pcsToDevice: { 1: lut8(3, 4, ([l = 0, a = 0, b = 0]) => [a * 255, b * 255, l * 255, l * 170 + a * 85]) },
});

const scalarRow8 = (transform: ColorTransform, pixels: ReadonlyArray<ReadonlyArray<number>>): Array<number> =>
  pixels.flatMap(pixel => {
    const output = new Float64Array(transform.outputChannels);
    transform.convert(
      Float64Array.from(pixel, value => value / 255),
      output,
    );
    return [...output].map(value => Math.round(value * 255));
  });

const row8 = (transform: ColorTransform, pixels: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const output = new Uint8Array(pixels.length * transform.outputChannels);
  transform.convertRow8(Uint8Array.from(pixels.flat()), output, pixels.length);
  return [...output];
};

const createSingular = (): void => {
  createColorTransform({ kind: 'icc', profile: source() }, source(), relative);
};

const createWithoutTable = (): void => {
  createColorTransform({ kind: 'icc', profile: source() }, { ...destination(), pcsToDevice: {} }, relative);
};

describe('icc colour transforms', () => {
  it('maps gray XYZ through D50 regardless of the media white point', () => {
    const gray: IccProfile = {
      ...source(),
      header: { ...source().header, colorSpace: 'Gray' },
      colorants: undefined,
      trc: { gray: identity },
      mediaWhitePoint: { x: 0.8, y: 0.9, z: 0.7 },
    };
    const value = sourceEvaluator(gray, 'relativeColorimetric', 'icc')(Float64Array.of(0.5));
    expect(value.space).toBe('XYZ');
    expect(value.values).toStrictEqual([D50.x * 0.5, D50.y * 0.5, D50.z * 0.5]);
  });

  it('inverts gray Lab curves with L star rather than luminance', () => {
    const gray: IccProfile = {
      ...source(),
      header: { ...source().header, colorSpace: 'Gray', pcs: 'Lab' },
      colorants: undefined,
      trc: { gray: identity },
    };
    expect(destinationEvaluator(gray, 'relativeColorimetric', 'icc')({ space: 'Lab', values: [50, 0, 0] })).toStrictEqual([0.5]);
  });

  it('converts the connection to the gray destination PCS before inverting its curve', () => {
    // CIE 1976 L* = 50 is relative luminance Y = (66 / 116)^3.
    const luminance = (66 / 116) ** 3;
    const fromXyz = destinationEvaluator(
      grayProfile('Lab'),
      'relativeColorimetric',
      'icc',
    )({ space: 'XYZ', values: [D50.x * luminance, luminance, D50.z * luminance] });
    const fromLab = destinationEvaluator(grayProfile('XYZ'), 'relativeColorimetric', 'icc')({ space: 'Lab', values: [50, 0, 0] });
    expect(fromXyz[0]).toBeCloseTo(0.5, 9);
    expect(fromLab[0]).toBeCloseTo(luminance, 9);
  });

  // ICC.1:2022, 6.3.4.2, Table 13 scales lut8 a and b by 255, so neutral is 128/255; the adobe option scales by 256, so neutral is 0.5. The destination writes a, b and L* to channels 0, 1 and 2.
  it.each([
    { encoding: 'default' as const, neutral: 128 / 255 },
    { encoding: 'icc' as const, neutral: 128 / 255 },
    { encoding: 'adobe' as const, neutral: 0.5 },
  ])('encodes lut8 Lab a and b around $neutral with the $encoding encoding', ({ encoding, neutral }) => {
    const options = encoding === 'default' ? relative : { ...relative, lut8LabEncoding: encoding };
    // The source gives XYZ = 0.184 · D50, a neutral with the CIE 1976 lightness of luminance 0.184.
    const lightness = 116 * Math.cbrt(0.184) - 16;
    expect(
      largestDifference(converted({ kind: 'icc', profile: source() }, destination(), options, [0.184, 0, 0]), [neutral, neutral, lightness / 100, 0]),
    ).toBeLessThan(1e-9);
  });

  it.each([
    { encoding: 'icc' as const, lab: [12_800 / 255, 0, 0] },
    { encoding: 'adobe' as const, lab: [12_800 / 255, 128 / 255, 128 / 255] },
  ])('decodes lut8 Lab samples of 128 as $lab with the $encoding encoding', ({ encoding, lab }) => {
    const labSource = iccProfile({ header: { pcs: 'Lab' }, deviceToPcs: { 1: lut8(3, 3, () => [128, 128, 128]) } });
    // The destination's unit colorants and identity TRCs make its device values the PCS XYZ values.
    const output = converted({ kind: 'icc', profile: labSource }, iccProfile(), { ...relative, lut8LabEncoding: encoding }, [0.3, 0.6, 0.9]);
    expect(largestDifference(output, cieXyz(lab))).toBeLessThan(1e-9);
  });

  it('rejects a singular matrix when a destination needs its inverse', () => {
    expect(createSingular).toThrow(InvalidProfileError);
    expect(createSingular).toThrow(expect.objectContaining({ reason: 'singular-matrix' }));
  });

  it('reports a missing PCS-to-device tag when a CMYK destination has no table', () => {
    expect(createWithoutTable).toThrow(InvalidProfileError);
    expect(createWithoutTable).toThrow(expect.objectContaining({ reason: 'missing-required-tag' }));
  });

  it('keeps the complete pipeline digest identical across runtimes', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    const bytes = new Uint8Array(4096 * 4 * 8);
    const view = new DataView(bytes.buffer);
    const output = new Float64Array(4);
    for (let index = 0; index < 4096; index++) {
      transform.convert(Float64Array.of((index + 0.5) / 4096, 0, 0), output);
      for (let channel = 0; channel < 4; channel++) {
        view.setFloat64((index * 4 + channel) * 8, Number(output[channel]), true);
      }
    }
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('cacc8d97316e725b4d13f347e0acdae6');
  });

  it('keeps real profile transforms identical across runtimes over the full sample set', () => {
    const fogra = parseIccProfile(fograBytes);
    const synthetic = parseIccProfile(syntheticBytes);
    const rgb = parseIccProfile(srgbV4Bytes);
    const gamma: IccProfile = {
      ...rgb,
      trc: { red: { kind: 'gamma', gamma: 2.2 }, green: { kind: 'gamma', gamma: 2.1 }, blue: { kind: 'gamma', gamma: 2.4 } },
    };
    expect(rgb.trc).toMatchObject({ red: { kind: 'parametric' } });
    expect(gamma.trc).toMatchObject({ red: { kind: 'gamma' } });
    expect(fogra.deviceToPcs[1]?.kind).toBe('lut16');
    const options = { intent: 'relativeColorimetric' as const, blackPointCompensation: true };
    const parametricTransform = createColorTransform({ kind: 'icc', profile: rgb }, fogra, options);
    const gammaTransform = createColorTransform({ kind: 'icc', profile: gamma }, synthetic, options);
    const cmykTransform = createColorTransform({ kind: 'icc', profile: fogra }, synthetic, options);
    const points = samples();
    expect(points).toHaveLength(6189);
    const bytes = new Uint8Array(points.length * 3 * 4 * 8);
    const view = new DataView(bytes.buffer);
    const output = new Float64Array(4);
    for (const [index, [red, green, blue]] of points.entries()) {
      const rgbInput = Float64Array.of(red / 255, green / 255, blue / 255);
      const cmykInput = Float64Array.of((255 - red) / 255, (255 - green) / 255, (255 - blue) / 255, ((red * 3 + green * 5 + blue * 7) % 256) / 255);
      const cases = [
        { transform: parametricTransform, input: rgbInput },
        { transform: gammaTransform, input: rgbInput },
        { transform: cmykTransform, input: cmykInput },
      ];
      for (const [caseIndex, item] of cases.entries()) {
        item.transform.convert(item.input, output);
        for (let channel = 0; channel < 4; channel++) {
          view.setFloat64(((index * cases.length + caseIndex) * 4 + channel) * 8, Number(output[channel]), true);
        }
      }
    }
    const digest = [...md5(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(digest).toBe('7c57bd50c747a7f39716aaa9e1e56d7b');
  });

  it('reports the channel counts of its source and destination', () => {
    const rgbToCmyk = createColorTransform({ kind: 'icc', profile: source() }, destination(), relative);
    const grayToRgb = createColorTransform({ kind: 'icc', profile: grayProfile('XYZ') }, iccProfile(), relative);
    expect([rgbToCmyk.inputChannels, rgbToCmyk.outputChannels, grayToRgb.inputChannels, grayToRgb.outputChannels]).toStrictEqual([3, 4, 1, 3]);
  });

  it('rejects row buffers shorter than their requested pixel count', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), {
      intent: 'relativeColorimetric',
      blackPointCompensation: false,
    });
    expect(() => {
      transform.convertRow8(new Uint8Array(2), new Uint8Array(4), 1);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      transform.convertRow16(new Uint16Array(3), new Uint16Array(3), 1);
    }).toThrow(InvalidArgumentError);
  });
});

describe('convert arguments', () => {
  it.each([2, 4])('rejects an RGB input of %d components', length => {
    expect(() => {
      rgbToLab().convert(new Float64Array(length), new Float64Array(4));
    }).toThrow(InvalidArgumentError);
  });

  it('rejects an output shorter than the destination channels', () => {
    expect(() => {
      rgbToLab().convert(new Float64Array(3), new Float64Array(3));
    }).toThrow(InvalidArgumentError);
  });

  // The source gives XYZ = 0.184 · D50, which the destination writes as a, b, L* and 0.
  const converted184 = [128 / 255, 128 / 255, (116 * Math.cbrt(0.184) - 16) / 100, 0];

  it('fills an output exactly as long as the destination channels', () => {
    const output = new Float64Array(4).fill(7);
    rgbToLab().convert(Float64Array.of(0.184, 0, 0), output);
    expect(largestDifference(output, converted184)).toBeLessThan(1e-9);
  });

  it('leaves the entries of a longer output past the destination channels untouched', () => {
    const output = new Float64Array(6).fill(7);
    rgbToLab().convert(Float64Array.of(0.184, 0, 0), output);
    expect(largestDifference(output, [...converted184, 7, 7])).toBeLessThan(1e-9);
    const white = new Float64Array(6).fill(7);
    rgbToLab().convert(Float64Array.of(1, 1, 1), white);
    expect([...white]).toStrictEqual([0, 0, 0, 0, 7, 7]);
  });

  it.each([Number.NaN, Infinity, -Infinity])('rejects a %d component in any position', value => {
    for (let position = 0; position < 3; position++) {
      const input = Float64Array.of(0.5, 0.5, 0.5);
      input[position] = value;
      expect(() => {
        rgbToLab().convert(input, new Float64Array(4));
      }).toThrow(InvalidArgumentError);
    }
  });
});

describe('converted values', () => {
  // White converted through the pipeline: XYZ D50, so L* 100 with neutral a and b.
  const pipelineWhite = [128 / 255, 128 / 255, 1, 0];

  // ICC.1:2022, 6.2.2: media white maps to PCS white, so RGB white is exactly no ink outside the absolute intent.
  it.each(['perceptual', 'relativeColorimetric', 'saturation'] as const)('maps RGB white to exactly no CMYK ink under %s', intent => {
    expect(converted({ kind: 'icc', profile: source() }, anyIntentDestination(), { intent, blackPointCompensation: false }, [1, 1, 1])).toStrictEqual([
      0, 0, 0, 0,
    ]);
  });

  it.each([
    { label: 'RGB white under the absolute intent', intent: 'absoluteColorimetric' as const, input: [1, 1, 1] },
    { label: 'RGB one ulp below white', intent: 'relativeColorimetric' as const, input: [1, 1, 1 - Number.EPSILON / 2] },
  ])('converts $label through the pipeline', ({ intent, input }) => {
    expect(
      largestDifference(converted({ kind: 'icc', profile: source() }, anyIntentDestination(), { intent, blackPointCompensation: false }, input), pipelineWhite),
    ).toBeLessThan(1e-9);
  });

  it('converts RGB white to an RGB destination through the pipeline', () => {
    expect(largestDifference(converted({ kind: 'icc', profile: source() }, iccProfile(), relative, [1, 1, 1]), [D50.x, D50.y, D50.z])).toBeLessThan(1e-12);
  });

  it('clamps destination components to [0, 1]', () => {
    const wide = iccProfile({ colorants: { red: { x: 1.2, y: 0.5, z: -0.1 }, green: { x: 0, y: 1, z: 0 }, blue: { x: 0, y: 0, z: 1 } } });
    expect(converted({ kind: 'icc', profile: wide }, iccProfile(), relative, [1, 0, 0])).toStrictEqual([1, 0.5, 0]);
  });

  describe('the absolute intent', () => {
    const input = [0.2, 0.5, 0.7];
    const sourceWhite: Xyz = { x: 0.9, y: 1, z: 0.8 };
    const destinationWhite: Xyz = { x: 0.95, y: 1, z: 0.85 };
    const absolute = { intent: 'absoluteColorimetric', blackPointCompensation: false } as const;

    it('scales by the source and destination media whites of version 4 profiles', () => {
      const output = converted(
        { kind: 'icc', profile: iccProfile({ mediaWhitePoint: sourceWhite }) },
        iccProfile({ mediaWhitePoint: destinationWhite }),
        absolute,
        input,
      );
      expect(largestDifference(output, scaled(input, sourceWhite, destinationWhite))).toBeLessThan(1e-12);
    });

    it('ignores the media whites under the relative intent', () => {
      const output = converted(
        { kind: 'icc', profile: iccProfile({ mediaWhitePoint: sourceWhite }) },
        iccProfile({ mediaWhitePoint: destinationWhite }),
        relative,
        input,
      );
      expect(largestDifference(output, input)).toBeLessThan(1e-12);
    });

    // LittleCMS 2.16 cmsio1.c, _cmsReadMediaWhitePoint: a version 2 display profile's media white is read as D50, while other version 2 classes keep their tag.
    it.each([
      {
        label: 'a version 2 display',
        profile: iccProfile({ header: { version: { major: 2, minor: 1, bugfix: 0 } }, mediaWhitePoint: sourceWhite }),
        white: PCS_D50,
      },
      {
        label: 'a version 2 input',
        profile: iccProfile({ header: { version: { major: 2, minor: 1, bugfix: 0 }, profileClass: 'input' }, mediaWhitePoint: sourceWhite }),
        white: sourceWhite,
      },
      { label: 'a version 4 display', profile: iccProfile({ mediaWhitePoint: sourceWhite }), white: sourceWhite },
      { label: 'an untagged', profile: iccProfile({ mediaWhitePoint: undefined }), white: PCS_D50 },
    ])('reads the media white of $label source', ({ profile, white }) => {
      const output = converted({ kind: 'icc', profile }, iccProfile(), absolute, input);
      expect(largestDifference(output, scaled(input, white, PCS_D50))).toBeLessThan(1e-12);
    });
  });
});

describe('row conversion', () => {
  it('converts 8-bit RGB rows like scalar calls through cache hits, slot collisions, re-misses and a second call', () => {
    const transform = createColorTransform(calRgb, rowDestination(), relative);
    // The cache slot is (251 r + 17 g + b) mod 65536, and 251 · 1 + 17 · -15 + 4 = 0, so these two pixels share a slot.
    const first = [100, 120, 80];
    const second = [101, 105, 84];
    const [firstOutput, secondOutput] = [scalarRow8(transform, [first]), scalarRow8(transform, [second])];
    expect(new Set(firstOutput).size).toBe(4);
    expect(firstOutput).not.toStrictEqual(secondOutput);
    const pixels = [first, first, second, first, second];
    expect(row8(transform, pixels)).toStrictEqual(scalarRow8(transform, pixels));
    const again = [first, second, second];
    expect(row8(transform, again)).toStrictEqual(scalarRow8(transform, again));
  });

  it('converts 16-bit RGB rows like scalar calls, including a repeated pixel', () => {
    const transform = createColorTransform(calRgb, rowDestination(), relative);
    const pixels = [
      [0, 0, 0],
      [40_000, 20_000, 9000],
      [65_535, 65_535, 65_535],
      [40_000, 20_000, 9000],
    ];
    const output = new Uint16Array(16);
    transform.convertRow16(Uint16Array.from(pixels.flat()), output, pixels.length);
    const expected = pixels.flatMap(pixel => {
      const scalar = new Float64Array(4);
      transform.convert(
        Float64Array.from(pixel, value => value / 65_535),
        scalar,
      );
      return [...scalar].map(value => Math.round(value * 65_535));
    });
    expect([...output]).toStrictEqual(expected);
  });

  // The 8-bit cache keys on the first three components of a pixel, so a transform with more input channels must not use it; pixels that differ only past the third component show that.
  it.each([
    {
      label: 'CMYK to CMYK, with pixels that differ only in black',
      source: {
        kind: 'icc' as const,
        profile: iccProfile({
          header: { profileClass: 'output', colorSpace: 'CMYK', pcs: 'Lab' },
          colorants: undefined,
          trc: undefined,
          deviceToPcs: {
            1: lut8(4, 3, ([c = 0, m = 0, y = 0, k = 0]) => [255 - 40 * c - 40 * m - 40 * y - 100 * k, 128 + 60 * c - 60 * m, 128 + 60 * y - 60 * m]),
          },
        }),
      },
      destinationProfile: destination(),
      pixels: [
        [30, 60, 90, 0],
        [30, 60, 90, 200],
        [30, 60, 90, 0],
        [30, 60, 90, 120],
      ],
    },
    {
      label: 'gray to CMYK',
      source: { kind: 'icc' as const, profile: grayProfile('XYZ') },
      destinationProfile: destination(),
      pixels: [[10], [200], [10], [37], [200]],
    },
    {
      label: 'RGB to RGB',
      source: calRgb,
      destinationProfile: iccProfile(),
      pixels: [
        [100, 120, 80],
        [101, 105, 84],
        [100, 120, 80],
      ],
    },
  ])('converts 8-bit $label rows like scalar calls', ({ source: from, destinationProfile, pixels }) => {
    const transform = createColorTransform(from, destinationProfile, relative);
    const perPixel = pixels.map(pixel => scalarRow8(transform, [pixel]).join());
    expect(new Set(perPixel).size).toBe(new Set(pixels.map(pixel => pixel.join())).size);
    expect(row8(transform, pixels)).toStrictEqual(scalarRow8(transform, pixels));
  });

  // The 8-bit cache stores four output bytes per pixel, so a transform with three output channels must not use it: a cached pixel would write a fourth byte past the row.
  it.each([
    { label: 'RGB to RGB', destinationProfile: iccProfile() },
    { label: 'RGB to CMYK', destinationProfile: rowDestination() },
  ])('writes nothing past the row when converting a repeated $label pixel', ({ destinationProfile }) => {
    const transform = createColorTransform(calRgb, destinationProfile, relative);
    const pixel = [100, 120, 80];
    transform.convertRow8(Uint8Array.from(pixel), new Uint8Array(transform.outputChannels), 1);
    const sentinel = 0xa5;
    const output = new Uint8Array(2 * transform.outputChannels).fill(sentinel);
    transform.convertRow8(Uint8Array.from(pixel), output, 1);
    expect([...output]).toStrictEqual([...scalarRow8(transform, [pixel]), ...Array.from({ length: transform.outputChannels }, () => sentinel)]);
  });

  it.each([-1, 1.5, Number.NaN, Infinity, 2 ** 53])('rejects a pixel count of %d in both row functions', pixels => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), relative);
    expect(() => {
      transform.convertRow8(new Uint8Array(6), new Uint8Array(8), pixels);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      transform.convertRow16(new Uint16Array(6), new Uint16Array(8), pixels);
    }).toThrow(InvalidArgumentError);
  });

  it('converts nothing for a pixel count of 0', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), relative);
    const output8 = Uint8Array.of(9, 9, 9, 9);
    const output16 = Uint16Array.of(9, 9, 9, 9);
    transform.convertRow8(new Uint8Array(0), new Uint8Array(0), 0);
    transform.convertRow8(Uint8Array.of(1, 2, 3), output8, 0);
    transform.convertRow16(Uint16Array.of(1, 2, 3), output16, 0);
    expect([...output8, ...output16]).toStrictEqual([9, 9, 9, 9, 9, 9, 9, 9]);
  });

  it('accepts row buffers exactly one pixel long and rejects an 8-bit output or 16-bit input one sample short', () => {
    const transform = createColorTransform({ kind: 'icc', profile: source() }, destination(), relative);
    expect(() => {
      transform.convertRow8(new Uint8Array(3), new Uint8Array(4), 1);
      transform.convertRow16(new Uint16Array(3), new Uint16Array(4), 1);
    }).not.toThrow();
    expect(() => {
      transform.convertRow8(new Uint8Array(3), new Uint8Array(3), 1);
    }).toThrow(InvalidArgumentError);
    expect(() => {
      transform.convertRow16(new Uint16Array(2), new Uint16Array(4), 1);
    }).toThrow(InvalidArgumentError);
  });
});

describe('properties', () => {
  // Pixels drawn from a small palette, so rows repeat pixels; each pair below differs by (+1, -15, +4) and so shares a cache slot.
  const palette = [
    [100, 120, 80],
    [101, 105, 84],
    [30, 200, 10],
    [31, 185, 14],
    [0, 0, 0],
    [255, 255, 255],
  ];
  const row = fc.array(fc.constantFrom(...palette), { maxLength: 40 });

  it('converts any 8-bit RGB row like scalar calls, over many calls on one transform', () => {
    const transform = createColorTransform(calRgb, rowDestination(), relative);
    fc.assert(
      fc.property(row, row, (first, second) => {
        expect(row8(transform, first)).toStrictEqual(scalarRow8(transform, first));
        expect(row8(transform, second)).toStrictEqual(scalarRow8(transform, second));
      }),
    );
  });
});
