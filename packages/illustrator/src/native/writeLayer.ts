import type { Item, Layer } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { escapeNativeString, escapeXmlIdentifier } from './nativeString.ts';
import { writeClipGroup, writeGroup } from './writeGroup.ts';
import { writePath } from './writePath.ts';
import { writeRaster } from './writeRaster.ts';

export interface NativeLayerOptions {
  readonly index: number;
  readonly yOffset?: number;
}

interface ItemPosition {
  readonly path: string;
  readonly yOffset: number;
  readonly lockState: { value: boolean };
}

const encoder = new TextEncoder();
const DEFAULT_COLORS = [
  [79, 128, 255],
  [255, 79, 79],
  [79, 255, 79],
  [79, 79, 255],
  [255, 79, 255],
] as const;

const writeItem = (writer: NativeWriter, item: Item, position: ItemPosition): void => {
  const locked = item.locked === true;
  if (position.lockState.value !== locked) {
    writer.line(locked ? '1 A' : '0 A');
    position.lockState.value = locked;
  }
  let childIndex = 0;
  const writeChild = (child: Item): void => {
    writeItem(writer, child, { path: `${position.path}/${String(childIndex)}`, yOffset: position.yOffset, lockState: position.lockState });
    childIndex++;
  };
  switch (item.kind) {
    case 'path': {
      writePath(writer, item, { yOffset: position.yOffset });
      break;
    }
    case 'raster': {
      writeRaster(writer, item, { itemPath: position.path, yOffset: position.yOffset });
      break;
    }
    case 'clipGroup': {
      writeClipGroup(writer, item, { writeItem: writeChild, yOffset: position.yOffset });
      break;
    }
    case 'group': {
      writeGroup(writer, item, { writeItem: writeChild, yOffset: position.yOffset });
      break;
    }
    default: {
      break;
    }
  }
};

/** Writes one native layer in paint order, including visibility, XMLUID and opacity. */
export const writeLayer = (writer: NativeWriter, layer: Layer, options: NativeLayerOptions): void => {
  const visible = layer.visible === false ? 0 : 1;
  const locked = layer.locked === true;
  const color = layer.color ?? DEFAULT_COLORS[options.index % DEFAULT_COLORS.length] ?? DEFAULT_COLORS[0];
  const [red, green, blue] = color;
  writer.line('%AI5_BeginLayer');
  writer.line(
    `${String(visible)} 1 ${locked ? '0' : '1'} 1 0 0 ${String(visible)} ${String(options.index)} ${String(red)} ${String(green)} ${String(blue)} 0 50 0 Lb`,
  );
  writer.line({ utf8: layer.name }, 'Ln');
  writer.line('0 AE');
  writer.line('%_/ArtDictionary :');
  writer.raw(encoder.encode('%_/XMLUID : '));
  writer.raw(escapeNativeString(escapeXmlIdentifier(layer.name)));
  writer.line(' ; (AI10_ArtUID) ,');
  writer.line('%_;');
  writer.line('%_');
  writer.line(locked ? '1 A' : '0 A');
  if (visible === 0) {
    writer.line('1 Xw');
    if (locked && layer.items.length > 0) writer.line('0 A');
  }
  writer.line('0 Xw');
  const lockState = { value: locked && (visible !== 0 || layer.items.length === 0) };
  for (const [index, item] of layer.items.entries()) {
    writeItem(writer, item, { path: `${String(options.index)}/${String(index)}`, yOffset: options.yOffset ?? 0, lockState });
  }
  if (layer.opacity !== undefined && layer.opacity !== 1) {
    writer.line(`0 ${formatNativeNumber(layer.opacity)} 0 2 0 Xy`);
    writer.line('0 0 Xd');
    writer.line('7 () XW');
  }
  writer.line('LB');
  writer.line('%AI5_EndLayer--');
};
