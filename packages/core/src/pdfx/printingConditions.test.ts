import { describe, expect, it } from 'vitest';

import { registeredPrintingConditions } from './printingConditions.ts';

describe('icc printing conditions', () => {
  it('records the registry source and snapshot for distinct reference names', () => {
    const names = registeredPrintingConditions.map(condition => condition.identifier);
    expect(new Set(names).size).toBe(names.length);
    expect(registeredPrintingConditions.length).toBeGreaterThan(40);
    for (const condition of registeredPrintingConditions) {
      expect(condition.source).toBe('https://registry.color.org/cmyk-registry/');
      expect(condition.snapshotDate).toBe('2026-09-28');
      expect(condition.process.length).toBeGreaterThan(0);
      expect(condition.media.length).toBeGreaterThan(0);
      expect(condition.designation.length).toBeGreaterThan(0);
    }
  });

  it('records the registry wording without carrying ICC profiles', () => {
    expect(registeredPrintingConditions.find(condition => condition.identifier === 'FOGRA39')).toMatchObject({
      process: 'Offset',
      media: 'Gloss or matt coated, 115 g/m2',
      designation: 'OFCOM',
    });
    expect(registeredPrintingConditions.find(condition => condition.identifier === 'JC200103')).toMatchObject({
      process: 'Offset',
      media: 'Gloss or matt coated, 105 g/m2',
      designation: 'Japan Color 2001 Coated',
    });
    expect(registeredPrintingConditions.find(condition => condition.identifier === 'CGATS21-2-CRPC1')).toMatchObject({
      process: 'Universal',
      media: 'Newsprint',
      designation: 'CGATS21-2',
    });
  });
});
