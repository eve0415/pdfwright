import type { ColorSource, ColorTransform } from '../color/createColorTransform.ts';
import type { ContentOperand, SpannedContentOperation } from '../content/contentOperations.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { SourceSpace } from './sourceSpace.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { createColorTransform } from '../color/createColorTransform.ts';
import { readContentSpans } from '../content/contentOperations.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { DEFAULT_FRACTION_DIGITS, formatNumber } from '../number/formatNumber.ts';
import { pdfName } from '../object/pdfObject.ts';

import { resolveSourceSpace } from './sourceSpace.ts';

export interface RewriteColorOptions {
  readonly sourceRgbProfile: IccProfile;
  readonly outputProfile: IccProfile;
  readonly intent?: 'document' | RenderingIntent;
  readonly blackPointCompensation?: boolean;
  readonly pureBlack?: 'k-only' | 'convert';
  readonly iccGray?: 'convert' | 'keep';
  readonly deviceGray?: 'keep' | 'promote-to-cmyk';
  readonly lut8LabEncoding?: 'icc' | 'adobe';
}

export interface RewrittenContent {
  readonly bytes: Uint8Array;
  readonly operators: number;
  readonly kOnly: number;
}

interface PaintState {
  readonly fill: SourceSpace;
  readonly stroke: SourceSpace;
  readonly intent: RenderingIntent;
}

interface RewriteContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
  readonly transforms: Map<string, ColorTransform>;
  kOnly: number;
  state: PaintState;
  readonly stack: PaintState[];
}

const EXT_G_STATE = pdfName('ExtGState').bytes;
const RENDERING_INTENT = pdfName('RI').bytes;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-operator');
};

const numberValue = (operand: ContentOperand): number | undefined => {
  if (operand.kind === 'integer') return operand.value;
  if (operand.kind === 'real' && typeof operand.value === 'number') return operand.value;
  return undefined;
};

const colorValues = (operands: readonly ContentOperand[], count: number): number[] => {
  if (operands.length !== count) return invalid(`colour operator requires ${String(count)} components`);
  const values = operands.map(operand => numberValue(operand));
  if (values.some(value => value === undefined)) return invalid('colour operator has a nonnumeric component');
  return values.map(value => value ?? 0);
};

const nameBytes = (operand: ContentOperand | undefined): Uint8Array => {
  if (operand?.kind !== 'name') return invalid('colour operator requires a name');
  return operand.bytes;
};

const nameText = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const intentOf = (bytes: Uint8Array): RenderingIntent => {
  const name = nameText(bytes);
  if (name === 'Perceptual') return 'perceptual';
  if (name === 'Saturation') return 'saturation';
  if (name === 'AbsoluteColorimetric') return 'absoluteColorimetric';
  // ISO 32000-1:2008, 8.6.5.8: an unrecognised intent defaults to RelativeColorimetric.
  return 'relativeColorimetric';
};

const deref = (context: RewriteContext, value: PdfDirectObject | undefined): PdfDirectObject | undefined => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const found = internals.objects.deref(value);
  return found?.kind === 'stream' ? undefined : found;
};

const gsIntent = (context: RewriteContext, name: Uint8Array): RenderingIntent | undefined => {
  const category = deref(context, context.resources.get(EXT_G_STATE));
  if (category?.kind !== 'dictionary') return undefined;
  const state = deref(context, category.entries.get(name));
  if (state?.kind !== 'dictionary') return undefined;
  const intent = deref(context, state.entries.get(RENDERING_INTENT));
  return intent?.kind === 'name' ? intentOf(intent.bytes) : undefined;
};

const keyFor = (source: ColorSource, intent: RenderingIntent, options: RewriteColorOptions): string => {
  const identity = source.kind === 'icc' ? [...source.profile.identity].map(byte => byte.toString(16).padStart(2, '0')).join('') : JSON.stringify(source);
  return `${identity}:${intent}:${String(options.blackPointCompensation !== false)}:${options.lut8LabEncoding ?? 'icc'}`;
};

const transformFor = (context: RewriteContext, source: ColorSource): ColorTransform => {
  const intent = context.options.intent === undefined || context.options.intent === 'document' ? context.state.intent : context.options.intent;
  const key = keyFor(source, intent, context.options);
  const cached = context.transforms.get(key);
  if (cached !== undefined) return cached;
  const transform = createColorTransform(source, context.options.outputProfile, {
    intent,
    blackPointCompensation: context.options.blackPointCompensation !== false,
    lut8LabEncoding: context.options.lut8LabEncoding ?? 'icc',
  });
  context.transforms.set(key, transform);
  return transform;
};

const deviceCmyk = (context: RewriteContext, source: ColorSource, values: readonly number[]): number[] => {
  if (context.options.pureBlack !== 'convert' && values.every(value => value === 0)) {
    context.kOnly++;
    return [0, 0, 0, 1];
  }
  const output = new Float64Array(4);
  transformFor(context, source).convert(Float64Array.from(values), output);
  return [...output];
};

const formatted = (values: readonly number[], operator: string): string =>
  `${values.map(value => formatNumber(value, DEFAULT_FRACTION_DIGITS)).join(' ')} ${operator}`;

const setSpace = (context: RewriteContext, stroke: boolean, space: SourceSpace): void => {
  context.state = stroke ? { ...context.state, stroke: space } : { ...context.state, fill: space };
};

const selectedSpace = (context: RewriteContext, stroke: boolean): SourceSpace => (stroke ? context.state.stroke : context.state.fill);

const sourceFor = (context: RewriteContext, value: PdfDirectObject): SourceSpace =>
  resolveSourceSpace(context.document, value, {
    resources: context.resources,
    sourceRgbProfile: context.options.sourceRgbProfile,
    options: { iccGray: context.options.iccGray ?? 'convert' },
  });

const setColorSpace = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  const stroke = operation.operator === 'CS';
  const space = sourceFor(context, { kind: 'name', bytes: nameBytes(operation.operands[0]) });
  setSpace(context, stroke, space);
  if (space.kind === 'rgb' || space.kind === 'gray') {
    // ISO 32000-1:2008, 8.6.8 Table 74: CS/cs also sets the space's initial colour.
    const selected = `/DeviceCMYK ${operation.operator}`;
    if (context.options.pureBlack !== 'convert') return selected;
    const initial = space.kind === 'rgb' ? [0, 0, 0] : [0];
    return `${selected}\n${formatted(deviceCmyk(context, space.source, initial), stroke ? 'SC' : 'sc')}`;
  }
  if (space.kind === 'deviceGray' && context.options.deviceGray === 'promote-to-cmyk') return `/DeviceCMYK ${operation.operator}`;
  return undefined;
};

const setComponents = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  const space = selectedSpace(context, operation.operator === operation.operator.toUpperCase());
  if (space.kind === 'rgb' || space.kind === 'gray') {
    const values = colorValues(operation.operands, space.kind === 'rgb' ? 3 : 1);
    return formatted(deviceCmyk(context, space.source, values), operation.operator);
  }
  if (space.kind === 'deviceGray' && context.options.deviceGray === 'promote-to-cmyk') {
    const value = colorValues(operation.operands, 1)[0] ?? 0;
    return formatted([0, 0, 0, 1 - value], operation.operator);
  }
  return undefined;
};

const directRgb = (context: RewriteContext, operation: SpannedContentOperation): string => {
  const stroke = operation.operator === 'RG';
  const space = sourceFor(context, pdfName('DeviceRGB'));
  if (space.kind !== 'rgb') return invalid('DefaultRGB is not an RGB colour space');
  setSpace(context, stroke, space);
  const values = colorValues(operation.operands, 3);
  return formatted(deviceCmyk(context, space.source, values), stroke ? 'K' : 'k');
};

const directGray = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  setSpace(context, operation.operator === 'G', { kind: 'deviceGray' });
  if (context.options.deviceGray !== 'promote-to-cmyk') return undefined;
  const gray = colorValues(operation.operands, 1)[0] ?? 0;
  return formatted([0, 0, 0, 1 - gray], operation.operator === 'G' ? 'K' : 'k');
};

const updateGraphicsState = (context: RewriteContext, operation: SpannedContentOperation): void => {
  const { operator } = operation;
  if (operator === 'q') {
    context.stack.push(context.state);
    return;
  }
  if (operator === 'Q') {
    const saved = context.stack.pop();
    if (saved === undefined) return invalid('unbalanced graphics state in page content');
    context.state = saved;
    return;
  }
  if (operator === 'ri') {
    context.state = { ...context.state, intent: intentOf(nameBytes(operation.operands[0])) };
    return;
  }
  if (operator === 'gs') {
    const intent = gsIntent(context, nameBytes(operation.operands[0]));
    if (intent !== undefined) context.state = { ...context.state, intent };
  }
};

const rewriteOperation = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  const { operator } = operation;
  if (operator === 'q' || operator === 'Q' || operator === 'ri' || operator === 'gs') {
    updateGraphicsState(context, operation);
    return undefined;
  }
  if (operator === 'rg' || operator === 'RG') return directRgb(context, operation);
  if (operator === 'g' || operator === 'G') return directGray(context, operation);
  if (operator === 'k' || operator === 'K') {
    setSpace(context, operator === 'K', { kind: 'untouched' });
    return undefined;
  }
  if (operator === 'cs' || operator === 'CS') return setColorSpace(context, operation);
  if (operator === 'sc' || operator === 'SC' || operator === 'scn' || operator === 'SCN') return setComponents(context, operation);
  if (operator === 'BI' && operation.inlineImage === undefined) throw new UnsupportedFeatureError('malformed inline image cannot be converted');
  return undefined;
};

/** Rewrites only colour-setting operations; all other bytes are copied directly from the source stream. */
export const rewriteContentColors = (
  document: LoadedDocument,
  bytes: Uint8Array,
  config: { resources: PdfDictionaryEntries; options: RewriteColorOptions },
): RewrittenContent => {
  const context: RewriteContext = {
    document,
    resources: config.resources,
    options: config.options,
    transforms: new Map(),
    kOnly: 0,
    state: { fill: { kind: 'deviceGray' }, stroke: { kind: 'deviceGray' }, intent: 'relativeColorimetric' },
    stack: [],
  };
  const writer = new ByteWriter();
  let cursor = 0;
  let operators = 0;
  for (const operation of readContentSpans(bytes, 256)) {
    const replacement = rewriteOperation(context, operation);
    if (replacement === undefined) continue;
    writer.writeBytes(bytes.subarray(cursor, operation.start));
    writer.writeAscii(replacement);
    cursor = operation.end;
    operators++;
  }
  if (operators === 0) return { bytes, operators, kOnly: context.kOnly };
  writer.writeBytes(bytes.subarray(cursor));
  return { bytes: writer.toUint8Array(), operators, kOnly: context.kOnly };
};
