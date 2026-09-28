import type { Artboard, Coordinate, IllustratorDocument, Item, Paint, PathGeometry, PathItem, SpotColor } from '../model/illustratorDocument.ts';
import type { ContentBuilder, PageOptions, PathBuilder, PdfDocument, PdfPage, Separation } from '@pdfwright/core';

import { UnsupportedFeatureError, add, cmyk, pt, rect } from '@pdfwright/core';

import { artBounds } from '../geometry/bounds.ts';
import { validateDocument } from '../model/validateDocument.ts';

const length = (value: Coordinate) => (typeof value === 'number' ? pt(value) : value);
const number = (value: Coordinate): number => (typeof value === 'number' ? value : Number(value.numerator) / Number(value.denominator));

const bleedSides = (artboard: Artboard) => {
  const bleed = artboard.bleed ?? 0;
  return typeof bleed === 'number' || 'numerator' in bleed ? { top: bleed, right: bleed, bottom: bleed, left: bleed } : bleed;
};

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const drawGeometry = (content: ContentBuilder, geometry: PathGeometry): void => {
  content.path((builder: PathBuilder) => {
    let path = builder.moveTo(...geometry.start);
    for (const segment of geometry.segments) {
      path = segment.kind === 'line' ? path.lineTo(...segment.to) : path.curveTo(...segment.control1, ...segment.control2, ...segment.to);
    }
    return path.close();
  });
};

const drawPath = (content: ContentBuilder, item: PathItem, separation: (spot: SpotColor) => Separation): void => {
  const setPaint = (paint: Paint, channel: 'fill' | 'stroke'): void => {
    const color = paint.kind === 'process' ? cmyk(...paint.cmyk) : separation(paint.spot);
    const tint = paint.kind === 'spot' ? (paint.tint ?? 1) : undefined;
    if (channel === 'fill') {
      if (tint === undefined) content.fillColor(color);
      else content.fillColor(color, tint);
    } else if (tint === undefined) content.strokeColor(color);
    else content.strokeColor(color, tint);
  };
  content.save();
  content.graphicsState({ overprintFill: item.fill?.overprint ?? false, overprintStroke: item.stroke?.overprint ?? false, overprintMode: 1 });
  if (item.fill !== undefined) setPaint(item.fill.paint, 'fill');
  if (item.stroke !== undefined) {
    setPaint(item.stroke.paint, 'stroke');
    content.lineWidth(item.stroke.width);
  }
  drawGeometry(content, item.geometry);
  if (item.fill === undefined) content.stroke();
  else if (item.stroke === undefined) content.fill('nonzero');
  else content.fillAndStroke('nonzero');
  content.restore();
};

const drawItem = (content: ContentBuilder, item: Item, separation: (spot: SpotColor) => Separation): void => {
  switch (item.kind) {
    case 'path': {
      drawPath(content, item, separation);
      break;
    }
    case 'clipGroup': {
      content.save();
      drawGeometry(content, item.clip);
      content.clip('nonzero');
      for (const child of item.items) drawItem(content, child, separation);
      content.restore();
      break;
    }
    case 'raster':
    case 'group': {
      throw new UnsupportedFeatureError('visible raster and transparency-group drawing is not available yet');
    }
    default: {
      throw new UnsupportedFeatureError('unknown Illustrator item kind');
    }
  }
};

/** Draws visible paths and clipping groups into a PDF 1.7 CMYK page. */
export const drawPage = (document: PdfDocument, model: IllustratorDocument): PdfPage => {
  validateDocument(model);
  const { left, right, top, bottom } = bleedSides(model.artboard);
  const width = length(model.artboard.width);
  const height = length(model.artboard.height);
  const mediaWidth = add(add(length(left), width), length(right));
  const mediaHeight = add(add(length(bottom), height), length(top));
  const mediaBox = rect(pt(0), pt(0), mediaWidth, mediaHeight);
  const art = artBounds(model);
  const x0 = Math.max(0, number(left) + art.minX);
  const y0 = Math.max(0, number(bottom) + art.minY);
  const x1 = Math.min(number(mediaWidth), number(left) + art.maxX);
  const y1 = Math.min(number(mediaHeight), number(bottom) + art.maxY);
  const options: PageOptions = {
    mediaBox,
    cropBox: mediaBox,
    bleedBox: mediaBox,
    trimBox: rect(length(left), length(bottom), add(length(left), width), add(length(bottom), height)),
    group: { colorSpace: 'DeviceCMYK' },
  };
  if (x1 > x0 && y1 > y0) options.artBox = rect(pt(x0), pt(y0), pt(x1), pt(y1));
  const page = document.addPage(options);
  const spots = new Map<string, Separation>();
  const separation = (spot: SpotColor): Separation => {
    const name = spot.nameBytes ?? new TextEncoder().encode(spot.name);
    const key = hex(name);
    let value = spots.get(key);
    if (value === undefined) {
      value = document.separation({ name, alternate: cmyk(...spot.alternate) });
      spots.set(key, value);
    }
    return value;
  };
  page.draw(content => {
    content.transform(1, 0, 0, 1, left, bottom);
    for (const layer of model.layers) {
      if (layer.visible === false) continue;
      for (const item of layer.items) drawItem(content, item, separation);
    }
  });
  return page;
};
