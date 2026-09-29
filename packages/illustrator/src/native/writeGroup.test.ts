import type { ClipGroup, Group, PathItem } from '../model/illustratorDocument.ts';

import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeClipGroup, writeGroup } from './writeGroup.ts';
import { writePath } from './writePath.ts';

const path: PathItem = {
  kind: 'path',
  geometry: {
    start: [0, 0],
    segments: [
      { kind: 'line', to: [2, 0] },
      { kind: 'line', to: [2, 2] },
      { kind: 'line', to: [0, 2] },
    ],
  },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } },
};

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
