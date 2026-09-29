import { describe, expect, it } from 'vitest';

import { writeColorants } from './colorantExample.ts';

describe('colorant example', () => {
  it('keeps raw bytes and reports reserved plates and white overprint', () => {
    const result = writeColorants();
    expect(result.whiteOverprintReason).toBe('invisible-overprint');
    expect(result.colorants.map(colorant => colorant.kind)).toContain('all');
    expect(result.colorants.map(colorant => colorant.kind)).toContain('none');
    expect(result.colorants.map(colorant => colorant.name)).toContainEqual(Uint8Array.of(0x82, 0xa0));
  });
});
