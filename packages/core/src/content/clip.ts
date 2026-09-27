import type { Matrix } from './matrix.ts';
import type { Point } from './path.ts';

import { PathBuilder } from './path.ts';

/** Four corners in page space, as x y pairs, in order around the quadrilateral. */
export type Quad = readonly [number, number, number, number, number, number, number, number];

/** ISO 32000-1:2008, 8.5.4, Table 61: W uses the nonzero winding number rule and W* the even-odd rule. */
export type FillRule = 'nonzero' | 'even-odd';

export type ClipClass = 'inside' | 'outside' | 'partial' | 'unknown';

/** Past this many vertices in all its paths together a clip is not evaluated, and classifications are `unknown`. */
export const MAX_CLIP_VERTICES = 10_000;

// A point closer than this to a clip boundary counts as on it, and so as inside: a glyph set flush against a clip edge is not clipped.
const ON_EDGE = 1e-6;

/** A rectangle [llx lly urx ury] transformed into page space as a closed path, such as a form's BBox (8.10.1). */
export const rectanglePath = ([left, bottom, right, top]: readonly [number, number, number, number], matrix: Matrix): PathBuilder => {
  const path = new PathBuilder(matrix);
  path.rectangle([left, bottom, right - left, top - bottom]);
  return path;
};

interface Bounds {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

interface ClipPath {
  readonly polygons: readonly (readonly Point[])[];
  readonly rule: FillRule;
  readonly bounds: Bounds;
}

const boundsOf = (points: Iterable<Point>): Bounds => {
  let [left, bottom, right, top] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    left = Math.min(left, x);
    bottom = Math.min(bottom, y);
    right = Math.max(right, x);
    top = Math.max(top, y);
  }
  return { left, bottom, right, top };
};

const overlaps = (a: Bounds, b: Bounds): boolean => a.left <= b.right && b.left <= a.right && a.bottom <= b.top && b.bottom <= a.top;

// The sign of the turn from a→b to a→p: positive when p lies to the left of the line through a and b.
const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

const onSegment = (a: Point, b: Point, p: Point): boolean => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= ON_EDGE;
};

// Every edge of the polygons, each closed implicitly: 8.5.3.3.1, "Any subpaths that are open shall be implicitly closed before being filled".
const edgesOf = function* (polygons: readonly (readonly Point[])[]): Generator<readonly [Point, Point]> {
  for (const polygon of polygons) {
    for (const [index, point] of polygon.entries()) {
      const next = polygon[(index + 1) % polygon.length];
      if (next !== undefined && polygon.length > 1) yield [point, next];
    }
  }
};

// 8.5.3.3.2 and 8.5.3.3.3: the winding number counts signed crossings of a ray from the point, and the even-odd rule takes its parity; a point on the boundary is inside.
const insidePath = (path: ClipPath, p: Point): boolean => {
  const { bounds } = path;
  if (p[0] < bounds.left - ON_EDGE || p[0] > bounds.right + ON_EDGE || p[1] < bounds.bottom - ON_EDGE || p[1] > bounds.top + ON_EDGE) {
    return false;
  }
  let winding = 0;
  for (const [a, b] of edgesOf(path.polygons)) {
    if (onSegment(a, b, p)) return true;
    if (a[1] <= p[1]) {
      if (b[1] > p[1] && cross(a, b, p) > 0) winding++;
    } else if (b[1] <= p[1] && cross(a, b, p) < 0) winding--;
  }
  return path.rule === 'nonzero' ? winding !== 0 : Math.abs(winding) % 2 === 1;
};

// Whether the segments cross at a point inside both, not merely touching.
const crosses = ([a, b]: readonly [Point, Point], [c, d]: readonly [Point, Point]): boolean => {
  const [d1, d2, d3, d4] = [cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)];
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

// Whether a point lies strictly inside a convex quadrilateral.
const strictlyInsideQuad = (corners: readonly Point[], p: Point): boolean => {
  const signs = corners.map((corner, index) => Math.sign(cross(corner, corners[(index + 1) % corners.length] ?? corner, p)));
  return signs.every(sign => sign > 0) || signs.every(sign => sign < 0);
};

const classifyAgainst = (path: ClipPath, corners: readonly Point[], quadBounds: Bounds): 'inside' | 'outside' | 'partial' => {
  if (!overlaps(path.bounds, quadBounds)) return 'outside';
  const [x0, y0] = corners[0] ?? [0, 0];
  const [x2, y2] = corners[2] ?? [0, 0];
  const samples = [...corners, [(x0 + x2) / 2, (y0 + y2) / 2] as const];
  const inside = samples.filter(sample => insidePath(path, sample)).length;
  if (inside !== 0 && inside !== samples.length) return 'partial';
  // All samples agree, but the boundary may still pass through the quad: an edge crossing one of its sides, or a vertex within it.
  const sides = corners.map((corner, index) => [corner, corners[(index + 1) % corners.length] ?? corner] as const);
  for (const edge of edgesOf(path.polygons)) {
    if (sides.some(side => crosses(side, edge)) || strictlyInsideQuad(corners, edge[0])) return 'partial';
  }
  return inside === 0 ? 'outside' : 'inside';
};

/**
 * The current clipping path (8.5.4), as the intersection of paths in page space flattened to polygons, each with its fill rule.
 * A clip is immutable: intersecting it makes a new one that shares the paths already there, so each event can keep the clip it was painted under.
 */
export class Clip {
  /** 8.5.4: "The initial clipping path shall include the entire page." */
  static readonly NONE: Clip = new Clip(undefined, undefined, 0);

  private readonly parent: Clip | undefined;
  private readonly path: ClipPath | undefined;
  /** The number of vertices of all the clip's paths. */
  readonly vertices: number;

  private constructor(parent: Clip | undefined, path: ClipPath | undefined, vertices: number) {
    this.parent = parent;
    this.path = path;
    this.vertices = vertices;
  }

  /** This clip intersected with a path, as W or W* followed by a painting operator make it. */
  intersect(path: PathBuilder, rule: FillRule): Clip {
    const polygons = path.polygons();
    const count = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
    return new Clip(this, { polygons, rule, bounds: boundsOf(polygons.flat()) }, this.vertices + count);
  }

  private *paths(): Generator<ClipPath> {
    if (this.path !== undefined) yield this.path;
    for (let clip = this.parent; clip !== undefined; clip = clip.parent) if (clip.path !== undefined) yield clip.path;
  }

  /** Whether a point in page space is inside the clip; `unknown` past MAX_CLIP_VERTICES. */
  classifyPoint(x: number, y: number): 'inside' | 'outside' | 'unknown' {
    if (this.vertices > MAX_CLIP_VERTICES) return 'unknown';
    for (const path of this.paths()) if (!insidePath(path, [x, y])) return 'outside';
    return 'inside';
  }

  /** Whether a quad in page space lies inside the clip, outside it, or across its boundary; `unknown` past MAX_CLIP_VERTICES. */
  classifyQuad(quad: Quad): ClipClass {
    if (this.vertices > MAX_CLIP_VERTICES) return 'unknown';
    const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
    const corners: Point[] = [
      [x0, y0],
      [x1, y1],
      [x2, y2],
      [x3, y3],
    ];
    const quadBounds = boundsOf(corners);
    let result: ClipClass = 'inside';
    for (const path of this.paths()) {
      const found = classifyAgainst(path, corners, quadBounds);
      if (found === 'outside') return 'outside';
      if (found === 'partial') result = 'partial';
    }
    return result;
  }
}
