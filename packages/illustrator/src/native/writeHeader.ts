import type { IllustratorDocument, Item, Paint, SpotColor } from '../model/illustratorDocument.ts';
import type { PreparedDocument } from '../model/prepareDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { InvalidArgumentError, add, formatInteger, multiply, pt, subtract } from '@pdfwright/core';

import { artBounds, integerBounds } from '../geometry/bounds.ts';
import { coordinateNumber } from '../model/coordinateNumber.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { escapeNativeString } from './nativeString.ts';

export interface HeaderOptions {
  readonly creator?: string;
  readonly convention?: 'bottom-left' | 'top-left';
  readonly prepared?: PreparedDocument;
}

export interface DocumentColors {
  readonly spots: readonly SpotColor[];
  readonly process: readonly string[];
}

const encoder = new TextEncoder();
const PROCESS_PLATES = ['Cyan', 'Magenta', 'Yellow', 'Black'] as const;
const number = coordinateNumber;

const byteCompare = (left: string, right: string): number => {
  const first = encoder.encode(left);
  const second = encoder.encode(right);
  for (let index = 0; index < Math.min(first.length, second.length); index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return first.length - second.length;
};

export const documentColors = (document: IllustratorDocument): DocumentColors => {
  const spots = new Map<string, SpotColor>();
  const used = new Set<string>();
  const paint = (value: Paint, visible: boolean): void => {
    if (value.kind === 'spot') {
      spots.set(value.spot.name, value.spot);
    } else if (visible) {
      for (const [index, component] of value.cmyk.entries()) {
        if (component > 0) used.add(PROCESS_PLATES[index] ?? '');
      }
    }
  };
  const scanRaster = (samples: Uint8Array): void => {
    for (let index = 0; index < samples.length; index++) {
      if ((samples[index] ?? 0) > 0) used.add(PROCESS_PLATES[index % 4] ?? '');
    }
  };
  const visit = (items: readonly Item[], visible: boolean): void => {
    for (const item of items) {
      switch (item.kind) {
        case 'path': {
          if (item.fill !== undefined) paint(item.fill.paint, visible);
          if (item.stroke !== undefined) paint(item.stroke.paint, visible);
          break;
        }
        case 'raster': {
          if (item.color.space === 'spot') spots.set(item.color.spot.name, item.color.spot);
          else if (visible) scanRaster(item.color.samples);
          break;
        }
        case 'clipGroup':
        case 'group': {
          visit(item.items, visible);
          break;
        }
        default: {
          break;
        }
      }
    }
  };
  for (const layer of document.layers) visit(layer.items, layer.visible !== false);
  return { spots: [...spots.values()].toSorted((left, right) => byteCompare(left.name, right.name)), process: PROCESS_PLATES.filter(name => used.has(name)) };
};

const postScriptComment = (writer: NativeWriter, prefix: string, value: string): void => {
  writer.raw(encoder.encode(prefix));
  writer.raw(escapeNativeString(value));
  writer.line();
};

const writeSpotComments = (writer: NativeWriter, spots: readonly SpotColor[]): void => {
  for (const [index, spot] of spots.entries()) {
    postScriptComment(writer, index === 0 ? '%%DocumentCustomColors: ' : '%%+ ', spot.name);
  }
  for (const [index, spot] of spots.entries()) {
    const prefix = index === 0 ? '%%CMYKCustomColor: ' : '%%+ ';
    postScriptComment(writer, `${prefix}${spot.alternate.map(component => formatNativeNumber(component)).join(' ')} `, spot.name);
  }
};

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

const headerData = (document: IllustratorDocument, prepared: PreparedDocument | undefined): PreparedDocument =>
  prepared ?? { bounds: artBounds(document), colors: documentColors(document) };

/** Writes the native header through `%%EndComments` and returns its byte length for `/AIMetaData`. */
export const writeHeader = (writer: NativeWriter, document: IllustratorDocument, options: HeaderOptions = {}): number => {
  const { bounds: art, colors } = headerData(document, options.prepared);
  const width = number(document.artboard.width);
  const height = number(document.artboard.height);
  const creator = options.creator ?? '@pdfwright/illustrator';
  for (const character of creator) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 32 || code > 126) throw new InvalidArgumentError('creator requires printable ASCII');
  }
  const topLeft = options.convention === 'top-left';
  const rulerX = topLeft ? 8191.5 - width / 2 : Math.floor(8191.5 - width / 2);
  const rulerY = topLeft ? 8191.5 + height / 2 : Math.floor(8191.5 - height / 2);
  const shifted = topLeft ? { minX: art.minX, minY: art.minY - height, maxX: art.maxX, maxY: art.maxY - height } : art;
  const [minX, minY, maxX, maxY] = integerBounds(shifted);
  writer.line('%!PS-Adobe-3.0 ');
  writer.line(`%%Creator: ${creator}`);
  writer.line('%%AI8_CreatorVersion: 30.8.2');
  writer.line('%%For: () ()');
  writer.raw(encoder.encode('%%Title: '));
  writer.raw(escapeNativeString(document.title ?? '', 'ascii'));
  writer.line();
  const { year, month, day, hour, minute } = document.lastModified;
  writer.line(`%%CreationDate: ${pad(year, 4)}/${pad(month, 2)}/${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}`);
  writer.line('%%Canvassize: 16383');
  writer.line(`%%BoundingBox: ${String(minX)} ${String(minY)} ${String(maxX)} ${String(maxY)}`);
  writer.line(`%%HiResBoundingBox: ${[shifted.minX, shifted.minY, shifted.maxX, shifted.maxY].map(value => formatNativeNumber(value)).join(' ')}`);
  const { spots, process } = colors;
  if (process.length > 0) writer.line(`%%DocumentProcessColors: ${process.join(' ')}`);
  writer.line('%AI5_FileFormat 14.0');
  writer.line('%AI12_BuildNumber: 7');
  writer.line('%AI3_ColorUsage: Color');
  writer.line('%AI7_ImageSettings: 0');
  writeSpotComments(writer, spots);
  writer.line(`%AI3_Cropmarks: 0 ${topLeft ? formatNativeNumber(-height) : '0'} ${formatNativeNumber(width)} ${topLeft ? '0' : formatNativeNumber(height)}`);
  const templateX = 8191.5 - rulerX;
  const templateY = topLeft ? rulerY - 8191.5 : rulerY + height - 8191.5;
  writer.line(
    `%AI3_TemplateBox: ${formatNativeNumber(templateX)} ${formatNativeNumber(templateY)} ${formatNativeNumber(templateX)} ${formatNativeNumber(templateY)}`,
  );
  const roundedWidth = pt(Number(formatNativeNumber(document.artboard.width)));
  const roundedHeight = pt(Number(formatNativeNumber(document.artboard.height)));
  const halfWidth = multiply(roundedWidth, 0.5);
  const halfHeight = multiply(roundedHeight, 0.5);
  const tileBottom = subtract(halfHeight, pt(279.5));
  const tileTop = add(halfHeight, pt(279.5));
  const tile = [
    subtract(halfWidth, pt(403)),
    topLeft ? subtract(tileBottom, roundedHeight) : tileBottom,
    add(halfWidth, pt(380)),
    topLeft ? subtract(tileTop, roundedHeight) : tileTop,
  ];
  writer.line(`%AI3_TileBox: ${tile.map(value => formatNativeNumber(value)).join(' ')}`);
  writer.line('%AI3_DocumentPreview: None');
  writer.line('%AI5_ArtSize: 14400 14400');
  writer.line('%AI5_RulerUnits: 1');
  writer.line('%AI24_LargeCanvasScale: 1');
  writer.line('%AI9_ColorModel: 2');
  writer.line('%AI5_ArtFlags: 0 0 0 1 0 0 1 0 0');
  writer.line('%AI5_TargetResolution: 800');
  writer.line(`%AI5_NumLayers: ${formatInteger(document.layers.length)}`);
  const viewLeft = Math.round(width / 2 - 954);
  const viewTop = Math.round((topLeft ? -height : height) / 2 + 474);
  const viewPrefix = `${String(viewLeft)} ${String(viewTop)} 1`;
  writer.line('%AI17_Begin_Content_if_version_gt:24 4');
  writer.line(`%AI10_OpenToVie: ${viewPrefix} 0 0 0 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1`);
  writer.line('%AI17_Alternate_Content');
  writer.line(`%AI9_OpenToView: ${viewPrefix} 1908 1024 26 0 0 1926 50 0 0 0 1 1 0 1 1 0 1`);
  writer.line('%AI17_End_Versioned_Content');
  writer.line(
    `%AI5_OpenViewLayers: ${document.layers
      .toReversed()
      .map(layer => (layer.visible === false ? '6' : '7'))
      .join('')}`,
  );
  writer.line('%AI17_Begin_Content_if_version_gt:24 4');
  writer.line('%AI17_Alternate_Content');
  writer.line('%AI17_End_Versioned_Content');
  writer.line(`%%PageOrigin:0 ${topLeft ? '0' : formatNativeNumber(height)}`);
  writer.line('%AI7_GridSettings: 72 8 72 8 0 0 0.8 0.8 0.8 0.9 0.9 0.9');
  writer.line('%AI9_Flatten: 1');
  writer.line('%AI12_CMSettings: 00.MS');
  writer.line('%%EndComments');
  return writer.offset;
};
