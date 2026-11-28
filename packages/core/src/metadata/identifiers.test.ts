import type { ObjectChange } from '../document/editedObjects.ts';
import type { PdfObject } from '../object/pdfObject.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../error/validationError.ts';
import { md5 } from '../hash/md5.ts';
import { pdfInteger, pdfLiteralString } from '../object/pdfObject.ts';
import { serializeObject } from '../serialize/serializeObject.ts';

import { changesDigest, deriveInstanceId, formatUuid, resolveDocumentId } from './identifiers.ts';

const bytes = (length: number, first = 0): Uint8Array => Uint8Array.from({ length }, (_, index) => first + index);

const hex = (data: Uint8Array): string => [...data].map(byte => byte.toString(16).padStart(2, '0')).join('');

const serialized = ({ value }: { readonly value: PdfObject }): Uint8Array => serializeObject(value, { fractionDigits: 5 });

const digestOf = (entries: ReadonlyArray<readonly [number, ObjectChange]>): string => hex(changesDigest(new Map(entries), new Set([9]), serialized));

const set = (value: number): ObjectChange => ({ generation: 0, value: pdfInteger(value) });

describe('identifiers in XMP', () => {
  it('formats 16 bytes as a uuid: GUID in lowercase 8-4-4-4-12 groups', () => {
    expect(formatUuid(bytes(16, 0xa0))).toBe('uuid:a0a1a2a3-a4a5-a6a7-a8a9-aaabacadaeaf');
  });

  it('uses a supplied DocumentID, else a non-empty existing one, else the first file identifier', () => {
    const sixteen = bytes(16);
    const other = bytes(20);
    expect([
      resolveDocumentId({ existing: 'xmp.did:1', fileIdentifier: sixteen, supplied: undefined }),
      resolveDocumentId({ existing: 'xmp.did:1', fileIdentifier: sixteen, supplied: 'uuid:given' }),
      resolveDocumentId({ existing: undefined, fileIdentifier: sixteen, supplied: undefined }),
      resolveDocumentId({ existing: undefined, fileIdentifier: other, supplied: undefined }),
      resolveDocumentId({ existing: '', fileIdentifier: sixteen, supplied: undefined }),
    ]).toStrictEqual(['xmp.did:1', 'uuid:given', formatUuid(sixteen), formatUuid(md5(other)), formatUuid(sixteen)]);
  });

  // ISO 32000-1:2008, 14.4 gives the first file identifier no fixed length, so only exactly 16 bytes are used as they are.
  it.each([[0], [15], [17]])('derives the DocumentID from the MD5 of a %i-byte file identifier', length => {
    const id = bytes(length, 0x30);
    expect(resolveDocumentId({ existing: undefined, fileIdentifier: id, supplied: undefined })).toBe(formatUuid(md5(id)));
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

  it.each([
    ['object number of a set object', [[2, set(1)]], [[3, set(1)]]],
    ['generation of a set object', [[2, set(1)]], [[2, { generation: 1, value: pdfInteger(1) }]]],
    ['object number of a deleted object', [[2, { generation: 1, deleted: true }]], [[3, { generation: 1, deleted: true }]]],
    ['generation of a deleted object', [[2, { generation: 1, deleted: true }]], [[2, { generation: 2, deleted: true }]]],
  ] satisfies Array<[string, Array<[number, ObjectChange]>, Array<[number, ObjectChange]>]>)('digests a change of the %s differently', (_name, left, right) => {
    expect(digestOf(left)).not.toBe(digestOf(right));
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

describe('properties', () => {
  const change = fc.oneof(
    fc.record({ generation: fc.integer({ min: 0, max: 65_535 }), value: fc.integer({ min: -1000, max: 1000 }).map(pdfInteger) }),
    fc.record({ generation: fc.integer({ min: 0, max: 65_535 }), deleted: fc.constant(true) }),
  );
  const changes = fc.uniqueArray(fc.tuple(fc.integer({ min: 1, max: 40 }), change), { selector: ([objectNumber]) => objectNumber, maxLength: 8 });

  it('digests the same changes the same in any insertion order', () => {
    fc.assert(
      fc.property(changes, fc.func(fc.integer()), (entries, order) => {
        const shuffled = entries.toSorted((left, right) => order(left[0]) - order(right[0]) || left[0] - right[0]);
        expect(digestOf(shuffled)).toBe(digestOf(entries));
      }),
    );
  });

  // Generated object numbers stop at 40, so 41 is never taken.
  const freeNumber = 41;

  const editChange = (kind: 'number' | 'generation' | 'value' | 'deletion', objectNumber: number, original: ObjectChange): [number, ObjectChange] => {
    switch (kind) {
      case 'number': {
        return [freeNumber, original];
      }
      case 'generation': {
        return [objectNumber, { ...original, generation: original.generation + 1 }];
      }
      case 'value': {
        return 'deleted' in original
          ? [objectNumber, original]
          : [objectNumber, { generation: original.generation, value: pdfInteger(original.value.kind === 'integer' ? original.value.value + 1 : 0) }];
      }
      case 'deletion': {
        return [
          objectNumber,
          'deleted' in original ? { generation: original.generation, value: pdfInteger(0) } : { generation: original.generation, deleted: true },
        ];
      }
    }
  };

  it('digests differently when an included object gains another number, generation or value, or is deleted or restored', () => {
    fc.assert(
      fc.property(
        changes.filter(entries => entries.some(([objectNumber, change]) => objectNumber !== 9 && !('deleted' in change))),
        fc.nat(),
        fc.constantFrom('number', 'generation', 'value', 'deletion'),
        (entries, pick, kind) => {
          // A deleted object has no value to change, so the edit picks among the included objects that have one when it changes a value.
          const candidates = entries.filter(([objectNumber, change]) => objectNumber !== 9 && (kind !== 'value' || !('deleted' in change)));
          const [objectNumber, original] = candidates[pick % candidates.length] ?? [1, set(0)];
          const replacement = editChange(kind, objectNumber, original);
          const edited = entries.map((entry): [number, ObjectChange] => (entry[0] === objectNumber ? replacement : entry));
          expect(digestOf(edited)).not.toBe(digestOf(entries));
        },
      ),
    );
  });

  it('formats any 16 bytes as a uuid: GUID that spells out every byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), value => {
        const formatted = formatUuid(value);
        expect(formatted).toMatch(/^uuid:[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u);
        expect(formatted.slice('uuid:'.length).replaceAll('-', '')).toBe(hex(value));
      }),
    );
  });
});
