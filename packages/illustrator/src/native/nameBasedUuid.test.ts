import { describe, expect, it } from 'vitest';

import { nameBasedUuid, uuidV3 } from './nameBasedUuid.ts';

describe('name-based native identifiers', () => {
  it('matches the RFC 9562 UUIDv3 test vector', () => {
    const namespace = new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
    expect(uuidV3(namespace, new TextEncoder().encode('www.example.com'))).toBe('5df41881-3aed-3515-88a7-2f4a814cf09e');
  });

  it('changes identifiers with content, role or path but repeats identical input', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const original = nameBasedUuid('raster-color', bytes, 'layer/0');
    expect(nameBasedUuid('raster-color', bytes, 'layer/0')).toBe(original);
    expect(nameBasedUuid('raster-alpha', bytes, 'layer/0')).not.toBe(original);
    expect(nameBasedUuid('raster-color', bytes, 'layer/1')).not.toBe(original);
    expect(nameBasedUuid('raster-color', new Uint8Array([1, 2, 4]), 'layer/0')).not.toBe(original);
    expect(original).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});
