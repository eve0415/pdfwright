import type { TestObject } from '../testing/pdfBuilder.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { signatureProtection } from './signatures.ts';

const protection = (catalog: string, objects: readonly TestObject[] = []): string | undefined => {
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
  it('finds the AppendOnly flag of the interactive form and a permissions dictionary', () => {
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
    ]).toStrictEqual([undefined, undefined, 'append-only', 'append-only', 'permissions', undefined]);
  });
});
