import type {
  Artboard,
  Coordinate,
  Fill,
  IllustratorDocument,
  Item,
  Layer,
  Paint,
  PathGeometry,
  PathItem,
  Point,
  RasterItem,
  Segment,
  SpotColor,
  Stroke,
  Subpath,
} from '../model/illustratorDocument.ts';

import { coordinateNumber } from '../model/coordinateNumber.ts';
import { cubicSegments } from '../model/cubicSegments.ts';
import { formatNativeNumber } from '../native/formatNativeNumber.ts';

const number = (value: Coordinate): number => Number(formatNativeNumber(value));
const rawNumber = coordinateNumber;
const point = (value: Point): Point => [number(value[0]), number(value[1])];

const subpath = (value: Subpath): Subpath => {
  const start = point(value.start);
  const segments: Segment[] = cubicSegments(value).map(segment => {
    if (segment.kind === 'line') return { kind: 'line', to: point(segment.to), anchor: segment.anchor ?? 'corner' };
    return { kind: 'curve', control1: point(segment.control1), control2: point(segment.control2), to: point(segment.to), anchor: segment.anchor ?? 'corner' };
  });
  const last = segments.at(-1)?.to;
  if (last !== undefined && (last[0] !== start[0] || last[1] !== start[1])) segments.push({ kind: 'line', to: start, anchor: 'corner' });
  return { start, segments };
};

const geometry = (value: PathGeometry): PathGeometry => ({ subpaths: value.subpaths.map(subpath), fillRule: value.fillRule ?? 'nonzero' });

const spot = (value: SpotColor): SpotColor => ({
  name: value.name,
  alternate: [number(value.alternate[0]), number(value.alternate[1]), number(value.alternate[2]), number(value.alternate[3])],
});

const paint = (value: Paint): Paint => {
  if (value.kind === 'process') return { kind: 'process', cmyk: [number(value.cmyk[0]), number(value.cmyk[1]), number(value.cmyk[2]), number(value.cmyk[3])] };
  const nativeTint = number(1 - (value.tint ?? 1));
  return { kind: 'spot', spot: spot(value.spot), tint: 1 - nativeTint };
};

const fill = (value: Fill): Fill => ({ paint: paint(value.paint), overprint: value.overprint ?? false });
const stroke = (value: Stroke): Stroke => ({ paint: paint(value.paint), width: number(value.width), overprint: value.overprint ?? false });

const path = (value: PathItem): PathItem => {
  const normalized = geometry(value.geometry);
  if (value.fill !== undefined && value.stroke !== undefined) {
    return { kind: 'path', locked: value.locked ?? false, geometry: normalized, fill: fill(value.fill), stroke: stroke(value.stroke) };
  }
  if (value.fill !== undefined) return { kind: 'path', locked: value.locked ?? false, geometry: normalized, fill: fill(value.fill) };
  if (value.stroke !== undefined) return { kind: 'path', locked: value.locked ?? false, geometry: normalized, stroke: stroke(value.stroke) };
  throw new Error('path has no paint');
};

const raster = (value: RasterItem): RasterItem => {
  const scaleX = number(rawNumber(value.bounds.width) / value.width);
  const scaleY = number(rawNumber(value.bounds.height) / value.height);
  const tx = number(value.bounds.x);
  const ty = number(rawNumber(value.bounds.y) + rawNumber(value.bounds.height));
  const bounds = { x: tx, y: ty - scaleY * value.height, width: scaleX * value.width, height: scaleY * value.height };
  const color =
    value.color.space === 'cmyk'
      ? { space: 'cmyk' as const, samples: new Uint8Array(value.color.samples) }
      : {
          space: 'spot' as const,
          spot: spot(value.color.spot),
          samples: new Uint8Array(value.color.samples ?? new Uint8Array(value.width * value.height).fill(255)),
        };
  return { kind: 'raster', locked: value.locked ?? false, width: value.width, height: value.height, bounds, color, alpha: new Uint8Array(value.alpha) };
};

const item = (value: Item): Item => {
  switch (value.kind) {
    case 'path': {
      return path(value);
    }
    case 'raster': {
      return raster(value);
    }
    case 'clipGroup': {
      return { kind: 'clipGroup', locked: value.locked ?? false, clip: geometry(value.clip), items: value.items.map(item) };
    }
    case 'group': {
      return {
        kind: 'group',
        locked: value.locked ?? false,
        opacity: number(value.opacity ?? 1),
        isolated: value.isolated ?? false,
        items: value.items.map(item),
      };
    }
    default: {
      throw new Error('unknown item kind');
    }
  }
};

const COLORS = [
  [79, 128, 255],
  [255, 79, 79],
  [79, 255, 79],
  [79, 79, 255],
  [255, 79, 255],
] as const;

const layer = (value: Layer, index: number): Layer => {
  const color = value.color ?? COLORS[index % COLORS.length] ?? COLORS[0];
  return {
    name: value.name,
    visible: value.visible ?? true,
    locked: value.locked ?? false,
    opacity: number(value.opacity ?? 1),
    color,
    items: value.items.map(item),
  };
};

const artboard = (value: Artboard): Artboard => {
  const bleed = value.bleed ?? 0;
  const sides =
    typeof bleed === 'number' || 'numerator' in bleed
      ? { top: number(bleed), right: number(bleed), bottom: number(bleed), left: number(bleed) }
      : { top: number(bleed.top), right: number(bleed.right), bottom: number(bleed.bottom), left: number(bleed.left) };
  const base: Artboard = { width: number(value.width), height: number(value.height), bleed: sides };
  return value.name === undefined ? base : { ...base, name: value.name };
};

/** Materializes defaults and the native writer's decimal rounding for comparison with its reader. */
export const normalizeModel = (document: IllustratorDocument): IllustratorDocument => ({
  artboard: artboard(document.artboard),
  layers: document.layers.map(layer),
  lastModified: document.lastModified,
  title: document.title ?? '',
});
