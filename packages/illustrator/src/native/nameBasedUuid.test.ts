import { InvalidArgumentError } from '@pdfwright/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nameBasedUuid, uuidV3 } from './nameBasedUuid.ts';

// RFC 9562, 6.6, Table 3: the DNS namespace ID.
const dnsNamespace = new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
// RFC 9562, 4.2 and 4.1: the version nibble is 3 and the variant bits are 10.
const uuidV3Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('name-based native identifiers', () => {
  it('matches the RFC 9562 UUIDv3 test vector', () => {
    // RFC 9562, A.2.
    expect(uuidV3(dnsNamespace, new TextEncoder().encode('www.example.com'))).toBe('5df41881-3aed-3515-88a7-2f4a814cf09e');
  });

  it('hashes the namespace alone for an empty name', () => {
    // MD5 of the 16 namespace bytes is c87ee6744ddc3efe274edfe25da5d7b3; RFC 9562, 5.3 then sets byte 6 to 0x3e and byte 8 to 0xa7.
    expect(uuidV3(dnsNamespace, new Uint8Array())).toBe('c87ee674-4ddc-3efe-a74e-dfe25da5d7b3');
  });

  it.each([15, 17])('rejects a %i-byte namespace', length => {
    expect(() => uuidV3(new Uint8Array(length), new Uint8Array())).toThrow(InvalidArgumentError);
  });

  it('changes identifiers with content, role or path but repeats identical input', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const original = nameBasedUuid('raster-color', bytes, 'layer/0');
    expect(nameBasedUuid('raster-color', bytes, 'layer/0')).toBe(original);
    expect(nameBasedUuid('raster-alpha', bytes, 'layer/0')).not.toBe(original);
    expect(nameBasedUuid('raster-color', bytes, 'layer/1')).not.toBe(original);
    expect(nameBasedUuid('raster-color', new Uint8Array([1, 2, 4]), 'layer/0')).not.toBe(original);
    expect(original).toMatch(uuidV3Pattern);
  });
});

describe('properties', () => {
  it('derives a repeatable UUIDv3 from any role, content and path', () => {
    fc.assert(
      fc.property(fc.string(), fc.uint8Array({ maxLength: 64 }), fc.string(), (role, content, path) => {
        const uuid = nameBasedUuid(role, content, path);
        expect(uuid).toMatch(uuidV3Pattern);
        expect(nameBasedUuid(role, content.slice(), path)).toBe(uuid);
      }),
    );
  });
});
