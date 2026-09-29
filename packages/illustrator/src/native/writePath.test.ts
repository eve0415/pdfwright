import type { PathItem, SpotColor } from '../model/illustratorDocument.ts';
import type { FillRuleState } from './writePath.ts';

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
  fill: { paint: { kind: 'spot', spot: white, tint: 0.5 }, overprint: true },
  stroke: { paint: { kind: 'spot', spot: cut }, width: 0 },
};

describe('native paths', () => {
  it('writes a spot fill and hairline stroke as one closed object', () => {
    const writer = createNativeWriter();
    writePath(writer, rectangle);
    expect(new TextDecoder().decode(writer.finish())).toBe(
      '4 As\r1 O\r0.2 0 0 0 (White) 0.5 x\r0 R\r0 1 0 0 (Cut) 0 X\r0 1 0 0 0 Xy\r0 J 0 j 0 w 10 M []0 d\r0 XR\r10 10 m\r30 10 L\r30 20 L\r10 20 L\r10 10 L\rb\r',
    );
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
});
