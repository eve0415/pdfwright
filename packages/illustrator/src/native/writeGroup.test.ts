import type { ClipGroup, Group, PathItem, Subpath } from '../model/illustratorDocument.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeClipGroup, writeGroup } from './writeGroup.ts';
import { writeLayer } from './writeLayer.ts';
import { writePath } from './writePath.ts';

const square: Subpath = {
  start: [0, 0],
  segments: [
    { kind: 'line', to: [2, 0] },
    { kind: 'line', to: [2, 2] },
    { kind: 'line', to: [0, 2] },
  ],
};
const path: PathItem = { kind: 'path', geometry: { subpaths: [square] }, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } };

describe('native groups', () => {
  it('writes the clipping path after its content', () => {
    const group: ClipGroup = { kind: 'clipGroup', clip: path.geometry, items: [path] };
    const writer = createNativeWriter();
    writeClipGroup(writer, group, {
      writeItem: () => {
        writePath(writer, path);
      },
      yOffset: -10,
    });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toMatch(/^0 Ae\rq\r/u);
    expect(text.indexOf('f\r')).toBeLessThan(text.indexOf('4 As\r0 -10 m\r'));
    expect(text).toMatch(/0 -10 L\rh\rW\rn\rQ\r9 \(\) XW\r$/u);
  });

  it('writes a clip of several subpaths as a compound path whose members each end with h W n', () => {
    const inner: Subpath = {
      start: [0.5, 0.5],
      segments: [
        { kind: 'line', to: [1.5, 0.5] },
        { kind: 'line', to: [1, 1.5] },
      ],
    };
    const group: ClipGroup = { kind: 'clipGroup', clip: { subpaths: [square, inner], fillRule: 'evenodd' }, items: [path] };
    const writer = createNativeWriter();
    writeClipGroup(writer, group, {
      writeItem: () => {
        writePath(writer, path);
      },
      yOffset: -10,
    });
    expect(new TextDecoder().decode(writer.finish())).toMatch(
      /f\r0 Ae\r\*u\r4 As\r1 XR\r0 -10 m\r2 -10 L\r2 -8 L\r0 -8 L\r0 -10 L\rh\rW\rn\r3 As\r0.5 -9.5 m\r1.5 -9.5 L\r1 -8.5 L\r0.5 -9.5 L\rh\rW\rn\r\*U\rQ\r9 \(\) XW\r$/u,
    );
  });

  it('writes XR on a clipping path only when its rule differs from the rule last selected in the layer', () => {
    const inner: ClipGroup = { kind: 'clipGroup', clip: { ...path.geometry, fillRule: 'evenodd' }, items: [path] };
    const outer: ClipGroup = { kind: 'clipGroup', clip: path.geometry, items: [inner] };
    const writer = createNativeWriter();
    writeLayer(writer, { name: 'Clips', items: [outer] }, { index: 0 });
    // The painted path selects nonzero and the inner clip even-odd, so the outer clip has to select nonzero again.
    expect([...new TextDecoder().decode(writer.finish()).matchAll(/\d XR|h\rW/gu)].map(match => match[0])).toStrictEqual([
      '0 XR',
      '1 XR',
      'h\rW',
      '0 XR',
      'h\rW',
    ]);
    const plain = createNativeWriter();
    writeLayer(plain, { name: 'Clips', items: [{ ...outer, items: [path] }] }, { index: 0 });
    expect([...new TextDecoder().decode(plain.finish()).matchAll(/\d XR|h\rW/gu)].map(match => match[0])).toStrictEqual(['0 XR', 'h\rW']);
  });

  it('writes isolated group opacity after U and omits the trailer at defaults', () => {
    const group: Group = { kind: 'group', opacity: 0.3, isolated: true, items: [path] };
    const writer = createNativeWriter();
    writeGroup(writer, group, {
      writeItem: () => {
        writePath(writer, path);
      },
    });
    expect(new TextDecoder().decode(writer.finish())).toMatch(/U\r0 0.3 1 0 0 Xy\r0 0 Xd\r6 \(\) XW\r$/u);
    const plain = createNativeWriter();
    writeGroup(
      plain,
      { ...group, opacity: 1, isolated: false },
      {
        writeItem: () => {
          writePath(plain, path);
        },
      },
    );
    expect(new TextDecoder().decode(plain.finish())).toMatch(/U\r$/u);
  });
});
