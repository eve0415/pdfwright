import type { ProcedureSummary } from './type3Procedures.ts';

import { describe, expect, it } from 'vitest';

import { streamBody } from '../testing/pdfBuilder.ts';

import { objectIn } from './testing/fontDocument.ts';
import { readProcedure } from './type3Procedures.ts';

// The summary of a glyph procedure written as the stream object 10.
const summaryOf = (dictionary: string, content: string): ProcedureSummary => {
  const { document, object } = objectIn(streamBody(dictionary, content));
  if (object.kind !== 'stream') {
    throw new Error('object 10 is not a stream');
  }
  return readProcedure(document, object);
};

describe('Type 3 glyph procedures', () => {
  it.each([
    { label: 'a d1 that paints', content: '500 0 0 0 750 750 d1 0 0 750 750 re f', summary: { paints: true, box: [0, 0, 750, 750] } },
    { label: 'a d1 with its corners reversed', content: '500 0 750 750 0 0 d1 0 0 m 1 1 l n', summary: { paints: false, box: [0, 0, 750, 750] } },
    { label: 'a d1 with five operands', content: '0 0 0 750 750 d1 0 0 m 1 1 l n', summary: { paints: false, box: undefined } },
    { label: 'a d1 that is not the first operator', content: 'q 500 0 0 0 750 750 d1 Q', summary: { paints: false, box: undefined } },
    { label: 'a path ended by n', content: '100 0 d0 0 0 m 1 1 l n', summary: { paints: false, box: undefined } },
    { label: 'a shading', content: '100 0 d0 /Sh0 sh', summary: { paints: true, box: undefined } },
    { label: 'an XObject', content: '100 0 d0 /Im0 Do', summary: { paints: true, box: undefined } },
    { label: 'an inline image', content: '100 0 d0 BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI', summary: { paints: true, box: undefined } },
    { label: 'a TJ array', content: '100 0 d0 [(a)] TJ', summary: { paints: true, box: undefined } },
    { label: "a ' string", content: "100 0 d0 (a) '", summary: { paints: true, box: undefined } },
    { label: 'bytes that cannot be lexed after its d1', content: '500 0 0 0 750 750 d1 <zz>', summary: { paints: undefined, box: [0, 0, 750, 750] } },
  ])('reads a procedure with $label', ({ content, summary }) => {
    // ISO 32000-1:2008, 9.6.5 and Table 113: d1's operands are "wx wy llx lly urx ury", and it is the procedure's first operator.
    expect(summaryOf('', content)).toStrictEqual(summary);
  });

  it('reads a procedure that cannot be decoded as of unknown paint and box', () => {
    expect(summaryOf('/Filter/Foo', '500 0 0 0 750 750 d1 0 0 750 750 re f')).toStrictEqual({ paints: undefined, box: undefined });
  });
});
