import type { IllustratorDocument, SpotColor } from '../model/illustratorDocument.ts';

import { pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { writeDocumentData } from './writeDocumentData.ts';
import { writePalette } from './writePalette.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 0, minute: 0, second: 0, offset: 'Z' });
const white: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
const cut: SpotColor = { name: 'Cut', alternate: [0, 1, 0, 0] };
const document: IllustratorDocument = {
  artboard: { width: 100, height: 70, bleed: { top: 3, right: 2, bottom: 1, left: 4 } },
  layers: [
    {
      name: 'Spots',
      items: [
        {
          kind: 'path',
          geometry: { subpaths: [{ start: [0, 0], segments: [{ kind: 'line', to: [10, 0] }] }] },
          fill: { paint: { kind: 'spot', spot: white } },
        },
        { kind: 'raster', width: 1, height: 1, bounds: { x: 0, y: 0, width: 1, height: 1 }, color: { space: 'spot', spot: cut }, alpha: new Uint8Array([255]) },
      ],
    },
  ],
  lastModified: date,
};

describe('native setup', () => {
  it('writes all spot swatches in UTF-8 byte order', () => {
    const writer = createNativeWriter();
    writePalette(writer, document);
    expect(new TextDecoder().decode(writer.finish())).toBe(
      '%AI5_BeginPalette\r0 0 Pb\r0 1 0 0 (Cut) 0 x\r(Cut)\rPc\r0.2 0 0 0 (White) 0 x\r(White)\rPc\rPB\r%AI5_EndPalette\r',
    );
  });

  it('declares the artboard, ruler origin, bleed and deterministic UUID', () => {
    const writer = createNativeWriter();
    writeDocumentData(writer, document, { artboardUuid: 'd1407a68-df67-3fd7-9ab1-e274337d49bd' });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%_0 70 /RealPointRelToROrigin\r%_ (PositionPoint1) ,\r%_100 0 /RealPointRelToROrigin\r');
    expect(text).toContain('%_8141 8156 /RealPoint\r%_ (RulerOrigin) ,\r');
    expect(text).toContain('%_(d1407a68-df67-3fd7-9ab1-e274337d49bd) /String (ArtboardUUID) ,\r');
    expect(text).toContain('%_4 /Real (BleedLeftValue) ,\r%_2 /Real (BleedRightValue) ,\r%_3 /Real (BleedTopValue) ,\r%_1 /Real (BleedBottomValue) ,\r');
    expect(text).toMatch(/%_; \/Recorded ,\r%_;\r%AI9_EndDocumentData\r$/u);
  });
});
