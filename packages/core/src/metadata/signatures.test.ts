import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { signatureProtection } from './signatures.ts';

const protection = (catalog: string, objects: ReadonlyArray<TestObject> = []): string | undefined => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` }, { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' }, ...objects],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const internals = internalsOf(document);
  return internals === undefined ? 'no internals' : signatureProtection(internals);
};

describe('signature protection', () => {
  it('finds the SignaturesExist and AppendOnly flags of the interactive form and a permissions dictionary', () => {
    expect([
      protection(''),
      protection('/AcroForm<</Fields[]/SigFlags 1>>'),
      protection('/AcroForm<</Fields[]/SigFlags 3>>'),
      protection('/AcroForm 3 0 R', [
        { number: 3, body: '<</Fields[]/SigFlags 4 0 R>>' },
        { number: 4, body: '2' },
      ]),
      protection('/Perms<</DocMDP 3 0 R>>', [{ number: 3, body: '<<>>' }]),
      protection('/AcroForm<</SigFlags 2.0>>'),
    ]).toStrictEqual([undefined, 'signatures-exist', 'append-only', 'append-only', 'permissions', 'append-only']);
  });

  it('treats flags it cannot read as an integer as protection', () => {
    expect([
      protection('/AcroForm<</SigFlags 2.5>>'),
      protection('/AcroForm<</SigFlags(2)>>'),
      protection('/AcroForm<</SigFlags 3 0 R>>', [{ number: 3, body: '<</Not(an integer)>>' }]),
      protection('/AcroForm<</SigFlags 0.0>>'),
      protection('/AcroForm<</SigFlags null>>'),
    ]).toStrictEqual(['unreadable-flags', 'unreadable-flags', 'unreadable-flags', undefined, undefined]);
  });

  // ISO 32000-1:2008, Table 219 numbers bits from 1 for the low-order bit; no other bit is defined.
  it.each([
    ['only an undefined bit', '/AcroForm<</SigFlags 4>>', undefined],
    ['an undefined bit beside SignaturesExist', '/AcroForm<</SigFlags 5>>', 'signatures-exist'],
    ['an undefined bit beside AppendOnly', '/AcroForm<</SigFlags 6>>', 'append-only'],
  ])('reads SigFlags with %s', (_name, catalog, expected) => {
    expect(protection(catalog)).toBe(expected);
  });

  it('finds a populated signature field without SigFlags', () => {
    const field = { number: 3, body: '<</FT/Sig/V<</Type/Sig/ByteRange[0 10 20 10]/Contents<00>>>>>' };
    expect(protection('/AcroForm<</Fields[3 0 R]>>', [field])).toBe('signatures-exist');
  });

  // ISO 32000-1:2008, 12.7.3.1, Table 220: FT is inheritable; 12.7.4.5 makes V of a signature field its signature dictionary.
  it.each([
    ['an unsigned signature field', [{ number: 3, body: '<</FT/Sig>>' }], undefined],
    ['a signature field whose value is null', [{ number: 3, body: '<</FT/Sig/V null>>' }], undefined],
    // ISO 32000-1:2008, 7.3.10: a reference to an object that does not exist is the null object.
    ['a signature field whose value refers to a missing object', [{ number: 3, body: '<</FT/Sig/V 5 0 R>>' }], undefined],
    ['a text field with a value', [{ number: 3, body: '<</FT/Tx/V(signed)>>' }], undefined],
    [
      'a kid that inherits FT Sig from its parent',
      [
        { number: 3, body: '<</FT/Sig/Kids[4 0 R]>>' },
        { number: 4, body: '<</V<</Type/Sig>>>>' },
      ],
      'signatures-exist',
    ],
    [
      'a kid that overrides an inherited FT Sig',
      [
        { number: 3, body: '<</FT/Sig/Kids[4 0 R]>>' },
        { number: 4, body: '<</FT/Tx/V(text)>>' },
      ],
      undefined,
    ],
    ['a field that lists itself as a kid', [{ number: 3, body: '<</FT/Sig/Kids[3 0 R]>>' }], undefined],
    ['a field whose bytes do not parse', [{ number: 3, body: '<</FT/Sig/V' }], 'signatures-exist'],
  ])('reads the fields of %s', (_name, objects, expected) => {
    expect(protection('/AcroForm<</Fields[3 0 R]>>', objects)).toBe(expected);
  });

  it('does not take a permissions entry that does not parse as protection', () => {
    expect(protection('/Perms 3 0 R', [{ number: 3, body: '<</DocMDP' }])).toBeUndefined();
  });
});
