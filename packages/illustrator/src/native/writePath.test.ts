import type { PathItem, SpotColor } from '../model/illustratorDocument.ts';
import type { FillRuleState, NativePathOptions } from './writePath.ts';
import type { Length } from '@pdfwright/core';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writePath } from './writePath.ts';

const white: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
const rectangle: PathItem = {
  kind: 'path',
  geometry: {
    subpaths: [
      {
        start: [10, 10],
        segments: [
          { kind: 'line', to: [30, 10] },
          { kind: 'line', to: [30, 20] },
          { kind: 'line', to: [10, 20] },
        ],
      },
    ],
  },
  // A tint other than 0.5, so that writing the tint and writing 1 minus the tint differ.
  fill: { paint: { kind: 'spot', spot: white, tint: 0.25 }, overprint: true },
  stroke: { paint: { kind: 'spot', spot: cut }, width: 0 },
};

const render = (item: PathItem, options?: NativePathOptions): string => {
  const writer = createNativeWriter();
  writePath(writer, item, options);
  return new TextDecoder().decode(writer.finish());
};

describe('native paths', () => {
  it('writes a spot fill and hairline stroke as one closed object', () => {
    expect(render(rectangle)).toBe(
      '4 As\r1 O\r0.2 0 0 0 (White) 0.75 x\r0 R\r0 1 0 0 (Cut) 0 X\r0 1 0 0 0 Xy\r0 J 0 j 0 w 10 M []0 d\r0 XR\r10 10 m\r30 10 L\r30 20 L\r10 20 L\r10 10 L\rb\r',
    );
  });

  it.each([
    ['a spot fill at tint 0', { fill: { paint: { kind: 'spot', spot: white, tint: 0 } } }, '0 O\r0.2 0 0 0 (White) 1 x\r'],
    ['a spot fill at tint 1', { fill: { paint: { kind: 'spot', spot: white, tint: 1 } } }, '0 O\r0.2 0 0 0 (White) 0 x\r'],
    ['a spot fill without a tint at full strength', { fill: { paint: { kind: 'spot', spot: white } } }, '0 O\r0.2 0 0 0 (White) 0 x\r'],
    ['an overprinting process stroke', { stroke: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] }, width: 1, overprint: true } }, '1 R\r0 0 1 0 K\r'],
  ] as const)('writes %s', (_name, paint, expected) => {
    expect(render({ kind: 'path', geometry: rectangle.geometry, ...paint })).toContain(`4 As\r${expected}0 1 0 0 0 Xy\r`);
  });

  it('writes a smooth line anchor as l', () => {
    const smooth: PathItem = {
      kind: 'path',
      geometry: {
        subpaths: [
          {
            start: [0, 0],
            segments: [
              { kind: 'line', to: [5, 0], anchor: 'smooth' },
              { kind: 'line', to: [5, 5] },
            ],
          },
        ],
      },
      fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
    };
    expect(render(smooth)).toMatch(/\r0 0 m\r5 0 l\r5 5 L\r0 0 L\rf\r$/u);
  });

  it('decides the closing line on formatted coordinates', () => {
    // The last point formats to 0 0, the start, so no closing line is added; comparing raw numbers would add one and count 3 anchors.
    const nearlyClosed: PathItem = {
      kind: 'path',
      geometry: {
        subpaths: [
          {
            start: [0, 0],
            segments: [
              { kind: 'line', to: [5, 5] },
              { kind: 'line', to: [1e-11, 0] },
            ],
          },
        ],
      },
      fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
    };
    const text = render(nearlyClosed);
    expect(text).toMatch(/^2 As\r/u);
    expect(text).toMatch(/\r0 0 m\r5 5 L\r0 0 L\rf\r$/u);
  });

  it('formats an exact length without converting it to a number when there is no y offset', () => {
    // 5e-11 plus 1e-30 rounds up to the tenth decimal place, while its nearest double, 5e-11, rounds half to even, down to 0.
    const half: Length = { numerator: 5n * 10n ** 19n + 1n, denominator: 10n ** 30n };
    const item: PathItem = {
      kind: 'path',
      geometry: { subpaths: [{ start: [half, half], segments: [{ kind: 'line', to: [5, 5] }] }] },
      fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
    };
    expect(render(item)).toContain('\r0.0000000001 0.0000000001 m\r5 5 L\r0.0000000001 0.0000000001 L\rf\r');
  });

  it('shifts an exact length whose numerator alone is beyond Number range by the y offset', () => {
    // 10^309 / 10^308 is 10 points, and 10^309 is beyond Number range while 10^308 is not.
    const ten: Length = { numerator: 10n ** 309n, denominator: 10n ** 308n };
    const item: PathItem = {
      kind: 'path',
      geometry: { subpaths: [{ start: [5, ten], segments: [{ kind: 'line', to: [5, 5] }] }] },
      fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
    };
    expect(render(item, { yOffset: -100 })).toContain('\r5 -90 m\r5 -95 L\r5 -90 L\rf\r');
  });

  it('writes smooth curves and process fill in shifted coordinates', () => {
    const path: PathItem = {
      kind: 'path',
      geometry: {
        subpaths: [
          {
            start: [0, 0],
            segments: [
              { kind: 'curve', control1: [0, 5], control2: [5, 5], to: [5, 0], anchor: 'smooth' },
              { kind: 'line', to: [0, 0] },
            ],
          },
        ],
      },
      fill: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } },
    };
    const writer = createNativeWriter();
    writePath(writer, path, { yOffset: -70 });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('2 As\r0 O\r0 0 1 0 k\r');
    expect(text).toContain('0 -70 m\r0 -65 5 -65 5 -70 c\r0 -70 L\rf\r');
    expect(text).toContain('0 J 0 j 1 w 10 M []0 d\r');
  });

  it('writes several subpaths as a compound path with the paint state on its first member', () => {
    const die: PathItem = {
      kind: 'path',
      geometry: {
        subpaths: [
          {
            start: [0, 0],
            segments: [
              { kind: 'line', to: [40, 0] },
              { kind: 'line', to: [40, 30] },
              { kind: 'line', to: [0, 30] },
            ],
          },
          { start: [10, 10], segments: [{ kind: 'quadratic', control: [15, 25], to: [20, 10] }] },
        ],
        fillRule: 'evenodd',
      },
      stroke: { paint: { kind: 'spot', spot: cut }, width: 0.25 },
    };
    const writer = createNativeWriter();
    writePath(writer, die, { yOffset: -100 });
    expect(new TextDecoder().decode(writer.finish())).toBe(
      [
        '0 Ae',
        '*u',
        '4 As',
        '0 R',
        '0 1 0 0 (Cut) 0 X',
        '0 1 0 0 0 Xy',
        '0 J 0 j 0.25 w 10 M []0 d',
        '1 XR',
        '0 -100 m',
        '40 -100 L',
        '40 -70 L',
        '0 -70 L',
        '0 -100 L',
        's',
        '2 As',
        '10 -90 m',
        '13.3333333333 -80 16.6666666667 -80 20 -90 C',
        '10 -90 L',
        's',
        '*U',
        '',
      ].join('\r'),
    );
  });

  it('selects the nonzero rule on a path that does not name one', () => {
    const writer = createNativeWriter();
    const state: FillRuleState = { value: 'evenodd' };
    writePath(writer, rectangle, { fillRuleState: state });
    expect(new TextDecoder().decode(writer.finish())).toContain('\r0 XR\r10 10 m\r');
    expect(state.value).toBe('nonzero');
  });

  it('records the even-odd rule a compound path selects', () => {
    const state: FillRuleState = { value: 'nonzero' };
    const compound: PathItem = { ...rectangle, geometry: { subpaths: [...rectangle.geometry.subpaths, ...rectangle.geometry.subpaths], fillRule: 'evenodd' } };
    expect(render(compound, { fillRuleState: state })).toContain('\r1 XR\r10 10 m\r');
    expect(state.value).toBe('evenodd');
  });
});
