import type { Artboard, Coordinate, IllustratorDocument, Item, Paint, PathGeometry, PathItem, RasterItem, SpotColor } from '../model/illustratorDocument.ts';
import type { PreparedDocument } from '../model/prepareDocument.ts';
import type { ImageRegistry } from './imageRegistry.ts';
import type { ContentBuilder, PageOptions, PathBuilder, PdfDocument, PdfImage, PdfPage, PdfRect, Separation } from '@pdfwright/core';

import { UnsupportedFeatureError, add, cmyk, negate, pt, rect } from '@pdfwright/core';

import { artBounds } from '../geometry/bounds.ts';
import { coordinateNumber } from '../model/coordinateNumber.ts';
import { cubicSegments } from '../model/cubicSegments.ts';
import { validateDocument } from '../model/validateDocument.ts';

import { createImageRegistry } from './imageRegistry.ts';

interface PageResources {
  readonly document: PdfDocument;
  readonly separation: (spot: SpotColor) => Separation;
  readonly images: ImageRegistry;
  readonly bbox: PdfRect;
}

const length = (value: Coordinate) => (typeof value === 'number' ? pt(value) : value);
const number = coordinateNumber;

const bleedSides = (artboard: Artboard) => {
  const bleed = artboard.bleed ?? 0;
  return typeof bleed === 'number' || 'numerator' in bleed ? { top: bleed, right: bleed, bottom: bleed, left: bleed } : bleed;
};

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

// ISO 32000-1:2008, 8.5.2.1: each m begins a new subpath of the one current path, and h closes the subpath it ends.
const drawGeometry = (content: ContentBuilder, geometry: PathGeometry): void => {
  content.path((builder: PathBuilder) => {
    let path = builder;
    for (const subpath of geometry.subpaths) {
      path = path.moveTo(...subpath.start);
      for (const segment of cubicSegments(subpath)) {
        path = segment.kind === 'line' ? path.lineTo(...segment.to) : path.curveTo(...segment.control1, ...segment.control2, ...segment.to);
      }
      path = path.close();
    }
    return path;
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
  // ISO 32000-1:2008, 8.5.3.1, Table 60 and 8.5.3.3: f and B fill by the nonzero winding number rule, f* and B* by the even-odd rule; S strokes every subpath alike.
  const rule = item.geometry.fillRule ?? 'nonzero';
  if (item.fill === undefined) content.stroke();
  else if (item.stroke === undefined) content.fill(rule);
  else content.fillAndStroke(rule);
  content.restore();
};

const rasterImage = (item: RasterItem, resources: PageResources): PdfImage => {
  if (item.color.space === 'cmyk') {
    return resources.document.image({
      width: item.width,
      height: item.height,
      colorSpace: 'DeviceCMYK',
      bitsPerComponent: 8,
      samples: item.color.samples,
      softMask: { width: item.width, height: item.height, samples: item.alpha },
    });
  }
  if (item.color.samples === undefined) {
    return resources.document.image({
      width: item.width,
      height: item.height,
      colorSpace: resources.separation(item.color.spot),
      bitsPerComponent: 8,
      samples: resources.images.fullTint(item.width, item.height),
      softMask: { width: item.width, height: item.height, samples: item.alpha },
    });
  }
  return resources.document.image({
    width: item.width,
    height: item.height,
    colorSpace: resources.separation(item.color.spot),
    bitsPerComponent: 8,
    samples: item.color.samples,
    softMask: { width: item.width, height: item.height, samples: item.alpha },
  });
};

const drawRaster = (content: ContentBuilder, item: RasterItem, resources: PageResources): void => {
  content.save();
  const image = rasterImage(item, resources);
  content.image(image, [item.bounds.width, 0, 0, item.bounds.height, item.bounds.x, item.bounds.y]);
  content.restore();
};

const drawItem = (content: ContentBuilder, item: Item, resources: PageResources): void => {
  switch (item.kind) {
    case 'path': {
      drawPath(content, item, resources.separation);
      break;
    }
    case 'clipGroup': {
      content.save();
      drawGeometry(content, item.clip);
      // ISO 32000-1:2008, 8.5.4, Table 61: W intersects the clip with the area the nonzero rule encloses, W* with the area the even-odd rule encloses.
      content.clip(item.clip.fillRule ?? 'nonzero');
      for (const child of item.items) drawItem(content, child, resources);
      content.restore();
      break;
    }
    case 'raster': {
      drawRaster(content, item, resources);
      break;
    }
    case 'group': {
      const isolated = item.isolated === true;
      const options = isolated
        ? { bbox: resources.bbox, isolated: true, knockout: false, colorSpace: 'DeviceCMYK' as const }
        : { bbox: resources.bbox, isolated: false, knockout: false };
      const group = resources.document.group(options, groupContent => {
        for (const child of item.items) drawItem(groupContent, child, resources);
      });
      content.save();
      content.graphicsState({ fillAlpha: item.opacity ?? 1, strokeAlpha: item.opacity ?? 1 });
      content.group(group, [1, 0, 0, 1, 0, 0]);
      content.restore();
      break;
    }
    default: {
      throw new UnsupportedFeatureError('unknown Illustrator item kind');
    }
  }
};

/** Draws visible paths and clipping groups into a PDF 1.7 CMYK page. */
export const drawPage = (document: PdfDocument, model: IllustratorDocument, prepared?: PreparedDocument): PdfPage => {
  if (prepared === undefined) validateDocument(model);
  const { left, right, top, bottom } = bleedSides(model.artboard);
  const width = length(model.artboard.width);
  const height = length(model.artboard.height);
  const mediaWidth = add(add(length(left), width), length(right));
  const mediaHeight = add(add(length(bottom), height), length(top));
  const mediaBox = rect(pt(0), pt(0), mediaWidth, mediaHeight);
  const art = prepared?.bounds ?? artBounds(model);
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
  const bbox = rect(negate(length(left)), negate(length(bottom)), add(width, length(right)), add(height, length(top)));
  const resources: PageResources = { document, separation, images: createImageRegistry(), bbox };
  page.draw(content => {
    content.transform(1, 0, 0, 1, left, bottom);
    for (const layer of model.layers) {
      if (layer.visible === false) continue;
      if (layer.opacity === undefined || layer.opacity === 1) {
        for (const item of layer.items) drawItem(content, item, resources);
      } else {
        const group = document.group({ bbox, isolated: false, knockout: false }, groupContent => {
          for (const item of layer.items) drawItem(groupContent, item, resources);
        });
        content.save();
        content.graphicsState({ fillAlpha: layer.opacity, strokeAlpha: layer.opacity });
        content.group(group, [1, 0, 0, 1, 0, 0]);
        content.restore();
      }
    }
  });
  return page;
};
