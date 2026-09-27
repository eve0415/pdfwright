import type { Matrix } from './matrix.ts';

import { transformPoint } from './matrix.ts';

export type Point = readonly [number, number];

/** Curves are replaced by chords no farther than this from the curve, in page space units. */
const FLATNESS = 0.05;

/** Past this many vertices in all its paths together a clip is not evaluated; a path keeps no more points than that, so that its memory is bounded, and counts the rest. */
export const MAX_CLIP_VERTICES = 10_000;

// Bounds the chords of one curve, so that a huge curve costs bounded work; such a curve counts towards the clip vertex limit anyway.
const MAX_CHORDS = 4096;

/** Collects a path's subpaths in page space as polygons, with the points, which ISO 32000-1:2008, 8.5.2.1, Table 59 gives in user space, transformed by the CTM in force when the path is built, and curves flattened. */
export class PathBuilder {
  private readonly matrix: Matrix;
  private readonly subpaths: Point[][] = [];
  private count = 0;
  private current: Point[] | undefined = undefined;
  // The current point in user space, which v uses as a control point (Table 59: "using the current point and (x2 , y2 ) as the Bézier control points"), and the start of the current subpath, which h returns to.
  private user: Point | undefined = undefined;
  private start: Point = [0, 0];

  constructor(matrix: Matrix) {
    this.matrix = matrix;
  }

  private point(x: number, y: number): Point {
    return transformPoint(this.matrix, x, y);
  }

  // Adds a point to a subpath while the path is within the vertex limit.
  private keep(points: Point[], point: Point): void {
    this.count++;
    if (this.count <= MAX_CLIP_VERTICES + 1) points.push(point);
  }

  /** The number of vertices the path has, including those past the limit that it does not keep. */
  get vertices(): number {
    return this.count;
  }

  moveTo(x: number, y: number): void {
    this.current = [];
    this.keep(this.current, this.point(x, y));
    if (this.count <= MAX_CLIP_VERTICES + 1) this.subpaths.push(this.current);
    this.user = [x, y];
    this.start = [x, y];
  }

  // The subpath a segment extends: after h, Table 59 says "Appending another segment to the current path shall begin a new subpath", at the closed subpath's start; with no current point at all, the segment's own first point starts one.
  private extended(x: number, y: number): Point[] {
    if (this.current === undefined) {
      const [startX, startY] = this.user ?? [x, y];
      this.moveTo(startX, startY);
    }
    return this.current ?? [];
  }

  lineTo(x: number, y: number): void {
    this.keep(this.extended(x, y), this.point(x, y));
    this.user = [x, y];
  }

  /** The c operator's operands x1 y1 x2 y2 x3 y3; v and y pass the current point or the end point as the control point they omit. */
  curveTo([x1, y1, x2, y2, x3, y3]: readonly [number, number, number, number, number, number]): void {
    const points = this.extended(x1, y1);
    const [c1, c2, end] = [this.point(x1, y1), this.point(x2, y2), this.point(x3, y3)];
    const start = points.at(-1) ?? c1;
    // Wang's bound: n chords of a cubic Bézier curve stay within tolerance t of it when n ≥ √(3/4 × M / t), where M is the largest second difference of the control points.
    const first = Math.hypot(start[0] - 2 * c1[0] + c2[0], start[1] - 2 * c1[1] + c2[1]);
    const second = Math.max(first, Math.hypot(c1[0] - 2 * c2[0] + end[0], c1[1] - 2 * c2[1] + end[1]));
    const needed = Math.ceil(Math.sqrt((0.75 * second) / FLATNESS));
    const chords = Math.min(MAX_CHORDS, Math.max(1, needed));
    // Past the limit the points would not be kept, so they are only counted.
    const computed = this.count > MAX_CLIP_VERTICES ? 0 : chords;
    this.count += chords - computed;
    for (let step = 1; step <= computed; step++) {
      const t = step / chords;
      const u = 1 - t;
      const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      this.keep(points, [a * start[0] + b * c1[0] + c * c2[0] + d * end[0], a * start[1] + b * c1[1] + c * c2[1] + d * end[1]]);
    }
    this.user = [x3, y3];
  }

  /** The current point in user space, or undefined before the first segment. */
  currentPoint(): Point | undefined {
    return this.user;
  }

  /** h: closes the current subpath. Its polygon is closed implicitly, so no point is added. */
  close(): void {
    if (this.current === undefined) return;
    this.current = undefined;
    this.user = this.start;
  }

  /** re appends "a rectangle to the current path as a complete subpath" (Table 59). */
  rectangle([x, y, width, height]: readonly [number, number, number, number]): void {
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.close();
  }

  polygons(): readonly (readonly Point[])[] {
    return this.subpaths;
  }

  /** The path's corners [left bottom right top] when it is a single rectangle with sides parallel to the page axes and positive area, as re draws it under a CTM without rotation or skew; otherwise undefined. */
  axisAlignedRectangle(): readonly [number, number, number, number] | undefined {
    const [polygon, ...rest] = this.subpaths;
    if (polygon === undefined || rest.length > 0 || this.count > MAX_CLIP_VERTICES) return undefined;
    const [first] = polygon;
    const last = polygon.at(-1);
    const corners =
      polygon.length === 5 && first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1] ? polygon.slice(0, 4) : polygon;
    if (corners.length !== 4) return undefined;
    const xs = new Set(corners.map(([x]) => x));
    const ys = new Set(corners.map(([, y]) => y));
    // Each side is horizontal or vertical, and they alternate.
    const sides = corners.map((corner, index) => {
      const next = corners[(index + 1) % 4] ?? corner;
      if (corner[1] === next[1] && corner[0] !== next[0]) return 'horizontal';
      return corner[0] === next[0] && corner[1] !== next[1] ? 'vertical' : 'other';
    });
    const alternate = sides.every((side, index) => side !== 'other' && side !== sides[(index + 1) % 4]);
    if (xs.size !== 2 || ys.size !== 2 || !alternate) return undefined;
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
}
