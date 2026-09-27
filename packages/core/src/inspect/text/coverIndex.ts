import type { Quad } from '../../content/clip.ts';
import type { CoverEvent } from '../../content/interpreter.ts';

// A point on a rectangle's edge counts as covered.
const COVER_TOLERANCE = 1e-6;

// A rectangle over more cells than this is kept in one list that every query reads, so that adding it costs bounded work.
const MAX_CELLS_PER_COVER = 64;

// The grid has at most this many columns and rows.
const MAX_CELLS_PER_SIDE = 4096;

interface Bounds {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

const insideRectangle = ([left, bottom, right, top]: CoverEvent['rectangle'], x: number, y: number): boolean =>
  x >= left - COVER_TOLERANCE && x <= right + COVER_TOLERANCE && y >= bottom - COVER_TOLERANCE && y <= top + COVER_TOLERANCE;

/** The bounds of the quads, or undefined when there are none or a coordinate is not finite. */
export const quadBounds = (quads: Iterable<Quad>): Bounds | undefined => {
  let [left, bottom, right, top] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x0, y0, x1, y1, x2, y2, x3, y3] of quads) {
    left = Math.min(left, x0, x1, x2, x3);
    bottom = Math.min(bottom, y0, y1, y2, y3);
    right = Math.max(right, x0, x1, x2, x3);
    top = Math.max(top, y0, y1, y2, y3);
  }
  return [left, bottom, right, top].every(value => Number.isFinite(value)) ? { left, bottom, right, top } : undefined;
};

/**
 * Opaque rectangle fills in a grid over the area the glyphs occupy, so that a point is tested only against the fills near it.
 * Fills are added in reverse content order while glyphs are visited from last to first, so that a query sees only the fills painted after the glyph it is made for.
 */
export class CoverIndex {
  private readonly bounds: Bounds;
  private readonly columns: number;
  private readonly rows: number;
  private readonly cells = new Map<number, CoverEvent[]>();
  private readonly large: CoverEvent[] = [];

  /** A grid over `bounds` with cells about the size that gives each of `count` glyphs one. */
  constructor(bounds: Bounds, count: number) {
    this.bounds = bounds;
    const [width, height] = [bounds.right - bounds.left, bounds.top - bounds.bottom];
    const side = Math.sqrt((width * height) / Math.max(1, count));
    const cells = (length: number): number => (side > 0 && length > 0 ? Math.min(MAX_CELLS_PER_SIDE, Math.max(1, Math.ceil(length / side))) : 1);
    this.columns = cells(width);
    this.rows = cells(height);
  }

  private column(x: number): number {
    const { left, right } = this.bounds;
    const at = right > left ? Math.floor(((x - left) / (right - left)) * this.columns) : 0;
    return Math.min(this.columns - 1, Math.max(0, at));
  }

  private row(y: number): number {
    const { bottom, top } = this.bounds;
    const at = top > bottom ? Math.floor(((y - bottom) / (top - bottom)) * this.rows) : 0;
    return Math.min(this.rows - 1, Math.max(0, at));
  }

  add(cover: CoverEvent): void {
    const [left, bottom, right, top] = cover.rectangle;
    const { bounds } = this;
    const tolerance = COVER_TOLERANCE;
    if (right < bounds.left - tolerance || left > bounds.right + tolerance || top < bounds.bottom - tolerance || bottom > bounds.top + tolerance) return;
    const [firstColumn, lastColumn] = [this.column(left - tolerance), this.column(right + tolerance)];
    const [firstRow, lastRow] = [this.row(bottom - tolerance), this.row(top + tolerance)];
    if ((lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) > MAX_CELLS_PER_COVER) {
      this.large.push(cover);
      return;
    }
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const key = row * this.columns + column;
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [cover]);
        else list.push(cover);
      }
    }
  }

  /** Whether a fill added so far paints over the point: the point lies in its rectangle and inside the clip it was painted under. */
  hides(x: number, y: number): boolean {
    const near = this.cells.get(this.row(y) * this.columns + this.column(x)) ?? [];
    const paints = (cover: CoverEvent): boolean => insideRectangle(cover.rectangle, x, y) && cover.clip.classifyPoint(x, y) === 'inside';
    return near.some(cover => paints(cover)) || this.large.some(cover => paints(cover));
  }
}
