import type { Coordinate, IllustratorDocument, Item, Paint, PathGeometry, PathItem, Point, RasterItem, SpotColor } from './illustratorDocument.ts';

import { UnsupportedFeatureError, ValidationError } from '@pdfwright/core';

const coordinate = (value: Coordinate): number => {
  const number = typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(number)) throw new ValidationError('coordinate must be finite');
  if (typeof value !== 'number' && value.denominator <= 0n) throw new ValidationError('length denominator must be positive');
  return number;
};

const unitInterval = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new ValidationError(`${name} must be between 0 and 1`);
};

const nativeName = (value: string, name: string): void => {
  if (value.length === 0) throw new ValidationError(`${name} cannot be empty`);
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) throw new ValidationError(`${name} cannot contain control characters`);
  }
};

const spotKey = (spot: SpotColor): string => [...(spot.nameBytes ?? new TextEncoder().encode(spot.name))].join(',');

const validateHeader = (document: IllustratorDocument): void => {
  if (document.artboard.name !== undefined) nativeName(document.artboard.name, 'artboard name');
  if (document.title !== undefined) {
    for (const character of document.title) {
      const code = character.codePointAt(0);
      if (code === undefined || code < 32 || code > 126) throw new ValidationError('title requires printable ASCII');
    }
  }
  const { bleed } = document.artboard;
  if (bleed !== undefined) {
    const sides = typeof bleed === 'number' || 'numerator' in bleed ? [bleed] : [bleed.top, bleed.right, bleed.bottom, bleed.left];
    for (const side of sides) {
      if (coordinate(side) < 0) throw new ValidationError('bleed cannot be negative');
    }
  }
};

/** Validates every model value before any output is emitted. */
export const validateDocument = (document: IllustratorDocument): void => {
  const width = coordinate(document.artboard.width);
  const height = coordinate(document.artboard.height);
  if (width <= 0 || height <= 0 || width > 16383 || height > 16383) throw new ValidationError('artboard dimensions must be in (0, 16383] points');
  validateHeader(document);

  const rulerX = Math.floor(8191.5 - width / 2);
  const rulerY = Math.floor(8191.5 - height / 2);
  const point = (value: Point): void => {
    const x = coordinate(value[0]);
    const y = coordinate(value[1]);
    if (x < -rulerX || x > 16383 - rulerX || y < -rulerY || y > 16383 - rulerY) {
      throw new ValidationError('native coordinate lies outside the Illustrator canvas');
    }
  };
  const positive = (value: Coordinate, name: string): number => {
    const number = coordinate(value);
    if (number < 0) throw new ValidationError(`${name} cannot be negative`);
    return number;
  };
  const spots = new Map<string, SpotColor>();
  const checkSpot = (spot: SpotColor): void => {
    nativeName(spot.name, 'spot name');
    if (spot.nameBytes?.length === 0) throw new ValidationError('spot name bytes cannot be empty');
    for (const component of spot.alternate) unitInterval(component, 'spot alternate');
    const key = spotKey(spot);
    const earlier = spots.get(key);
    if (earlier !== undefined && (earlier.name !== spot.name || earlier.alternate.some((component, index) => component !== spot.alternate[index]))) {
      throw new ValidationError('spot colorant bytes have conflicting definitions');
    }
    spots.set(key, spot);
  };
  const checkPaint = (paint: Paint): void => {
    if (paint.kind === 'process') {
      for (const component of paint.cmyk) unitInterval(component, 'CMYK component');
    } else {
      checkSpot(paint.spot);
      if (paint.tint !== undefined) unitInterval(paint.tint, 'spot tint');
    }
  };
  const geometry = (value: PathGeometry): void => {
    point(value.start);
    for (const segment of value.segments) {
      point(segment.to);
      if (segment.kind === 'curve') {
        point(segment.control1);
        point(segment.control2);
      }
    }
  };
  const checkPath = (item: PathItem): void => {
    geometry(item.geometry);
    if (item.fill === undefined && item.stroke === undefined) throw new ValidationError('path requires a fill or stroke');
    if (item.fill !== undefined) checkPaint(item.fill.paint);
    if (item.stroke !== undefined) {
      checkPaint(item.stroke.paint);
      positive(item.stroke.width, 'stroke width');
    }
  };
  const checkRaster = (item: RasterItem): void => {
    if (!Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) || item.width <= 0 || item.height <= 0) {
      throw new ValidationError('raster dimensions must be positive integers');
    }
    const pixels = item.width * item.height;
    if (!Number.isSafeInteger(pixels)) throw new ValidationError('raster pixel count is too large');
    const x = coordinate(item.bounds.x);
    const y = coordinate(item.bounds.y);
    const rasterWidth = positive(item.bounds.width, 'raster width');
    const rasterHeight = positive(item.bounds.height, 'raster height');
    if (rasterWidth === 0 || rasterHeight === 0) throw new ValidationError('raster placement must have positive size');
    point([x, y]);
    point([x + rasterWidth, y + rasterHeight]);
    if (item.alpha.length !== pixels) throw new ValidationError('raster alpha length does not match dimensions');
    if (item.color.space === 'cmyk') {
      if (item.color.samples.length !== pixels * 4) throw new ValidationError('CMYK sample length does not match dimensions');
    } else {
      checkSpot(item.color.spot);
      if (item.color.samples !== undefined && item.color.samples.length !== pixels) {
        throw new ValidationError('spot sample length does not match dimensions');
      }
    }
  };
  const items = (values: readonly Item[]): void => {
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
          if (item.items.length === 0) throw new ValidationError('clip group cannot be empty');
          geometry(item.clip);
          items(item.items);
          break;
        }
        case 'group': {
          if (item.items.length === 0) throw new ValidationError('group cannot be empty');
          if (item.opacity !== undefined) unitInterval(item.opacity, 'group opacity');
          items(item.items);
          break;
        }
        default: {
          throw new ValidationError('unknown item kind');
        }
      }
    }
  };

  const layerNames = new Set<string>();
  for (const layer of document.layers) {
    nativeName(layer.name, 'layer name');
    if (layerNames.has(layer.name)) throw new ValidationError('layer names must be unique');
    layerNames.add(layer.name);
    if (layer.locked === true) throw new UnsupportedFeatureError('locked layers are not supported by the observed native format');
    if (layer.opacity !== undefined) unitInterval(layer.opacity, 'layer opacity');
    if (layer.color !== undefined) {
      for (const component of layer.color) {
        if (!Number.isInteger(component) || component < 0 || component > 255) throw new ValidationError('layer color channels must be bytes');
      }
    }
    items(layer.items);
  }
};
