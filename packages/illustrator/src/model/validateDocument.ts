import type { Coordinate, IllustratorDocument, Item, Paint, PathGeometry, PathItem, Point, RasterItem, SpotColor } from './illustratorDocument.ts';

import { UnsupportedFeatureError, ValidationError } from '@pdfwright/core';

import { formatNativeNumber } from '../native/formatNativeNumber.ts';
import { escapeXmlIdentifier } from '../native/nativeString.ts';

import { coordinateNumber } from './coordinateNumber.ts';

const coordinate = (value: unknown): number => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('coordinate must be finite', 'illustrator-model');
    return value;
  }
  if (typeof value !== 'object' || value === null || !('numerator' in value) || !('denominator' in value)) {
    throw new ValidationError('coordinate must be a number or rational length', 'illustrator-model');
  }
  const { numerator, denominator } = value;
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new ValidationError('coordinate must be a number or rational length', 'illustrator-model');
  }
  if (denominator <= 0n) throw new ValidationError('length denominator must be positive', 'illustrator-model');
  const number = coordinateNumber({ numerator, denominator });
  if (!Number.isFinite(number)) throw new ValidationError('coordinate must be finite', 'illustrator-model');
  return number;
};

const optionalBoolean = (value: unknown, name: string): void => {
  if (value !== undefined && typeof value !== 'boolean') throw new ValidationError(`${name} must be a boolean`, 'illustrator-model');
};

const unitInterval = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError(`${name} must be between 0 and 1`, 'illustrator-model');
};

const nativeName = (value: string, name: string): void => {
  if (value.length === 0) throw new ValidationError(`${name} cannot be empty`, 'illustrator-model');
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) throw new ValidationError(`${name} cannot contain control characters`, 'illustrator-model');
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) throw new ValidationError(`${name} cannot contain lone surrogates`, 'illustrator-model');
  }
};

const spotKey = (spot: SpotColor): string => [...(spot.nameBytes ?? new TextEncoder().encode(spot.name))].join(',');
const knownFields = (value: unknown, names: readonly string[], context: string): void => {
  if (typeof value !== 'object' || value === null) throw new ValidationError(`${context} must be an object`, 'illustrator-model');
  for (const name of Object.keys(value)) {
    if (!names.includes(name)) throw new UnsupportedFeatureError(`${context} field ${name} is unsupported`);
  }
};
const knownVariant = (kind: string, names: readonly string[], context: string): void => {
  if (!names.includes(kind)) throw new UnsupportedFeatureError(`${context} kind is unsupported`);
};

const bleedSideValues = (bleed: unknown): readonly unknown[] => {
  if (typeof bleed !== 'object' || bleed === null) throw new ValidationError('bleed sides must be an object', 'illustrator-model');
  return [
    'top' in bleed ? bleed.top : undefined,
    'right' in bleed ? bleed.right : undefined,
    'bottom' in bleed ? bleed.bottom : undefined,
    'left' in bleed ? bleed.left : undefined,
  ];
};

const validateBleed = (bleed: unknown, width: number, height: number): void => {
  if (bleed !== undefined) {
    if (typeof bleed !== 'number' && (typeof bleed !== 'object' || bleed === null)) {
      throw new ValidationError('bleed must be a coordinate or sides', 'illustrator-model');
    }
    if (typeof bleed === 'object' && !('numerator' in bleed)) knownFields(bleed, ['top', 'right', 'bottom', 'left'], 'bleed');
    const sides = typeof bleed === 'number' || 'numerator' in bleed ? [bleed] : bleedSideValues(bleed);
    const amounts = sides.map(side => coordinate(side));
    for (const amount of amounts) if (amount < 0) throw new ValidationError('bleed cannot be negative', 'illustrator-model');
    const [top = 0, right = top, bottom = top, left = top] = amounts;
    if (width + left + right > 14400 || height + top + bottom > 14400) {
      throw new ValidationError('page dimensions including bleed cannot exceed 14400 points', 'illustrator-model');
    }
  }
};

const validateHeader = (document: IllustratorDocument, width: number, height: number): void => {
  knownFields(document.artboard, ['width', 'height', 'bleed', 'name'], 'artboard');
  if (document.artboard.name !== undefined) nativeName(document.artboard.name, 'artboard name');
  if (document.title !== undefined) {
    for (const character of document.title) {
      const code = character.codePointAt(0);
      if (code === undefined || code < 32 || code > 126) throw new ValidationError('title requires printable ASCII', 'illustrator-model');
    }
  }
  validateBleed(document.artboard.bleed, width, height);
};

/** Validates every model value before any output is emitted. */
export const validateDocument = (document: IllustratorDocument): void => {
  knownFields(document, ['artboard', 'layers', 'lastModified', 'title'], 'document');
  const width = coordinate(document.artboard.width);
  const height = coordinate(document.artboard.height);
  if (width <= 0 || height <= 0 || width > 14400 || height > 14400) {
    throw new ValidationError('artboard dimensions must be in (0, 14400] points', 'illustrator-model');
  }
  validateHeader(document, width, height);

  const rulerX = Math.floor(8191.5 - width / 2);
  const rulerY = Math.floor(8191.5 - height / 2);
  const point = (value: Point): void => {
    const x = coordinate(value[0]);
    const y = coordinate(value[1]);
    if (x < -rulerX || x > 16383 - rulerX || y < -rulerY || y > 16383 - rulerY) {
      throw new ValidationError('native coordinate lies outside the Illustrator canvas', 'illustrator-model');
    }
  };
  const positive = (value: Coordinate, name: string): number => {
    const number = coordinate(value);
    if (number < 0) throw new ValidationError(`${name} cannot be negative`, 'illustrator-model');
    return number;
  };
  const spots = new Map<string, SpotColor>();
  const spotNames = new Map<string, string>();
  const checkSpot = (spot: SpotColor): void => {
    knownFields(spot, ['name', 'nameBytes', 'alternate'], 'spot');
    nativeName(spot.name, 'spot name');
    if (spot.nameBytes?.length === 0) throw new ValidationError('spot name bytes cannot be empty', 'illustrator-model');
    const nameBytes = spot.nameBytes ?? new TextEncoder().encode(spot.name);
    if (nameBytes.length > 127 || nameBytes.includes(0)) {
      throw new ValidationError('spot colorant names must have at most 127 bytes and no null byte', 'illustrator-model');
    }
    for (const component of spot.alternate) unitInterval(component, 'spot alternate');
    const key = spotKey(spot);
    const earlierKey = spotNames.get(spot.name);
    if (earlierKey !== undefined && earlierKey !== key) throw new ValidationError('spot name has conflicting colorant bytes', 'illustrator-spot-identity');
    const earlier = spots.get(key);
    if (earlier !== undefined && (earlier.name !== spot.name || earlier.alternate.some((component, index) => component !== spot.alternate[index]))) {
      throw new ValidationError('spot colorant bytes have conflicting definitions', 'illustrator-spot-identity');
    }
    spotNames.set(spot.name, key);
    spots.set(key, spot);
  };
  const checkPaint = (paint: Paint): void => {
    knownVariant(paint.kind, ['process', 'spot'], 'paint');
    if (paint.kind === 'process') {
      knownFields(paint, ['kind', 'cmyk'], 'process paint');
      for (const component of paint.cmyk) unitInterval(component, 'CMYK component');
    } else {
      knownFields(paint, ['kind', 'spot', 'tint'], 'spot paint');
      checkSpot(paint.spot);
      if (paint.tint !== undefined) unitInterval(paint.tint, 'spot tint');
    }
  };
  const geometry = (value: PathGeometry): void => {
    knownFields(value, ['start', 'segments'], 'path geometry');
    point(value.start);
    if (value.segments.length === 0) throw new ValidationError('path requires at least one segment', 'illustrator-model');
    for (const segment of value.segments) {
      knownVariant(segment.kind, ['line', 'curve'], 'path segment');
      point(segment.to);
      if (segment.kind === 'curve') {
        knownFields(segment, ['kind', 'control1', 'control2', 'to', 'anchor'], 'curve segment');
        point(segment.control1);
        point(segment.control2);
      } else knownFields(segment, ['kind', 'to', 'anchor'], 'line segment');
    }
  };
  const checkPath = (item: PathItem): void => {
    knownFields(item, ['kind', 'locked', 'geometry', 'fill', 'stroke'], 'path');
    optionalBoolean(item.locked, 'path locked');
    geometry(item.geometry);
    if (item.fill === undefined && item.stroke === undefined) throw new ValidationError('path requires a fill or stroke', 'illustrator-model');
    if (item.fill !== undefined) {
      knownFields(item.fill, ['paint', 'overprint'], 'fill');
      optionalBoolean(item.fill.overprint, 'fill overprint');
      checkPaint(item.fill.paint);
    }
    if (item.stroke !== undefined) {
      knownFields(item.stroke, ['paint', 'width', 'overprint'], 'stroke');
      optionalBoolean(item.stroke.overprint, 'stroke overprint');
      checkPaint(item.stroke.paint);
      if (positive(item.stroke.width, 'stroke width') > 14400) throw new ValidationError('stroke width cannot exceed 14400 points', 'illustrator-model');
    }
  };
  const checkRaster = (item: RasterItem): void => {
    knownFields(item, ['kind', 'locked', 'width', 'height', 'bounds', 'color', 'alpha'], 'raster');
    optionalBoolean(item.locked, 'raster locked');
    knownFields(item.bounds, ['x', 'y', 'width', 'height'], 'raster bounds');
    if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) || item.width <= 0 || item.height <= 0) {
      throw new ValidationError('raster dimensions must be positive integers', 'illustrator-model');
    }
    const pixels = item.width * item.height;
    if (!Number.isSafeInteger(pixels)) throw new ValidationError('raster pixel count is too large', 'illustrator-model');
    const x = coordinate(item.bounds.x);
    const y = coordinate(item.bounds.y);
    const rasterWidth = positive(item.bounds.width, 'raster width');
    const rasterHeight = positive(item.bounds.height, 'raster height');
    if (rasterWidth === 0 || rasterHeight === 0) throw new ValidationError('raster placement must have positive size', 'illustrator-model');
    if (formatNativeNumber(rasterWidth / item.width) === '0' || formatNativeNumber(rasterHeight / item.height) === '0') {
      throw new ValidationError('raster scale rounds to zero in native data', 'illustrator-model');
    }
    point([x, y]);
    point([x + rasterWidth, y + rasterHeight]);
    if (item.alpha.length !== pixels) throw new ValidationError('raster alpha length does not match dimensions', 'illustrator-model');
    knownVariant(item.color.space, ['cmyk', 'spot'], 'raster color space');
    if (item.color.space === 'cmyk') {
      knownFields(item.color, ['space', 'samples'], 'CMYK raster');
      if (item.color.samples.length !== pixels * 4) throw new ValidationError('CMYK sample length does not match dimensions', 'illustrator-model');
    } else {
      knownFields(item.color, ['space', 'spot', 'samples'], 'spot raster');
      checkSpot(item.color.spot);
      if (item.color.samples !== undefined && item.color.samples.length !== pixels) {
        throw new ValidationError('spot sample length does not match dimensions', 'illustrator-model');
      }
    }
  };
  const items = (values: readonly Item[], depth: number): void => {
    if (depth > 128) throw new ValidationError('group nesting cannot exceed 128 levels', 'illustrator-model');
    for (const item of values) {
      switch (item.kind) {
        case 'path': {
          checkPath(item);
          break;
        }
        case 'raster': {
          checkRaster(item);
          break;
        }
        case 'clipGroup': {
          knownFields(item, ['kind', 'locked', 'clip', 'items'], 'clip group');
          optionalBoolean(item.locked, 'clip group locked');
          if (item.items.length === 0) throw new ValidationError('clip group cannot be empty', 'illustrator-model');
          geometry(item.clip);
          items(item.items, depth + 1);
          break;
        }
        case 'group': {
          knownFields(item, ['kind', 'locked', 'opacity', 'isolated', 'items'], 'group');
          optionalBoolean(item.locked, 'group locked');
          if (item.items.length === 0) throw new ValidationError('group cannot be empty', 'illustrator-model');
          if (item.opacity !== undefined) unitInterval(item.opacity, 'group opacity');
          optionalBoolean(item.isolated, 'group isolated');
          items(item.items, depth + 1);
          break;
        }
        default: {
          throw new UnsupportedFeatureError('item kind is unsupported');
        }
      }
    }
  };

  const layerNames = new Set<string>();
  for (const layer of document.layers) {
    knownFields(layer, ['name', 'visible', 'locked', 'opacity', 'color', 'items'], 'layer');
    optionalBoolean(layer.visible, 'layer visible');
    optionalBoolean(layer.locked, 'layer locked');
    nativeName(layer.name, 'layer name');
    const identifier = escapeXmlIdentifier(layer.name);
    if (layerNames.has(identifier)) throw new ValidationError('layer XML identifiers must be unique', 'illustrator-model');
    layerNames.add(identifier);
    if (layer.opacity !== undefined) unitInterval(layer.opacity, 'layer opacity');
    if (layer.color !== undefined) {
      for (const component of layer.color) {
        if (!Number.isInteger(component) || component < 0 || component > 255) {
          throw new ValidationError('layer color channels must be bytes', 'illustrator-model');
        }
      }
    }
    items(layer.items, 0);
  }
};
