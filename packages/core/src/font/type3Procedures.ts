import type { Rectangle } from './fontModel.ts';
import type { FontSource, PdfStream } from './fontValues.ts';

import { readContent } from '../content/contentOperations.ts';
import { ParseError } from '../error/parseError.ts';

import { decodedData, numberOf } from './fontValues.ts';

// ISO 32000-1:2008, 8.5.3.1, Table 60 path-painting operators other than n, which ends a path without painting it; sh (8.7.4.2); the text-showing operators of Table 109; Do, which paints an XObject; and BI, an inline image (8.9.7).
const PAINTING = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh', 'Tj', 'TJ', "'", '"', 'Do', 'BI']);

/** What a Type 3 glyph procedure shows: whether it paints (undefined when it cannot be read), and the bounding box its d1 operator gives. */
export interface ProcedureSummary {
  readonly paints: boolean | undefined;
  readonly box: Rectangle | undefined;
}

/** A rectangle with its corners ordered, as ISO 32000-1:2008, 7.9.5 lets readers normalise any pair of diagonally opposite corners. */
export const normalised = ([x1, y1, x2, y2]: readonly [number, number, number, number]): Rectangle => [
  Math.min(x1, x2),
  Math.min(y1, y2),
  Math.max(x1, x2),
  Math.max(y1, y2),
];

/**
 * Reads a Type 3 glyph procedure. ISO 32000-1:2008, 9.6.5: its first operator is d0 or d1, and Table 113 gives d1's operands as "wx wy llx lly urx ury", the glyph's bounding box.
 * The procedure paints when it contains a painting, text-showing, Do or inline-image operator.
 */
export const readProcedure = (source: FontSource, procedure: PdfStream): ProcedureSummary => {
  const data = decodedData(source, procedure);
  if (typeof data === 'string') return { paints: undefined, box: undefined };
  let box: Rectangle | undefined = undefined;
  let first = true;
  try {
    for (const { operator, operands } of readContent(data, source.maxNesting)) {
      if (first && operator === 'd1') {
        const numbers = operands.slice(-4).map(operand => (operand.kind === 'stray-delimiter' ? undefined : numberOf(operand)));
        const [llx, lly, urx, ury] = numbers;
        if (operands.length >= 6 && llx !== undefined && lly !== undefined && urx !== undefined && ury !== undefined) box = normalised([llx, lly, urx, ury]);
      }
      first = false;
      if (PAINTING.has(operator)) return { paints: true, box };
    }
  } catch (error) {
    if (error instanceof ParseError) return { paints: undefined, box };
    throw error;
  }
  return { paints: false, box };
};
