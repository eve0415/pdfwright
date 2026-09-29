import { describe, expect, it } from 'vitest';

import { writePrintPage } from './readmeExample.ts';

const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('readme print page', () => {
  it('writes a spot fill, cut path, and print boxes', () => {
    const saved = writePrintPage();
    const pdf = ascii(saved.toBytes());
    expect(pdf).toContain('/TrimBox');
    expect(pdf).toContain('/BleedBox');
    expect(pdf).toContain('/Separation /White');
    expect(pdf).toContain('/Separation /Cut');
    expect(saved.chunks.length).toBeGreaterThan(1);
  });
});
