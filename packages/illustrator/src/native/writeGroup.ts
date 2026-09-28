import type { ClipGroup, Group, Item } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { anchorCount, writePathGeometry } from './writePath.ts';

export interface WriteGroupOptions {
  readonly writeItem: (item: Item) => void;
  readonly yOffset?: number;
}

/** Writes a clipping group with its clipping path after the painted items. */
export const writeClipGroup = (writer: NativeWriter, group: ClipGroup, options: WriteGroupOptions): void => {
  const yOffset = options.yOffset ?? 0;
  writer.line('0 Ae');
  writer.line('q');
  for (const item of group.items) options.writeItem(item);
  writer.line(`${String(anchorCount(group.clip, yOffset))} As`);
  writePathGeometry(writer, group.clip, yOffset);
  writer.line('h');
  writer.line('W');
  writer.line('n');
  writer.line('Q');
  writer.line('9 () XW');
};

/** Writes an ordinary group and its observed transparency trailer when non-default. */
export const writeGroup = (writer: NativeWriter, group: Group, options: WriteGroupOptions): void => {
  writer.line('0 Ae');
  writer.line('u');
  for (const item of group.items) options.writeItem(item);
  writer.line('U');
  const opacity = group.opacity ?? 1;
  if (opacity !== 1 || group.isolated === true) {
    writer.line(`0 ${formatNativeNumber(opacity)} ${group.isolated === true ? '1' : '0'} 0 0 Xy`);
    writer.line('0 0 Xd');
    writer.line('6 () XW');
  }
};
