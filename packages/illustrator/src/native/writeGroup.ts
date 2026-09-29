import type { ClipGroup, Group, Item } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';
import type { FillRuleState } from './writePath.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { fillRuleLine, writeNativeGeometry } from './writePath.ts';

export interface WriteGroupOptions {
  readonly writeItem: (item: Item) => void;
  readonly yOffset?: number;
  /** The fill rule the layer's native stream has selected before the clipping path; nonzero when omitted. */
  readonly fillRuleState?: FillRuleState;
}

/**
 * Writes a clipping group with its clipping path after the painted items.
 * A clipping path writes `XR` only when its fill rule differs from the one its layer last selected, as the clipping paths in Illustrator 30.8.2 saves carry no `XR`. A clip of several subpaths is a compound path whose members each end with `h W n`; those saves contain no compound clipping path, so this form is inferred from their compound paths.
 */
export const writeClipGroup = (writer: NativeWriter, group: ClipGroup, options: WriteGroupOptions): void => {
  const state = options.fillRuleState ?? { value: 'nonzero' };
  const rule = group.clip.fillRule ?? 'nonzero';
  writer.line('0 Ae');
  writer.line('q');
  for (const item of group.items) options.writeItem(item);
  const writeState = (): void => {
    if (state.value !== rule) writer.line(fillRuleLine(rule));
    state.value = rule;
  };
  writeNativeGeometry(writer, group.clip, { yOffset: options.yOffset ?? 0, writeState, ending: ['h', 'W', 'n'] });
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
