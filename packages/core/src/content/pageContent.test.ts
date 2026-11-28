import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { PageContent } from './pageContent.ts';

import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { latin1Bytes, streamBody } from '../testing/pdfBuilder.ts';
import { textPdfBytes } from '../testing/textPdf.ts';

import { pageContent } from './pageContent.ts';

const stream = (number: number, data: string, dictionary = ''): TestObject => ({ number, body: streamBody(dictionary, data) });

// The default limit of loadDocument.
const DEFAULT_MAX_DECODED_BYTES = 16 * 1024 * 1024;

const documentWith = (entries: string, objects: ReadonlyArray<TestObject>, maxDecodedBytes: number): DocumentInternals => {
  const parts = internalsOf(loadDocument(textPdfBytes({ pages: [{ entries }], objects }), { maxDecodedBytes }));
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

const contentOf = (entries: string, objects: ReadonlyArray<TestObject> = [], maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES): PageContent => {
  const document = documentWith(entries, objects, maxDecodedBytes);
  const [page] = document.pages;
  if (page === undefined) {
    throw new Error('the document has no page');
  }
  return pageContent(document, page);
};

const STREAMS = [stream(111, '0 g'), stream(112, '1 g')];

describe('page content', () => {
  it('reads a single stream and the streams of an array, in order', () => {
    expect([contentOf('/Contents 111 0 R', STREAMS), contentOf('/Contents[112 0 R 111 0 R]', STREAMS)]).toStrictEqual([
      { streams: [latin1Bytes('0 g')], indexes: [0], problems: [] },
      { streams: [latin1Bytes('1 g'), latin1Bytes('0 g')], indexes: [0, 1], problems: [] },
    ]);
  });

  it('reads Contents that is a reference to an array', () => {
    expect(contentOf('/Contents 120 0 R', [...STREAMS, { number: 120, body: '[111 0 R 112 0 R]' }])).toStrictEqual({
      streams: [latin1Bytes('0 g'), latin1Bytes('1 g')],
      indexes: [0, 1],
      problems: [],
    });
  });

  it('gives nothing for a page without Contents', () => {
    expect(contentOf('')).toStrictEqual({ streams: [], indexes: [], problems: [] });
  });

  it('skips null and references to missing objects without a problem, keeping the indexes of the streams it reads', () => {
    // ISO 32000-1:2008, 7.3.10: "An indirect reference to an undefined object shall not be considered an error by a conforming reader; it shall be treated as a reference to the null object."
    expect(contentOf('/Contents[null 199 0 R 111 0 R]', STREAMS)).toStrictEqual({ streams: [latin1Bytes('0 g')], indexes: [2], problems: [] });
  });

  it.each([
    ['is not a stream', { number: 110, body: '<</A 1>>' }],
    ['has a filter that is not supported', stream(110, '0 g', '/Filter/NoSuchFilter')],
  ])('reports an item of Contents that %s and reads the others', (_, item) => {
    const { streams, indexes, problems } = contentOf('/Contents[110 0 R 112 0 R]', [...STREAMS, item]);
    expect([streams, indexes, problems]).toStrictEqual([[latin1Bytes('1 g')], [1], [expect.stringMatching(/^content stream 0 /u)]]);
  });

  it('reports Contents that cannot be parsed without throwing', () => {
    const { streams, problems } = contentOf('/Contents 120 0 R', [{ number: 120, body: '<</A (unterminated' }]);
    expect([streams, problems]).toStrictEqual([[], [expect.stringMatching(/\bContents\b/u)]]);
  });

  it('reads streams that together decode to maxDecodedBytes and refuses one byte more', () => {
    // '0 g' and '1 g' decode to 3 bytes each.
    expect(contentOf('/Contents[111 0 R 112 0 R]', STREAMS, 6).indexes).toStrictEqual([0, 1]);
    expect(() => contentOf('/Contents[111 0 R 112 0 R]', STREAMS, 5)).toThrow(ResourceLimitError);
  });
});
