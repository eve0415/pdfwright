import type { IllustratorDocument, Layer, PathItem } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeNative } from './writeNative.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 0, offset: 'Z' });
const path: PathItem = {
  kind: 'path',
  geometry: {
    start: [1, 2],
    segments: [
      { kind: 'line', to: [11, 2] },
      { kind: 'line', to: [11, 12] },
      { kind: 'line', to: [1, 12] },
    ],
  },
  fill: { paint: { kind: 'process', cmyk: [0, 0, 1, 0] } },
};
const hiddenLayer: Layer = { name: '非表示', visible: false, items: [path] };
const baseLayer: Layer = { name: 'Base 30%', opacity: 0.3, items: [{ kind: 'group', opacity: 0.5, isolated: true, items: [path] }] };
const document: IllustratorDocument = {
  artboard: { width: 100, height: 70 },
  layers: [hiddenLayer, baseLayer],
  lastModified: date,
};

describe('native data assembly', () => {
  it('writes the metadata prefix, setup, layer order and transparency trailers', () => {
    const result = writeNative(document);
    const text = new TextDecoder().decode(result.bytes);
    expect(new TextDecoder().decode(result.bytes.slice(0, result.metaDataLength))).toMatch(/%%EndComments\r$/u);
    expect(text).toContain('%%BeginProlog\r%%EndProlog\r%%BeginSetup\r%AI5_BeginPalette\r');
    expect(text.indexOf('(非表示) Ln')).toBeLessThan(text.indexOf('(Base 30%) Ln'));
    expect(text).toContain('0 1 1 1 0 0 0 0 79 128 255 0 50 0 Lb\r(非表示) Ln\r');
    expect(text).toContain('U\r0 0.5 1 0 0 Xy\r0 0 Xd\r6 () XW\r0 0.3 0 2 0 Xy\r0 0 Xd\r7 () XW\r');
  });

  it('writes the active artboard index immediately after the artboard array', () => {
    const text = new TextDecoder().decode(writeNative(document).bytes);
    expect(text).toContain('%_; (ArtboardArray) ,\r%_0 /Int (CropAreaActive) ,\r');
  });

  it.each([
    ['bottom-left', -904, 509],
    ['top-left', -904, 439],
  ] as const)('centres OpenToView on the artboard in %s coordinates', (convention, left, top) => {
    const text = new TextDecoder().decode(writeNative(document, { convention }).bytes);
    const prefix = `${String(left)} ${String(top)} 1`;
    const block = `%AI17_Begin_Content_if_version_gt:24 4\r%AI10_OpenToVie: ${prefix} 0 0 0 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1\r%AI17_Alternate_Content\r%AI9_OpenToView: ${prefix} 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1\r%AI17_End_Versioned_Content\r`;
    const layerLine = '%AI5_OpenViewLayers: 76\r';
    const emptyTwin = '%AI17_Begin_Content_if_version_gt:24 4\r%AI17_Alternate_Content\r%AI17_End_Versioned_Content\r';
    expect(text).toContain(`${block}${layerLine}${emptyTwin}`);
  });

  it('is deterministic and changes its artboard UUID with layer content', () => {
    const first = writeNative(document);
    const second = writeNative(document);
    expect(first.bytes).toStrictEqual(second.bytes);
    const changed = writeNative({ ...document, layers: [{ ...hiddenLayer, name: 'Hidden' }, baseLayer] });
    expect(changed.bytes).not.toStrictEqual(first.bytes);
    const text = new TextDecoder().decode(first.bytes);
    expect(text).toMatch(/%_\([0-9a-f-]{36}\) \/String \(ArtboardUUID\) ,\r/u);
    expect(text).not.toContain('c2pa');
  });

  it('moves native coordinates for the top-left diagnostic convention', () => {
    const text = new TextDecoder().decode(writeNative(document, { convention: 'top-left' }).bytes);
    expect(text).toContain('1 -68 m\r');
    expect(text).toContain('%_0 0 /RealPointRelToROrigin\r');
  });
});
