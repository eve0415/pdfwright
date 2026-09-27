import { describe, expect, it } from 'vitest';

import { inflateZlib } from '../flate/inflate.ts';
import { formatLength, mm } from '../length/length.ts';

import { createProductionPage } from './productionPageFixture.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('production page structure', () => {
  it('writes exact millimetre boxes, four separations, and private data', () => {
    const pdf = ascii(createProductionPage().saved.toBytes());
    const expectedTrim = [mm(5), mm(5), mm(45), mm(35)].map(value => formatLength(value, 5)).join(' ');
    const expectedBleed = [mm(3), mm(3), mm(47), mm(37)].map(value => formatLength(value, 5)).join(' ');
    for (const fragment of [
      `/TrimBox[${expectedTrim}]`,
      `/BleedBox[${expectedBleed}]`,
      '/Separation /White',
      '/Separation /Primer',
      '/#82b#82t#82s',
      '/#82e#82n#82k#82c',
      'stream\nprint page private data\nendstream',
    ]) {
      expect(pdf).toContain(fragment);
    }
  });

  it('clips the content and uses hairline strokes and a group XObject', () => {
    const bytes = createProductionPage().saved.toBytes();
    const pdf = ascii(bytes);
    const start = pdf.indexOf('\nstream\n', pdf.indexOf('/Filter/FlateDecode')) + 8;
    const end = pdf.indexOf('\nendstream', start);
    const contents = ascii(inflateZlib(bytes.subarray(start, end)).data);
    expect(contents).toContain('W\nn\n');
    expect(contents).toContain('0 w\n');
    expect(contents).toContain('/Fm1 Do');
  });
});
