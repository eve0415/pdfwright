import { describe, expect, it } from 'vitest';

import { standard14Metrics } from './standard14.ts';

describe('standard 14 font metrics', () => {
  it('gives the AFM width of each glyph name and nothing for names the font lacks', () => {
    const widths = [
      standard14Metrics('Helvetica')?.width('A'),
      standard14Metrics('Times-Roman')?.width('A'),
      standard14Metrics('Courier-Bold')?.width('Euro'),
      standard14Metrics('Symbol')?.width('alpha'),
      standard14Metrics('ZapfDingbats')?.width('a1'),
      standard14Metrics('Helvetica')?.width('a1'),
    ];
    expect(widths).toStrictEqual([667, 722, 600, 631, 974, undefined]);
  });

  it('gives the AFM FontBBox and nothing for other fonts', () => {
    expect([standard14Metrics('Helvetica')?.bbox, standard14Metrics('Symbol')?.bbox, standard14Metrics('Arial')]).toStrictEqual([
      [-166, -225, 1000, 931],
      [-180, -293, 1090, 1010],
      undefined,
    ]);
  });
});
