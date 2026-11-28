import { describe, expect, it } from 'vitest';

import { registeredPrintingConditions } from './printingConditions.ts';

describe('icc printing conditions', () => {
  it('lists each reference name once, since lookups take the first match', () => {
    const names = registeredPrintingConditions.map(condition => condition.identifier);
    expect(new Set(names).size).toBe(names.length);
  });
});
