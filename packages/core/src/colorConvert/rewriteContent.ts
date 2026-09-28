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
  readonly overprintMode?: 'preserve-appearance' | 'refuse';
}

export interface RewrittenContent {
  readonly bytes: Uint8Array;
  readonly operators: number;
  readonly kOnly: number;
  readonly overprintAdjustments: number;
}

export interface OverprintNames {
  readonly off: string;
  readonly on: string;
}

interface PaintState {
  readonly fill: SourceSpace;
  readonly stroke: SourceSpace;
  readonly intent: RenderingIntent;
  readonly fillOverprint: boolean;
  readonly strokeOverprint: boolean;
  readonly overprintMode: number;
  readonly fillConvertedZero: boolean;
  readonly strokeConvertedZero: boolean;
  readonly textRenderMode: number;
}

interface ContentEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface RewriteContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly options: RewriteColorOptions;
  readonly transforms: Map<string, ColorTransform>;
  readonly edits: ContentEdit[];
  readonly overprintNames: OverprintNames | undefined;
  kOnly: number;
  overprintAdjustments: number;
  pathStart: number | undefined;
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

const gsEntries = (context: RewriteContext, name: Uint8Array): PdfDictionaryEntries | undefined => {
  const category = deref(context, context.resources.get(EXT_G_STATE));
  if (category?.kind !== 'dictionary') return undefined;
  const state = deref(context, category.entries.get(name));
  return state?.kind === 'dictionary' ? state.entries : undefined;
};

const updateOverprint = (context: RewriteContext, entries: PdfDictionaryEntries): void => {
  const fill = deref(context, entries.get(pdfName('op').bytes));
  const stroke = deref(context, entries.get(pdfName('OP').bytes));
  const mode = deref(context, entries.get(pdfName('OPM').bytes));
  // ISO 32000-1:2008, 8.4.5 Table 58: OP sets both flags when op is absent.
  let { fillOverprint } = context.state;
  if (stroke?.kind === 'boolean') fillOverprint = stroke.value;
  if (fill?.kind === 'boolean') fillOverprint = fill.value;
  context.state = {
    ...context.state,
    fillOverprint,
    strokeOverprint: stroke?.kind === 'boolean' ? stroke.value : context.state.strokeOverprint,
    overprintMode: mode?.kind === 'integer' ? mode.value : context.state.overprintMode,
  };
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
  context.state = stroke ? { ...context.state, stroke: space, strokeConvertedZero: false } : { ...context.state, fill: space, fillConvertedZero: false };
};

const setConvertedZero = (context: RewriteContext, stroke: boolean, values: readonly number[]): void => {
  const zero = values.some(value => value === 0);
  context.state = stroke ? { ...context.state, strokeConvertedZero: zero } : { ...context.state, fillConvertedZero: zero };
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
    if (context.options.pureBlack !== 'convert') {
      setConvertedZero(context, stroke, [0, 0, 0, 1]);
      return selected;
    }
    const initial = space.kind === 'rgb' ? [0, 0, 0] : [0];
    const values = deviceCmyk(context, space.source, initial);
    setConvertedZero(context, stroke, values);
    return `${selected}\n${formatted(values, stroke ? 'SC' : 'sc')}`;
  }
  if (space.kind === 'deviceGray' && context.options.deviceGray === 'promote-to-cmyk') {
    setConvertedZero(context, stroke, [0, 0, 0, 1]);
    return `/DeviceCMYK ${operation.operator}`;
  }
  return undefined;
};

const setComponents = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  const stroke = operation.operator === operation.operator.toUpperCase();
  const space = selectedSpace(context, stroke);
  if (space.kind === 'rgb' || space.kind === 'gray') {
    const values = colorValues(operation.operands, space.kind === 'rgb' ? 3 : 1);
    const converted = deviceCmyk(context, space.source, values);
    setConvertedZero(context, stroke, converted);
    return formatted(converted, operation.operator);
  }
  if (space.kind === 'deviceGray' && context.options.deviceGray === 'promote-to-cmyk') {
    const value = colorValues(operation.operands, 1)[0] ?? 0;
    const converted = [0, 0, 0, 1 - value];
    setConvertedZero(context, stroke, converted);
    return formatted(converted, operation.operator);
  }
  return undefined;
};

const directRgb = (context: RewriteContext, operation: SpannedContentOperation): string => {
  const stroke = operation.operator === 'RG';
  const space = sourceFor(context, pdfName('DeviceRGB'));
  if (space.kind !== 'rgb') return invalid('DefaultRGB is not an RGB colour space');
  setSpace(context, stroke, space);
  const values = colorValues(operation.operands, 3);
  const converted = deviceCmyk(context, space.source, values);
  setConvertedZero(context, stroke, converted);
  return formatted(converted, stroke ? 'K' : 'k');
};

const directGray = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  setSpace(context, operation.operator === 'G', { kind: 'deviceGray' });
  if (context.options.deviceGray !== 'promote-to-cmyk') return undefined;
  const gray = colorValues(operation.operands, 1)[0] ?? 0;
  const converted = [0, 0, 0, 1 - gray];
  setConvertedZero(context, operation.operator === 'G', converted);
  return formatted(converted, operation.operator === 'G' ? 'K' : 'k');
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
    const entries = gsEntries(context, nameBytes(operation.operands[0]));
    if (entries !== undefined) {
      const intent = deref(context, entries.get(RENDERING_INTENT));
      if (intent?.kind === 'name') context.state = { ...context.state, intent: intentOf(intent.bytes) };
      updateOverprint(context, entries);
    }
    return;
  }
  if (operator === 'Tr') {
    const mode = colorValues(operation.operands, 1)[0] ?? 0;
    context.state = { ...context.state, textRenderMode: mode };
  }
};

const rewriteOperation = (context: RewriteContext, operation: SpannedContentOperation): string | undefined => {
  const { operator } = operation;
  if (operator === 'q' || operator === 'Q' || operator === 'ri' || operator === 'gs' || operator === 'Tr') {
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

const PATH_CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const FILL_PATH = new Set(['f', 'F', 'f*']);
const STROKE_PATH = new Set(['S', 's']);
const BOTH_PATH = new Set(['B', 'B*', 'b', 'b*']);
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const TEXT_FILL = new Set([0, 2, 4, 6]);
const TEXT_STROKE = new Set([1, 2, 5, 6]);

const needsNeutralisation = (context: RewriteContext, fill: boolean, stroke: boolean): boolean => {
  const { state } = context;
  if (state.overprintMode !== 1) return false;
  return (fill && state.fillOverprint && state.fillConvertedZero) || (stroke && state.strokeOverprint && state.strokeConvertedZero);
};

const neutralise = (context: RewriteContext, start: number, end: number): void => {
  if (context.options.overprintMode === 'refuse') throw new ValidationError('converted paint changes overprint mode 1 behaviour', 'overprint-mode-change');
  const names = context.overprintNames;
  if (names === undefined) return invalid('overprint resource names are missing');
  // ISO 32000-1:2008, 8.6.7: OPM 1 affects zero DeviceCMYK components; Figure 9 forbids gs within a path object.
  context.edits.push({ start, end: start, text: `/${names.off} gs\n` }, { start: end, end, text: `\n/${names.on} gs` });
  context.overprintAdjustments++;
};

const recordPaint = (context: RewriteContext, operation: SpannedContentOperation): void => {
  const { operator } = operation;
  if (PATH_CONSTRUCTION.has(operator)) {
    context.pathStart ??= operation.start;
    return;
  }
  if (operator === 'n') {
    context.pathStart = undefined;
    return;
  }
  const fill = FILL_PATH.has(operator) || BOTH_PATH.has(operator);
  const stroke = STROKE_PATH.has(operator) || BOTH_PATH.has(operator);
  if (fill || stroke) {
    if (needsNeutralisation(context, fill, stroke)) neutralise(context, context.pathStart ?? operation.start, operation.end);
    context.pathStart = undefined;
    return;
  }
  if (TEXT_SHOW.has(operator) && needsNeutralisation(context, TEXT_FILL.has(context.state.textRenderMode), TEXT_STROKE.has(context.state.textRenderMode))) {
    neutralise(context, operation.start, operation.end);
  }
};

/** Rewrites only colour-setting operations; all other bytes are copied directly from the source stream. */
export const rewriteContentColors = (
  document: LoadedDocument,
  bytes: Uint8Array,
  config: { resources: PdfDictionaryEntries; options: RewriteColorOptions; overprintNames?: OverprintNames | undefined },
): RewrittenContent => {
  const context: RewriteContext = {
    document,
    resources: config.resources,
    options: config.options,
    transforms: new Map(),
    edits: [],
    overprintNames: config.overprintNames,
    kOnly: 0,
    overprintAdjustments: 0,
    pathStart: undefined,
    state: {
      fill: { kind: 'deviceGray' },
      stroke: { kind: 'deviceGray' },
      intent: 'relativeColorimetric',
      fillOverprint: false,
      strokeOverprint: false,
      overprintMode: 0,
      fillConvertedZero: false,
      strokeConvertedZero: false,
      textRenderMode: 0,
    },
    stack: [],
  };
  let operators = 0;
  for (const operation of readContentSpans(bytes, 256)) {
    const replacement = rewriteOperation(context, operation);
    if (replacement !== undefined) {
      context.edits.push({ start: operation.start, end: operation.end, text: replacement });
      operators++;
    }
    recordPaint(context, operation);
  }
  if (context.edits.length === 0) return { bytes, operators, kOnly: context.kOnly, overprintAdjustments: 0 };
  const writer = new ByteWriter();
  let cursor = 0;
  for (const edit of context.edits.toSorted((left, right) => left.start - right.start || left.end - right.end)) {
    if (edit.start < cursor) return invalid('overlapping colour edits');
    writer.writeBytes(bytes.subarray(cursor, edit.start));
    writer.writeAscii(edit.text);
    cursor = edit.end;
  }
  writer.writeBytes(bytes.subarray(cursor));
  return { bytes: writer.toUint8Array(), operators, kOnly: context.kOnly, overprintAdjustments: context.overprintAdjustments };
};
