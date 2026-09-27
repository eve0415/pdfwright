import type { Quad } from '../../content/clip.ts';
import type { GraphicsState } from '../../content/interpreter.ts';
import type { Matrix } from '../../content/matrix.ts';
import type { FontGlyph, FontModel, Rectangle } from '../../font/fontModel.ts';

import { glyphDisplacement } from '../../content/interpreter.ts';
import { multiply, transformPoint } from '../../content/matrix.ts';

/** Where a glyph is painted, in the page's default user space. */
export interface GlyphGeometry {
  readonly origin: readonly [number, number];
  readonly advance: readonly [number, number];
  readonly quad: Quad;
  /** The core box, in the quad's corner order: in horizontal writing the advance box from 0.12 em below the baseline to 0.88 em above it, within the font's extent; in vertical writing one em across the column, centred on the glyph, and its vertical advance. */
  readonly core: Quad;
  /** The core box inset by CORE_BOX_TOLERANCE on every side, or to its centre line where it is narrower than twice that: what a cut must reach to count. */
  readonly coreInner: Quad;
  readonly fontSize: number;
  /** Whether the glyph cannot be seen for its size: the em square, one unit of text space, maps to the page with an absolute determinant below 10⁻⁶ or narrower than 0.5 in its thinnest direction. */
  readonly degenerate: boolean;
  readonly extentEstimated: boolean;
}

// Below these a glyph cannot be seen: a matrix that flattens it, or an em square under half a unit of default user space.
const DEGENERATE_DETERMINANT = 1e-6;
const SMALLEST_EM = 0.5;

// Whether the unit square of text space, the em square whatever the font's glyph matrix (ISO 32000-1:2008, 9.2.4: "for a Type 3 font, the transformation from glyph space to text space shall be defined by a font matrix"), mapped by Trm, flattens to nothing or to less than half a unit across in the thinnest direction: the smallest singular value of the linear part is its determinant over the largest.
const degenerate = ([p, q, r, t]: Matrix): boolean => {
  const determinant = Math.abs(p * t - q * r);
  const sum = p * p + q * q + r * r + t * t;
  const largest = Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * determinant * determinant))) / 2);
  return determinant < DEGENERATE_DETERMINANT || largest === 0 || determinant / largest < SMALLEST_EM;
};

/**
 * The text rendering matrix of ISO 32000-1:2008, 9.4.4: Trm = [Tfs×Th 0 0 Tfs 0 Trise] × Tm × CTM, mapping text space to the page's default user space.
 */
export const textRenderingMatrix = (state: GraphicsState, textMatrix: Matrix): Matrix =>
  multiply([state.fontSize * state.horizontalScaling, 0, 0, state.fontSize, 0, state.rise], multiply(textMatrix, state.ctm));

// The linear part of a matrix applied to a vector.
const transformVector = ([a, b, c, d]: Matrix, x: number, y: number): readonly [number, number] => [a * x + c * y, b * x + d * y];

// The y range of glyph-space corners in text space: transformed by the font's glyph matrix and put in order there, since a FontMatrix may flip the y axis or rotate.
const textRange = (font: FontModel, corners: readonly (readonly [number, number])[]): readonly [number, number] => {
  const ys = corners.map(([x, y]) => transformPoint(font.glyphMatrix, x, y)[1]);
  return [Math.min(...ys), Math.max(...ys)];
};

const hasArea = ([left, bottom, right, top]: Rectangle): boolean => right > left && top > bottom;

/**
 * The vertical extent of a horizontal glyph's box in text space, and whether it is the default guess.
 * A Type 3 glyph takes its d1 bounding box (ISO 32000-1:2008, 9.6.5, Table 113), else the font's FontBBox (Table 112), both in glyph space; a d1 box without area, which Chromium writes for spaces, is not used. Other glyphs take the font's descent and ascent.
 */
interface TextExtent {
  readonly range: readonly [number, number];
  readonly estimated: boolean;
}

const textExtent = (font: FontModel, glyph: FontGlyph | undefined): TextExtent => {
  const box = glyph?.type3Box !== undefined && hasArea(glyph.type3Box) ? glyph.type3Box : font.type3?.fontBBox;
  if (box !== undefined) {
    const [left, bottom, right, top] = box;
    const corners = [
      [left, bottom],
      [right, bottom],
      [right, top],
      [left, top],
    ] as const;
    return { range: textRange(font, corners), estimated: false };
  }
  const { descent, ascent, estimated } = font.verticalExtent;
  return {
    range: textRange(font, [
      [0, descent],
      [0, ascent],
    ]),
    estimated,
  };
};

const quadOf = (matrix: Matrix, corners: readonly (readonly [number, number])[]): Quad => {
  const [p0 = [0, 0], p1 = [0, 0], p2 = [0, 0], p3 = [0, 0]] = corners.map(([x, y]) => transformPoint(matrix, x, y));
  return [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]];
};

// The advance box in text space, corners in the order the quad reports them, its core box, and the displacement the glyph moves the text position by.
interface TextBox {
  readonly corners: readonly (readonly [number, number])[];
  readonly core: TextRectangle;
  readonly displacement: readonly [number, number] | undefined;
  readonly estimated: boolean;
}

// The ideographic em box of a horizontal glyph in text space, where the em is one unit: from 0.12 below the baseline to 0.88 above it.
const EM_BOTTOM = -0.12;
const EM_TOP = 0.88;

/** [left bottom right top] in text space. */
type TextRectangle = readonly [number, number, number, number];

/**
 * How deep, in ems, a clip or cover must cut into a glyph's core box from any side before the glyph counts as partly hidden.
 * Chromium's page-margin clip cuts 0.02 to 0.04 em into the core boxes of correct proofs (the first line of IPAGothic text at 0.84 to 0.86 em above the baseline, and the column side of full-width glyphs set vertically), while a CSS overflow clip or a covering box that shows half a character cuts 0.5 em or more.
 */
export const CORE_BOX_TOLERANCE = 0.1;

// The box shrunk by CORE_BOX_TOLERANCE on every side, each axis to its middle where the box is narrower than twice the tolerance.
const inset = ([left, bottom, right, top]: TextRectangle): TextRectangle => {
  const [low, high] = [Math.min(left, right), Math.max(left, right)];
  const [under, over] = [Math.min(bottom, top), Math.max(bottom, top)];
  const [x0, x1] = high - low > 2 * CORE_BOX_TOLERANCE ? [low + CORE_BOX_TOLERANCE, high - CORE_BOX_TOLERANCE] : [(low + high) / 2, (low + high) / 2];
  const [y0, y1] = over - under > 2 * CORE_BOX_TOLERANCE ? [under + CORE_BOX_TOLERANCE, over - CORE_BOX_TOLERANCE] : [(under + over) / 2, (under + over) / 2];
  return [x0, y0, x1, y1];
};

// The corners of a box from left to right and bottom to top, in the order the quad reports them.
const cornersOf = ([left, bottom, right, top]: TextRectangle): readonly (readonly [number, number])[] => [
  [left, bottom],
  [right, bottom],
  [right, top],
  [left, top],
];

// Horizontal writing: the glyph's origin is text-space (0, 0) and its box spans the width w0 and the font's descent to ascent; the core box keeps the part of that extent inside the em box, or the whole extent when none is.
const horizontalBox = (font: FontModel, glyph: FontGlyph | undefined, state: GraphicsState): TextBox => {
  const width = glyph?.width ?? 0;
  const { range, estimated } = textExtent(font, glyph);
  const [descent, ascent] = range;
  const [bottom, top] = [Math.max(descent, EM_BOTTOM), Math.min(ascent, EM_TOP)];
  return {
    corners: cornersOf([0, descent, width, ascent]),
    core: bottom < top ? [0, bottom, width, top] : [0, descent, width, ascent],
    displacement: glyph === undefined ? undefined : glyphDisplacement(glyph, 0, state),
    estimated,
  };
};

// ISO 32000-1:2008, 9.2.4: "In vertical writing, the glyph position shall be described by a position vector from the origin used for horizontal writing (origin 0) to the origin used for vertical writing (origin 1)", and the text position is origin 1.
// The glyph's box spans its width w0 from origin 0, at −v from the text position, and its vertical displacement w1 down from the text position.
const verticalBox = (glyph: FontGlyph | undefined, state: GraphicsState): TextBox => {
  const metrics = glyph?.vertical;
  if (glyph === undefined || metrics === undefined) {
    return { corners: cornersOf([0, 0, 0, 0]), core: [0, 0, 0, 0], displacement: undefined, estimated: false };
  }
  const left = -metrics.vx;
  const right = left + (glyph.width ?? 0);
  // The core box is one em wide, centred on the glyph's box, and no wider than it.
  const centre = (left + right) / 2;
  return {
    corners: cornersOf([left, metrics.w1, right, 0]),
    core: [Math.max(left, centre - 0.5), metrics.w1, Math.min(right, centre + 0.5), 0],
    displacement: glyphDisplacement(glyph, 1, state),
    estimated: false,
  };
};

/**
 * The advance box of a glyph shown with the text matrix `textMatrix` (ISO 32000-1:2008, 9.4.4), or of a string that could not be split when `glyph` is undefined, which then has no size.
 * `origin` is the text position: origin 0 in horizontal writing, origin 1 in vertical writing. `advance` is the glyph's own displacement, without the TJ numbers after it, transformed by Tm × CTM.
 * Quad corners are, in text space, the origin side's bottom, the far side's bottom, the far side's top and the origin side's top in horizontal writing, and the left bottom, right bottom, right top and left top in vertical writing.
 */
export const glyphGeometry = (
  font: FontModel,
  glyph: FontGlyph | undefined,
  { state, textMatrix }: { state: GraphicsState; textMatrix: Matrix },
): GlyphGeometry => {
  const trm = textRenderingMatrix(state, textMatrix);
  const box = font.writingMode === 1 ? verticalBox(glyph, state) : horizontalBox(font, glyph, state);
  const [dx, dy] = box.displacement ?? [0, 0];
  return {
    origin: transformPoint(trm, 0, 0),
    advance: transformVector(multiply(textMatrix, state.ctm), dx, dy),
    quad: quadOf(trm, box.corners),
    core: quadOf(trm, cornersOf(box.core)),
    coreInner: quadOf(trm, cornersOf(inset(box.core))),
    fontSize: Math.hypot(trm[2], trm[3]),
    degenerate: degenerate(trm),
    extentEstimated: box.estimated,
  };
};
