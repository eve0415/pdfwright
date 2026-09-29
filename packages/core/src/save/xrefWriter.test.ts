import { describe, expect, it } from 'vitest';

import { fieldWidths } from './xrefWriter.ts';

describe('cross-reference writing', () => {
  it('finds field widths for more entries than a spread argument list holds', () => {
    const entries = Array.from({ length: 200_000 }, (_, objectNumber) => ({ objectNumber, type: 1, field: objectNumber * 300, generation: 0 }) as const);
    expect(fieldWidths(entries)).toStrictEqual([4, 1]);
  });
});
