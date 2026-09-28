import type { PathItem, SpotColor } from '../model/illustratorDocument.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writePath } from './writePath.ts';

const white: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
const rectangle: PathItem = {
  kind: 'path',
  geometry: {
    start: [10, 10],
    segments: [
      { kind: 'line', to: [30, 10] },
      { kind: 'line', to: [30, 20] },
      { kind: 'line', to: [10, 20] },
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
        start: [0, 0],
        segments: [
          { kind: 'curve', control1: [0, 5], control2: [5, 5], to: [5, 0], anchor: 'smooth' },
          { kind: 'line', to: [0, 0] },
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
});
