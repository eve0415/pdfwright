import type { IllustratorDocument, PathItem, SpotColor } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { createNativeWriter } from './nativeWriter.ts';
import { documentColors, writeHeader } from './writeHeader.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const spot: SpotColor = { name: 'White', alternate: [0.2, 0, 0, 0] };
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
  fill: { paint: { kind: 'spot', spot } },
};
const document: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
  layers: [
    { name: 'Hidden', visible: false, items: [{ ...rectangle, fill: { paint: { kind: 'process', cmyk: [0, 0, 0, 1] } } }] },
    { name: 'Spot', items: [rectangle] },
  ],
  lastModified: date,
  title: 'Print test',
};

describe('native header comments', () => {
  it('writes the observed artboard formulas and ends metadata at EndComments CR', () => {
    const writer = createNativeWriter();
    const metaDataLength = writeHeader(writer, document);
    const text = new TextDecoder().decode(writer.finish());
    expect(metaDataLength).toBe(writer.finish().length);
    expect(text).toContain('%AI3_Cropmarks: 0 0 283.4645669291 198.4251968504\r');
    expect(text).toContain('%%PageOrigin:0 198.4251968504\r');
    expect(text).toContain('%AI3_TemplateBox: 142.5 98.9251968504 142.5 98.9251968504\r');
    expect(text).toContain('%AI3_TileBox: -261.2677165354 -180.2874015748 521.7322834646 378.7125984252\r');
  });

  it('keeps neutral provenance, visible process plates and sorted spot comments', () => {
    const writer = createNativeWriter();
    writeHeader(writer, document, { creator: 'pdfwright test' });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%%Creator: pdfwright test\r%%AI8_CreatorVersion: 30.8.2\r%%For: () ()\r');
    expect(text).toContain('%%CreationDate: 2026/09/28 12:34\r');
    expect(text).toContain('%%DocumentCustomColors: (White)\r%%CMYKCustomColor: 0.2 0 0 0 (White)\r');
    expect(text).not.toContain('%%DocumentProcessColors: Black');
    expect(text).toMatch(/%%EndComments\r$/u);
  });

  it('counts visible process plates and reverses layer order for the view flags', () => {
    const process: PathItem = { ...rectangle, fill: { paint: { kind: 'process', cmyk: [1, 0, 0, 0] } } };
    const adjusted: IllustratorDocument = { ...document, layers: [...document.layers, { name: 'Cyan', items: [process] }] };
    expect(documentColors(adjusted).process).toStrictEqual(['Cyan']);
    const writer = createNativeWriter();
    writeHeader(writer, adjusted);
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%%DocumentProcessColors: Cyan\r');
    expect(text).toContain('%AI5_OpenViewLayers: 776\r');
  });

  it('can write the top-left diagnostic coordinate convention', () => {
    const writer = createNativeWriter();
    writeHeader(writer, document, { convention: 'top-left' });
    const text = new TextDecoder().decode(writer.finish());
    expect(text).toContain('%AI3_Cropmarks: 0 -198.4251968504 283.4645669291 0\r');
    expect(text).toContain('%%PageOrigin:0 0\r');
  });
});
