import type { IllustratorDocument, Item, PathGeometry, Point } from '../model/illustratorDocument.ts';

import { coordinateNumber } from '../model/coordinateNumber.ts';

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

const number = coordinateNumber;
const xy = (point: Point): readonly [number, number] => [number(point[0]), number(point[1])];

const includePoint = (bounds: Bounds, x: number, y: number): Bounds => ({
  minX: Math.min(bounds.minX, x),
  minY: Math.min(bounds.minY, y),
  maxX: Math.max(bounds.maxX, x),
  maxY: Math.max(bounds.maxY, y),
});

const union = (left: Bounds | undefined, right: Bounds): Bounds =>
  left === undefined
    ? right
    : {
        minX: Math.min(left.minX, right.minX),
        minY: Math.min(left.minY, right.minY),
        maxX: Math.max(left.maxX, right.maxX),
        maxY: Math.max(left.maxY, right.maxY),
      };

const cubic = ([p0, p1, p2, p3]: readonly [number, number, number, number], t: number): number => {
  const reverse = 1 - t;
  return reverse ** 3 * p0 + 3 * reverse ** 2 * t * p1 + 3 * reverse * t ** 2 * p2 + t ** 3 * p3;
};

const extrema = ([p0, p1, p2, p3]: readonly [number, number, number, number]): number[] => {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 3 * p0 - 6 * p1 + 3 * p2;
  const c = -3 * p0 + 3 * p1;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return [];
    const t = -c / (2 * b);
    return t > 0 && t < 1 ? [t] : [];
  }
  const discriminant = b * b - 3 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b - root) / (3 * a), (-b + root) / (3 * a)].filter(t => t > 0 && t < 1);
};

/** Returns the exact geometric bounds of a path's cubic segments. */
export const pathBounds = (geometry: PathGeometry): Bounds => {
  let [x, y] = xy(geometry.start);
  let bounds: Bounds = { minX: x, minY: y, maxX: x, maxY: y };
  for (const segment of geometry.segments) {
    const [nextX, nextY] = xy(segment.to);
    if (segment.kind === 'curve') {
      const [controlX1, controlY1] = xy(segment.control1);
      const [controlX2, controlY2] = xy(segment.control2);
      const curveX: readonly [number, number, number, number] = [x, controlX1, controlX2, nextX];
      const curveY: readonly [number, number, number, number] = [y, controlY1, controlY2, nextY];
      const times = [...extrema(curveX), ...extrema(curveY)];
      for (const t of times) {
        bounds = includePoint(bounds, cubic(curveX, t), cubic(curveY, t));
      }
    }
    bounds = includePoint(bounds, nextX, nextY);
    x = nextX;
    y = nextY;
  }
  return bounds;
};

type Vector = readonly [number, number];

interface SegmentTangents {
  readonly start: Vector;
  readonly entering: Vector | undefined;
  readonly leaving: Vector | undefined;
}

const direction = (from: Vector, to: Vector): Vector | undefined => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  return length === 0 ? undefined : [dx / length, dy / length];
};

const firstDirection = (from: Vector, points: readonly Vector[]): Vector | undefined => {
  for (const point of points) {
    const tangent = direction(from, point);
    if (tangent !== undefined) return tangent;
  }
  return undefined;
};

const segmentTangents = (geometry: PathGeometry): SegmentTangents[] => {
  const start = xy(geometry.start);
  let current = start;
  const segments: SegmentTangents[] = [];
  for (const segment of geometry.segments) {
    const end = xy(segment.to);
    const control1 = segment.kind === 'curve' ? xy(segment.control1) : end;
    const control2 = segment.kind === 'curve' ? xy(segment.control2) : current;
    const reverse = firstDirection(end, [control2, control1, current]);
    segments.push({
      start: current,
      leaving: firstDirection(current, [control1, control2, end]),
      entering: reverse === undefined ? undefined : [-reverse[0], -reverse[1]],
    });
    current = end;
  }
  if (current[0] !== start[0] || current[1] !== start[1]) {
    segments.push({ start: current, leaving: direction(current, start), entering: direction(current, start) });
  }
  return segments;
};

const strokedBounds = (geometry: PathGeometry, radius: number): Bounds => {
  const bounds = pathBounds(geometry);
  let stroked: Bounds = { minX: bounds.minX - radius, minY: bounds.minY - radius, maxX: bounds.maxX + radius, maxY: bounds.maxY + radius };
  if (radius === 0) return stroked;
  const segments = segmentTangents(geometry);
  for (let index = 0; index < segments.length; index++) {
    const previous = segments[(index + segments.length - 1) % segments.length];
    const next = segments[index];
    const incoming = previous?.entering;
    const outgoing = next?.leaving;
    if (incoming === undefined || outgoing === undefined || next === undefined) continue;
    const dot = Math.max(-1, Math.min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1]));
    const sinHalf = Math.sqrt((1 + dot) / 2);
    // ISO 32000-1:2008, 8.4.3.4-8.4.3.5: miter joins bevel when the full miter length / line width exceeds 10.
    if (sinHalf === 0 || 1 / sinHalf > 10) continue;
    const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    if (cross === 0) continue;
    const side = cross < 0 ? 1 : -1;
    const scale = (side * radius) / (1 + dot);
    stroked = includePoint(stroked, next.start[0] + scale * (-incoming[1] - outgoing[1]), next.start[1] + scale * (incoming[0] + outgoing[0]));
  }
  return stroked;
};

const itemBounds = (item: Item): Bounds | undefined => {
  switch (item.kind) {
    case 'path': {
      const radius = item.stroke === undefined ? 0 : number(item.stroke.width) / 2;
      return strokedBounds(item.geometry, radius);
    }
    case 'raster': {
      const x = number(item.bounds.x);
      const y = number(item.bounds.y);
      return { minX: x, minY: y, maxX: x + number(item.bounds.width), maxY: y + number(item.bounds.height) };
    }
    case 'clipGroup': {
      return pathBounds(item.clip);
    }
    case 'group': {
      let bounds: Bounds | undefined = undefined;
      for (const child of item.items) {
        const next = itemBounds(child);
        if (next !== undefined) bounds = union(bounds, next);
      }
      return bounds;
    }
    default: {
      return undefined;
    }
  }
};

/** Returns the union of visible art, or the artboard when no visible object contributes bounds. */
export const artBounds = (document: IllustratorDocument): Bounds => {
  let bounds: Bounds | undefined = undefined;
  for (const layer of document.layers) {
    if (layer.visible === false) continue;
    for (const item of layer.items) {
      const next = itemBounds(item);
      if (next !== undefined) bounds = union(bounds, next);
    }
  }
  return bounds ?? { minX: 0, minY: 0, maxX: number(document.artboard.width), maxY: number(document.artboard.height) };
};

export const integerBounds = (bounds: Bounds): readonly [number, number, number, number] => [
  Math.floor(bounds.minX),
  Math.floor(bounds.minY),
  Math.ceil(bounds.maxX),
  Math.ceil(bounds.maxY),
];
