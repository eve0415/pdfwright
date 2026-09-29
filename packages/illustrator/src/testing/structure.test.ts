import type { IllustratorDocument } from '../model/illustratorDocument.ts';

import { mm, pdfDate } from '@pdfwright/core';
import { describe, expect, it } from 'vitest';

import { writeIllustratorPdf } from '../writeIllustratorPdf.ts';

import { readIllustratorContainer, readIllustratorPdf } from './readIllustratorPdf.ts';

const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 34, second: 56, offset: 'Z' });
const model: IllustratorDocument = {
  artboard: { width: mm(100), height: mm(70), bleed: mm(3) },
  layers: [
    {
      name: 'Cut',
      items: [
        {
          kind: 'path',
          geometry: {
            subpaths: [
              {
                start: [10, 10],
                segments: [
                  { kind: 'line', to: [20, 10] },
                  { kind: 'line', to: [20, 20] },
                  { kind: 'line', to: [10, 20] },
                ],
              },
            ],
          },
          stroke: { paint: { kind: 'spot', spot: { name: 'Cut', alternate: [0, 1, 0, 0] } }, width: 0.25 },
        },
      ],
    },
  ],
  lastModified: date,
};

describe('illustrator PDF structure', () => {
  it('uses the observed one-block PDF private-data structure', () => {
    const facts = readIllustratorContainer(writeIllustratorPdf(model));
    expect(facts.blockLengths).toHaveLength(1);
    expect(facts.privateKeys).toStrictEqual([
      'AIMetaData',
      'AIPDFPrivateData1',
      'ContainerVersion',
      'CreatorVersion',
      'RoundtripStreamType',
      'RoundtripVersion',
    ]);
    expect([facts.containerVersion, facts.creatorVersion, facts.roundtripStreamType, facts.roundtripVersion]).toStrictEqual([9, 30, 2, 30]);
    expect([facts.frameHeaderDescriptor, facts.windowDescriptor]).toStrictEqual([0, 0x58]);
    expect(facts.pageDate).toStrictEqual(facts.applicationDate);
  });

  it('reads the synthesized native model through the PDF wrapper', () => {
    const read = readIllustratorPdf(writeIllustratorPdf(model));
    expect(read.document.layers.map(layer => layer.name)).toStrictEqual(['Cut']);
    expect(read.header.get('%AI3_Cropmarks')).toBe('0 0 283.4645669291 198.4251968504');
    expect(read.native.slice(0, read.metaData?.length)).toStrictEqual(read.metaData);
  });
});
