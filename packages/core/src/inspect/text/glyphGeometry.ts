import type { Quad } from '../../content/clip.ts';
import type { GraphicsState } from '../../content/interpreter.ts';
import type { Matrix } from '../../content/matrix.ts';
import type { FontGlyph, FontModel } from '../../font/fontModel.ts';

import { glyphDisplacement } from '../../content/interpreter.ts';
import { multiply, transformPoint } from '../../content/matrix.ts';

/** Where a glyph is painted, in the page's default user space. */
export interface GlyphGeometry {
  readonly origin: readonly [number, number];
  readonly advance: readonly [number, number];
  readonly quad: Quad;
  readonly fontSize: number;
  readonly extentEstimated: boolean;
}

/**
 * The text rendering matrix of ISO 32000-1:2008, 9.4.4: Trm = [Tfs×Th 0 0 Tfs 0 Trise] × Tm × CTM, mapping text space to the page's default user space.
 */
export const textRenderingMatrix = (state: GraphicsState, textMatrix: Matrix): Matrix =>
  multiply([state.fontSize * state.horizontalScaling, 0, 0, state.fontSize, 0, state.rise], multiply(textMatrix, state.ctm));

// The linear part of a matrix applied to a vector.
const transformVector = ([a, b, c, d]: Matrix, x: number, y: number): readonly [number, number] => [a * x + c * y, b * x + d * y];

// A glyph-space vertical extent in text space: its two edges transformed by the font's glyph matrix and put in order there, since a FontMatrix may flip the y axis.
const textExtent = (font: FontModel): readonly [number, number] => {
  const { descent, ascent } = font.verticalExtent;
  const low = transformPoint(font.glyphMatrix, 0, descent)[1] - transformPoint(font.glyphMatrix, 0, 0)[1];
  const high = transformPoint(font.glyphMatrix, 0, ascent)[1] - transformPoint(font.glyphMatrix, 0, 0)[1];
  return [Math.min(low, high), Math.max(low, high)];
};

const quadOf = (matrix: Matrix, corners: readonly (readonly [number, number])[]): Quad => {
  const [p0 = [0, 0], p1 = [0, 0], p2 = [0, 0], p3 = [0, 0]] = corners.map(([x, y]) => transformPoint(matrix, x, y));
  return [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]];
};

/**
 * The advance box of a glyph shown with the text matrix `textMatrix` (ISO 32000-1:2008, 9.4.4), or of a string that could not be split when `glyph` is undefined, which then has no width.
 * In horizontal writing the glyph's origin is text-space (0, 0) and its box spans the width w0 and the font's descent to ascent; `advance` is the glyph's own displacement, without the TJ numbers after it, transformed by Tm × CTM.
 */
export const glyphGeometry = (
  font: FontModel,
  glyph: FontGlyph | undefined,
  { state, textMatrix }: { state: GraphicsState; textMatrix: Matrix },
): GlyphGeometry => {
  const trm = textRenderingMatrix(state, textMatrix);
  const width = glyph?.width ?? 0;
  const [descent, ascent] = textExtent(font);
  const displacement = glyph === undefined ? undefined : glyphDisplacement(glyph, 0, state);
  const [dx, dy] = displacement ?? [0, 0];
  return {
    origin: transformPoint(trm, 0, 0),
    advance: transformVector(multiply(textMatrix, state.ctm), dx, dy),
    quad: quadOf(trm, [
      [0, descent],
      [width, descent],
      [width, ascent],
      [0, ascent],
    ]),
    fontSize: Math.hypot(trm[2], trm[3]),
    extentEstimated: font.verticalExtent.estimated,
  };
};
