import type { SectionChain } from './sectionChain.ts';

import { describe, expect, it } from 'vitest';

import { EncryptedDocumentError } from '../error/encryptedDocumentError.ts';
import { ByteSource } from '../parse/byteSource.ts';
import { buildPdf, latin1Bytes } from '../testing/pdfBuilder.ts';

import { refuseEncryption } from './encryption.ts';
import { readSectionChain, searchOrder } from './sectionChain.ts';

const ignore = (): void => {
  // Warnings are not under test here.
};

const chainOf = (trailers: ReadonlyArray<string>, xref: 'classic' | 'stream' = 'classic'): SectionChain => {
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

  it('refuses an Encrypt entry that only the XRefStm stream of a hybrid section holds', () => {
    const pdf = buildPdf([
      { xref: 'classic', objects: [{ number: 1, body: '<<>>' }], trailer: '/Root 1 0 R' },
      { xref: 'hybrid', objects: [], objectStreams: [{ number: 4, members: [{ number: 3, body: '(member)' }] }], trailer: '/Root 1 0 R' },
    ]);
    const chain = (text: string): SectionChain => {
      const source = new ByteSource(latin1Bytes(text));
      // The entry moves the classic table 14 bytes on, which the startxref correction allows; every offset the file gives lies before it.
      return readSectionChain(
        source,
        { startxref: pdf.sections.at(-1) ?? 0, shift: 0 },
        { warn: ignore, names: new Map(), maxNesting: 256, maxDecodedBytes: 1_048_576 },
      );
    };
    const encrypted = pdf.text.replace('/Type/XRef/Size', '/Type/XRef/Encrypt 9 0 R/Size');
    expect(refuse(chain(pdf.text))).toBe('not encrypted');
    expect(() => refuse(chain(encrypted))).toThrow(EncryptedDocumentError);
  });

  it('treats a missing or null Encrypt entry as not encrypted', () => {
    expect(refuse(chainOf(['/Root 1 0 R', '/Root 1 0 R/Encrypt null']))).toBe('not encrypted');
  });
});
