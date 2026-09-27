import type { SectionChain } from './sectionChain.ts';

import { describe, expect, it } from 'vitest';

import { EncryptedDocumentError } from '../error/encryptedDocumentError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { refuseEncryption } from './encryption.ts';
import { readSectionChain, searchOrder } from './sectionChain.ts';

const ignore = (): void => {
  // Warnings are not under test here.
};

const chainOf = (trailers: readonly string[], xref: 'classic' | 'stream' = 'classic'): SectionChain => {
  const pdf = buildPdf(trailers.map((trailer, index) => ({ xref, objects: [{ number: index + 1, body: '<<>>' }], trailer })));
  const context = { warn: ignore, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 };
  return readSectionChain(new ByteSource(pdf.bytes), { startxref: pdf.sections.at(-1) ?? 0, shift: 0 }, context);
};

const refuse = (chain: SectionChain): string => {
  refuseEncryption(searchOrder(chain).map(section => section.trailer));
  return 'not encrypted';
};

describe('encryption detection', () => {
  it('refuses an Encrypt entry in the newest trailer, an older trailer or a cross-reference stream', () => {
    expect(() => refuse(chainOf(['/Root 1 0 R/Encrypt 9 0 R']))).toThrow(EncryptedDocumentError);
    expect(() => refuse(chainOf(['/Root 1 0 R/Encrypt 9 0 R', '/Root 1 0 R']))).toThrow(EncryptedDocumentError);
    expect(() => refuse(chainOf(['/Root 1 0 R/Encrypt<</Filter/Standard>>'], 'stream'))).toThrow(EncryptedDocumentError);
  });

  it('treats a missing or null Encrypt entry as not encrypted', () => {
    expect(refuse(chainOf(['/Root 1 0 R', '/Root 1 0 R/Encrypt null']))).toBe('not encrypted');
  });
});
