import { describe, expect, it } from 'vitest';

import { cmyk } from './color.ts';
import { createDocumentHandles } from './documentHandles.ts';

describe('document handles', () => {
  it('returns the same separation handle for the same colorant and alternate, and a new one for another colorant', () => {
    const handles = createDocumentHandles({ fractionDigits: 5, asciiOnlyColorants: false });
    const first = handles.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) });
    const again = handles.separation({ name: 'Spot', alternate: cmyk(0, 0.5, 0, 0) });
    const other = handles.separation({ name: 'Other', alternate: cmyk(0, 0.5, 0, 0) });
    expect([again === first, other === first]).toStrictEqual([true, false]);
  });
});
