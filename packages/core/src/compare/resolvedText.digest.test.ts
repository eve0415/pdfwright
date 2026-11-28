import type { DocumentInternals } from '../document/documentInternals.ts';

import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { md5 } from '../hash/md5.ts';
import { pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { ResolvedTexts } from './resolvedText.ts';

vi.mock(import('../hash/md5.ts'), { spy: true });

// A string long enough that every text holding it is kept by its digest, written in hexadecimal as the text of a string is.
const LONG = 'ab'.repeat(500);

const internalsOrThrow = (body: string): DocumentInternals => {
  const internals = internalsOf(
    loadDocument(
      buildPdf([
        {
          xref: 'classic',
          objects: [
            { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
            { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]>>' },
            { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
            { number: 20, body },
          ],
          trailer: '/Root 1 0 R',
        },
      ]).bytes,
    ),
  );
  if (internals === undefined) {
    throw new Error('the document has no internals');
  }
  return internals;
};

describe('digests of values that lead into a reference cycle', () => {
  it.each([
    { order: 'after', body: (nest: string): string => `[20 0 R ${nest}]` },
    { order: 'before', body: (nest: string): string => `[${nest} 20 0 R]` },
  ])('hashes a long value nested in arrays that lead into no cycle once, however deep, when it comes $order the link into the cycle', ({ body }) => {
    const longHashes = (depth: number): number => {
      const internals = internalsOrThrow(body(`${'['.repeat(depth)}(${LONG})${']'.repeat(depth)}`));
      vi.mocked(md5).mockClear();
      new ResolvedTexts(internals).text(pdfReference(20, 0));
      return vi.mocked(md5).mock.calls.filter(([bytes]) => bytes.length >= LONG.length * 2).length;
    };
    expect([longHashes(1), longHashes(64)]).toStrictEqual([1, 1]);
  });
});
