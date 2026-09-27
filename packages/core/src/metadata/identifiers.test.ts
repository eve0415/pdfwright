import type { ObjectChange } from '../document/editedObjects.ts';

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { md5 } from '../hash/md5.ts';
import { pdfInteger, pdfLiteralString } from '../object/pdfObject.ts';

import { changesDigest, deriveInstanceId, formatUuid, resolveDocumentId } from './identifiers.ts';

const bytes = (length: number, first = 0): Uint8Array => Uint8Array.from({ length }, (_, index) => first + index);

const hex = (data: Uint8Array): string => [...data].map(byte => byte.toString(16).padStart(2, '0')).join('');

const digestOf = (entries: readonly (readonly [number, ObjectChange])[]): string => hex(changesDigest(new Map(entries), new Set([9])));

const set = (value: number): ObjectChange => ({ generation: 0, value: pdfInteger(value) });

describe('identifiers in XMP', () => {
  it('formats 16 bytes as a uuid: GUID in lowercase 8-4-4-4-12 groups', () => {
    expect(formatUuid(bytes(16, 0xa0))).toBe('uuid:a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf');
  });

  it('keeps an existing DocumentID, else takes the first file identifier, else a supplied value', () => {
    const sixteen = bytes(16);
    const other = bytes(20);
    expect([
      resolveDocumentId({ existing: 'xmp.did:1', fileIdentifier: sixteen, supplied: undefined }),
      resolveDocumentId({ existing: 'xmp.did:1', fileIdentifier: sixteen, supplied: 'uuid:given' }),
      resolveDocumentId({ existing: undefined, fileIdentifier: sixteen, supplied: undefined }),
      resolveDocumentId({ existing: undefined, fileIdentifier: other, supplied: undefined }),
      resolveDocumentId({ existing: '', fileIdentifier: undefined, supplied: 'uuid:given' }),
    ]).toStrictEqual(['xmp.did:1', 'uuid:given', formatUuid(sixteen), formatUuid(md5(other)), 'uuid:given']);
  });

  it('requires a DocumentID when there is neither a packet value nor a file identifier', () => {
    expect(() => resolveDocumentId({ existing: undefined, fileIdentifier: undefined, supplied: undefined })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'document-id-required' }),
    );
  });

  it('digests changed, new and deleted objects in object-number order, leaving out the excluded ones', () => {
    const deleted: ObjectChange = { generation: 1, deleted: true };
    const base = digestOf([
      [2, set(1)],
      [5, deleted],
    ]);
    expect([
      digestOf([
        [5, deleted],
        [2, set(1)],
        [9, set(7)],
      ]),
      digestOf([
        [2, set(2)],
        [5, deleted],
      ]),
      digestOf([[2, set(1)]]),
      digestOf([
        [2, { generation: 0, value: pdfLiteralString('1') }],
        [5, deleted],
      ]),
    ]).toStrictEqual([base, expect.not.stringMatching(base), expect.not.stringMatching(base), expect.not.stringMatching(base)]);
  });

  it('derives an InstanceID that changes with every input', () => {
    const input = { documentId: 'uuid:d', metadataDate: '2024-01-01T00:00:00Z', previous: 'uuid:p', changes: bytes(16) };
    const derived = deriveInstanceId(input);
    expect([
      /^uuid:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(derived),
      deriveInstanceId({ ...input }) === derived,
      deriveInstanceId({ ...input, documentId: 'uuid:e' }) === derived,
      deriveInstanceId({ ...input, metadataDate: '2024-01-01T00:00:01Z' }) === derived,
      deriveInstanceId({ ...input, previous: undefined }) === derived,
      deriveInstanceId({ ...input, changes: bytes(16, 1) }) === derived,
    ]).toStrictEqual([true, true, false, false, false, false]);
  });
});
