import { describe, expect, it } from 'vitest';

import { CORE14_FONTS, CORE14_LATIN_NAMES } from './core14Metrics.ts';
import { STANDARD_14, standard14Metrics } from './standard14.ts';

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

  it('has metrics for each of the standard 14 fonts, each with the width of its space', () => {
    // Every AFM file of the standard 14 fonts, Symbol and ZapfDingbats included, lists space first.
    const spaces = [...STANDARD_14].map(name => [name, standard14Metrics(name)?.width('space')]);
    expect(spaces.filter(([, width]) => width === undefined)).toStrictEqual([]);
    expect(spaces).toHaveLength(14);
  });

  it('gives each bundled font as many widths as glyph names', () => {
    const counts = Object.entries(CORE14_FONTS).map(([name, font]) => [
      name,
      (font.names ?? CORE14_LATIN_NAMES).split(' ').length - font.widths.split(' ').length,
    ]);
    expect(counts.filter(([, difference]) => difference !== 0)).toStrictEqual([]);
    expect(counts).toHaveLength(14);
  });
});
