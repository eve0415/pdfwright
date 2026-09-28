import type { ContentOperand, SpannedContentOperation } from '../content/contentOperations.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { readContentSpans } from '../content/contentOperations.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { DEFAULT_FRACTION_DIGITS, formatNumber } from '../number/formatNumber.ts';

interface ColourState {
  readonly fillRgb: boolean;
  readonly strokeRgb: boolean;
}

const component = (operand: ContentOperand | undefined): number => {
  if (operand?.kind === 'integer') return operand.value;
  if (operand?.kind === 'real' && typeof operand.value === 'number') return operand.value;
  throw new ValidationError('luminosity colour component is not numeric', 'color-operator');
};

// ISO 32000-1:2008, 10.3.2: DeviceRGB to gray uses 0.3 R + 0.59 G + 0.11 B.
export const deviceRgbLuminosity = (values: readonly number[]): number => 0.3 * (values[0] ?? 0) + 0.59 * (values[1] ?? 0) + 0.11 * (values[2] ?? 0);

const rgb = (operands: readonly ContentOperand[]): number[] => {
  if (operands.length !== 3) throw new ValidationError('luminosity RGB paint needs three components', 'color-operator');
  return operands.map(operand => component(operand));
};

const name = (operand: ContentOperand | undefined): string => {
  if (operand?.kind !== 'name') throw new ValidationError('luminosity colour space is not a name', 'color-operator');
  return new TextDecoder('latin1').decode(operand.bytes);
};

interface OperationRewrite {
  readonly state: ColourState;
  readonly replacement: string | undefined;
}

const rewriteNamedSpace = (operation: SpannedContentOperation, state: ColourState): OperationRewrite => {
  const family = name(operation.operands[0]);
  if (family === 'DeviceRGB' || family === 'RGB') {
    const stroke = operation.operator === 'CS';
    return { state: stroke ? { ...state, strokeRgb: true } : { ...state, fillRgb: true }, replacement: `/DeviceGray ${operation.operator}` };
  }
  if (family === 'DeviceGray' || family === 'G') {
    return { state: operation.operator === 'CS' ? { ...state, strokeRgb: false } : { ...state, fillRgb: false }, replacement: undefined };
  }
  throw new UnsupportedFeatureError('luminosity mask contains another colour space');
};

const rewriteSample = (operation: SpannedContentOperation, state: ColourState): OperationRewrite => {
  const { operator } = operation;
  const selected = operator === operator.toUpperCase() ? state.strokeRgb : state.fillRgb;
  const grayOperator = operator === operator.toUpperCase() ? 'G' : 'g';
  return {
    state,
    replacement: selected ? `${formatNumber(deviceRgbLuminosity(rgb(operation.operands)), DEFAULT_FRACTION_DIGITS)} ${grayOperator}` : undefined,
  };
};

const rewriteOperation = (operation: SpannedContentOperation, state: ColourState): OperationRewrite => {
  const { operator } = operation;
  if (operator === 'rg' || operator === 'RG') {
    const gray = deviceRgbLuminosity(rgb(operation.operands));
    const stroke = operator === 'RG';
    return {
      state: stroke ? { ...state, strokeRgb: true } : { ...state, fillRgb: true },
      replacement: `${formatNumber(gray, DEFAULT_FRACTION_DIGITS)} ${stroke ? 'G' : 'g'}`,
    };
  }
  if (operator === 'g' || operator === 'G') {
    return { state: operator === 'G' ? { ...state, strokeRgb: false } : { ...state, fillRgb: false }, replacement: undefined };
  }
  if (operator === 'cs' || operator === 'CS') return rewriteNamedSpace(operation, state);
  if (operator === 'sc' || operator === 'scn' || operator === 'SC' || operator === 'SCN') {
    return rewriteSample(operation, state);
  }
  if (operator === 'k' || operator === 'K' || operator === 'sh' || operator === 'Do' || operator === 'BI') {
    throw new UnsupportedFeatureError('luminosity mask contains unsupported coloured content');
  }
  return { state, replacement: undefined };
};

/** Rewrites a DeviceRGB luminosity group's colour operators to DeviceGray without changing its geometry. */
export const rewriteDeviceRgbLuminosity = (bytes: Uint8Array): Uint8Array => {
  let state: ColourState = { fillRgb: false, strokeRgb: false };
  const stack: ColourState[] = [];
  const edits: { start: number; end: number; text: string }[] = [];
  for (const operation of readContentSpans(bytes, 256)) {
    if (operation.operator === 'q') {
      stack.push(state);
      continue;
    }
    if (operation.operator === 'Q') {
      const restored = stack.pop();
      if (restored === undefined) throw new ValidationError('luminosity group has an unbalanced graphics state', 'color-operator');
      state = restored;
      continue;
    }
    const rewritten = rewriteOperation(operation, state);
    ({ state } = rewritten);
    if (rewritten.replacement !== undefined) edits.push({ start: operation.start, end: operation.end, text: rewritten.replacement });
  }
  if (edits.length === 0) return bytes;
  const writer = new ByteWriter();
  let position = 0;
  for (const edit of edits) {
    writer.writeBytes(bytes.subarray(position, edit.start));
    writer.writeAscii(edit.text);
    position = edit.end;
  }
  writer.writeBytes(bytes.subarray(position));
  return writer.toUint8Array();
};
