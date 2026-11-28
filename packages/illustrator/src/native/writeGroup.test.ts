import type { ClipGroup, Group, Item, PathItem, Subpath } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';
import type { FillRuleState } from './writePath.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeClipGroup, writeGroup } from './writeGroup.ts';
import { writeLayer } from './writeLayer.ts';
import { writePath } from './writePath.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
// Writes the path items a group hands it with the real path writer, so the output shows which items arrived and in what order.
const pathWriter =
  (writer: NativeWriter) =>
  (item: Item): void => {
    if (item.kind === 'path') {
      writePath(writer, item);
    }
  };
const paths = (...items: ReadonlyArray<PathItem>): string => {
  const writer = createNativeWriter();
  for (const item of items) {
    writePath(writer, item);
  }
  return decode(writer.finish());
};

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

  it.each([
    ['an isolated translucent group', { opacity: 0.3, isolated: true }, '0 0.3 1 0 0 Xy\r0 0 Xd\r6 () XW\r'],
    ['a translucent group that is not isolated', { opacity: 0.5 }, '0 0.5 0 0 0 Xy\r0 0 Xd\r6 () XW\r'],
    ['an isolated opaque group', { opacity: 1, isolated: true }, '0 1 1 0 0 Xy\r0 0 Xd\r6 () XW\r'],
    ['a fully transparent group', { opacity: 0 }, '0 0 0 0 0 Xy\r0 0 Xd\r6 () XW\r'],
    ['an explicitly opaque group that is not isolated', { opacity: 1, isolated: false }, ''],
    ['a group with default transparency', {}, ''],
  ] as const)('writes the transparency trailer after U for %s', (_name, transparency, trailer) => {
    const group: Group = { kind: 'group', ...transparency, items: [path] };
    const writer = createNativeWriter();
    writeGroup(writer, group, { writeItem: pathWriter(writer) });
    expect(decode(writer.finish())).toBe(`0 Ae\ru\r${paths(path)}U\r${trailer}`);
  });

  it('writes each item it holds in order before the clipping path or the group end', () => {
    const cyan: PathItem = { ...path, fill: { paint: { kind: 'process', cmyk: [1, 0, 0, 0] } } };
    const magenta: PathItem = { ...path, fill: { paint: { kind: 'process', cmyk: [0, 1, 0, 0] } } };
    const clipped = createNativeWriter();
    writeClipGroup(clipped, { kind: 'clipGroup', clip: path.geometry, items: [cyan, magenta] }, { writeItem: pathWriter(clipped) });
    expect(decode(clipped.finish())).toBe(`0 Ae\rq\r${paths(cyan, magenta)}4 As\r0 0 m\r2 0 L\r2 2 L\r0 2 L\r0 0 L\rh\rW\rn\rQ\r9 () XW\r`);
    const grouped = createNativeWriter();
    writeGroup(grouped, { kind: 'group', items: [cyan, magenta] }, { writeItem: pathWriter(grouped) });
    expect(decode(grouped.finish())).toBe(`0 Ae\ru\r${paths(cyan, magenta)}U\r`);
  });

  it.each([
    ['writes XR and selects nonzero after a layer state of even-odd', 'evenodd', '0 XR\r'],
    ['writes no XR after a layer state of nonzero', 'nonzero', ''],
  ] as const)('%s', (_name, before, xr) => {
    const state: FillRuleState = { value: before };
    const writer = createNativeWriter();
    writeClipGroup(writer, { kind: 'clipGroup', clip: path.geometry, items: [] }, { writeItem: pathWriter(writer), fillRuleState: state });
    expect(decode(writer.finish())).toBe(`0 Ae\rq\r4 As\r${xr}0 0 m\r2 0 L\r2 2 L\r0 2 L\r0 0 L\rh\rW\rn\rQ\r9 () XW\r`);
    expect(state.value).toBe('nonzero');
  });
});
