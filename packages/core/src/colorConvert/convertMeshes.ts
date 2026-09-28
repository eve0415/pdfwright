import type { ColorSource, ColorTransform } from '../color/createColorTransform.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { ResourceVisit } from '../resourceGraph/walkResources.ts';
import type { MeshSampleOptions } from './meshSamples.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';
import type { ConvertedCmykFunction } from './stitchCmykFunction.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfName, pdfReal } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { convertMeshSamples } from './meshSamples.ts';
import { checkConversionRefusals } from './preflight.ts';
import { sampleCmykFunction } from './sampleCmykFunction.ts';
import { resolveSourceSpace } from './sourceSpace.ts';
import { stitchCmykFunction, writeCmykFunction } from './stitchCmykFunction.ts';

export interface MeshConversionReport {
  readonly meshes: number;
  readonly approximations: readonly { readonly shading: PdfReference; readonly kind: 'mesh-interpolation' | 'function-sampling' }[];
}

interface MeshScan {
  readonly document: LoadedDocument;
  readonly options: RewriteColorOptions;
  readonly plans: Map<number, MeshPlan>;
}

interface MeshPlan {
  readonly reference: PdfReference;
  readonly shading: PdfStream;
  readonly data: Uint8Array;
  readonly decode: PdfDirectObject;
  readonly background: PdfDirectObject | undefined;
  readonly discarded: readonly PdfReference[];
  readonly function: ConvertedCmykFunction | undefined;
}

const SHADING = pdfName('Shading').bytes;
const PATTERN = pdfName('Pattern').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const SHADING_TYPE = pdfName('ShadingType').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const BITS_PER_COORDINATE = pdfName('BitsPerCoordinate').bytes;
const BITS_PER_COMPONENT = pdfName('BitsPerComponent').bytes;
const BITS_PER_FLAG = pdfName('BitsPerFlag').bytes;
const VERTICES_PER_ROW = pdfName('VerticesPerRow').bytes;
const DECODE = pdfName('Decode').bytes;
const BACKGROUND = pdfName('Background').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const FUNCTION = pdfName('Function').bytes;
const MAX_MESH_WORKING_BYTES = 4 * 1024 * 1024;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const integer = (value: PdfDirectObject | undefined, name: string): number => {
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value)) return invalid(`mesh ${name} is not an integer`);
  return value.value;
};

const numeric = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real') return typeof value.value === 'number' ? value.value : Number(value.value.numerator) / Number(value.value.denominator);
  return invalid('mesh Decode has a nonnumeric entry');
};

const arrayNumbers = (value: PdfDirectObject | undefined, length: number): number[] => {
  if (value?.kind !== 'array' || value.items.length !== length) return invalid('mesh array has the wrong length');
  return value.items.map(item => numeric(item));
};

const colorTransform = (source: ColorSource, options: RewriteColorOptions): ColorTransform => {
  const intent = options.intent === undefined || options.intent === 'document' ? 'relativeColorimetric' : options.intent;
  return createColorTransform(source, options.outputProfile, {
    intent,
    blackPointCompensation: options.blackPointCompensation !== false,
    lut8LabEncoding: options.lut8LabEncoding ?? 'icc',
  });
};

const backgroundFor = (value: PdfDirectObject | undefined, channels: number, transform: ColorTransform): PdfDirectObject | undefined => {
  if (value === undefined) return undefined;
  const input = arrayNumbers(value, channels);
  const output = new Float64Array(4);
  transform.convert(Float64Array.from(input), output);
  return pdfArray([...output].map(component => pdfReal(component)));
};

const meshKind = (value: number): 4 | 5 | 6 | 7 | undefined => {
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  return undefined;
};

const meshParameters = (config: {
  shading: PdfStream;
  type: 4 | 5 | 6 | 7;
  channels: number;
  transform: ColorTransform;
  maxBytes: number;
}): MeshSampleOptions => {
  const { shading, type, channels, transform, maxBytes } = config;
  const coordinateBits = integer(shading.dictionary.get(BITS_PER_COORDINATE), 'BitsPerCoordinate');
  const componentBits = integer(shading.dictionary.get(BITS_PER_COMPONENT), 'BitsPerComponent');
  const flagBits = type === 5 ? 0 : integer(shading.dictionary.get(BITS_PER_FLAG), 'BitsPerFlag');
  if (
    ![1, 2, 4, 8, 12, 16, 24, 32].includes(coordinateBits) ||
    ![1, 2, 4, 8, 12, 16].includes(componentBits) ||
    (type !== 5 && ![2, 4, 8].includes(flagBits))
  ) {
    return invalid('mesh bit widths are invalid');
  }
  return {
    type,
    coordinateBits,
    componentBits,
    flagBits,
    channels,
    decode: arrayNumbers(shading.dictionary.get(DECODE), 4 + channels * 2),
    transform,
    maxBytes,
  };
};

const outputDecode = (shading: PdfStream): PdfDirectObject => {
  const source = shading.dictionary.get(DECODE);
  if (source?.kind !== 'array') return invalid('mesh Decode is missing');
  const ranges: PdfDirectObject[] = source.items.slice(0, 4);
  for (let channel = 0; channel < 4; channel++) ranges.push({ kind: 'integer', value: 0 }, { kind: 'integer', value: 1 });
  return pdfArray(ranges);
};

const decodedFunction = (scan: MeshScan, value: PdfObject): PdfObject => {
  const internals = internalsOf(scan.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const object = value.kind === 'stream' ? value : internals.objects.deref(value);
  if (object === undefined) return invalid('mesh Function is missing');
  if (object.kind !== 'stream') return object;
  const data = decodedData(internals, object);
  if (typeof data === 'string') return invalid(`mesh Function cannot be decoded: ${data}`);
  return { kind: 'stream', dictionary: object.dictionary, data };
};

const functionEvaluator = (scan: MeshScan, value: PdfDirectObject, channels: number): PdfFunction => {
  if (value.kind !== 'array') return createPdfFunction(decodedFunction(scan, value));
  if (value.items.length !== channels) return invalid('mesh Function array disagrees with its colour space');
  const functions = value.items.map(item => createPdfFunction(decodedFunction(scan, item)));
  return input => functions.map(fn => fn(input)[0] ?? 0);
};

const convertedMeshFunction = (
  scan: MeshScan,
  config: { value: PdfDirectObject; channels: number; transform: ColorTransform; domain: readonly number[] },
): ConvertedCmykFunction => {
  const { value, channels, transform, domain } = config;
  const original = decodedFunction(scan, value);
  if (original.kind === 'dictionary' && original.entries.get(pdfName('FunctionType').bytes)?.kind === 'integer') {
    const type = original.entries.get(pdfName('FunctionType').bytes);
    if (type?.kind === 'integer' && type.value === 3) {
      return stitchCmykFunction(scan.document, original, child => {
        const decoded = decodedFunction(scan, child);
        if (decoded.kind !== 'dictionary' && decoded.kind !== 'stream') return invalid('mesh stitching subfunction is invalid');
        const entries = decoded.kind === 'dictionary' ? decoded.entries : decoded.dictionary;
        const childDomain = arrayNumbers(entries.get(pdfName('Domain').bytes), 2);
        const fn = createPdfFunction(decoded);
        const evaluate = (input: readonly number[]): Float64Array => {
          const output = new Float64Array(4);
          transform.convert(Float64Array.from(fn(input)), output);
          return output;
        };
        return sampleCmykFunction({ dimensions: 1, domain: childDomain, evaluate, destination: scan.options.outputProfile });
      });
    }
  }
  const fn = functionEvaluator(scan, value, channels);
  const evaluate = (values: readonly number[]): Float64Array => {
    const output = new Float64Array(4);
    transform.convert(Float64Array.from(fn(values)), output);
    return output;
  };
  return sampleCmykFunction({ dimensions: 1, domain, evaluate, destination: scan.options.outputProfile });
};

const functionMesh = (
  scan: MeshScan,
  input: {
    reference: PdfReference;
    shading: PdfStream;
    color: PdfDirectObject;
    channels: number;
    transform: ColorTransform;
    background: PdfDirectObject | undefined;
  },
): MeshPlan => {
  const { reference, shading, color, channels, transform, background } = input;
  const functionValue = shading.dictionary.get(FUNCTION);
  if (functionValue === undefined) return invalid('function-driven mesh has no Function');
  const decode = arrayNumbers(shading.dictionary.get(DECODE), 6);
  const sampled = convertedMeshFunction(scan, { value: functionValue, channels, transform, domain: decode.slice(4, 6) });
  const discarded: PdfReference[] = [];
  if (color.kind === 'reference') discarded.push(color);
  if (functionValue.kind === 'reference') discarded.push(functionValue);
  const original = decodedFunction(scan, functionValue);
  if (original.kind === 'dictionary') {
    const children = original.entries.get(pdfName('Functions').bytes);
    if (children?.kind === 'array') for (const child of children.items) if (child.kind === 'reference') discarded.push(child);
  }
  const originalDecode = shading.dictionary.get(DECODE);
  if (originalDecode === undefined) return invalid('function-driven mesh Decode is missing');
  return { reference, shading, data: shading.data, decode: originalDecode, background, discarded, function: sampled };
};

const meshPlan = (scan: MeshScan, target: { reference: PdfReference; shading: PdfStream }, resources: PdfDictionaryEntries): MeshPlan | undefined => {
  const { reference, shading } = target;
  const type = meshKind(integer(shading.dictionary.get(SHADING_TYPE), 'ShadingType'));
  if (type === undefined) return undefined;
  const color = shading.dictionary.get(COLOR_SPACE);
  if (color === undefined) return invalid('mesh ColorSpace is missing');
  const space = resolveSourceSpace(scan.document, color, {
    resources,
    sourceRgbProfile: scan.options.sourceRgbProfile,
    options: { iccGray: scan.options.iccGray ?? 'convert' },
  });
  if (space.kind !== 'rgb' && space.kind !== 'gray') return undefined;
  const channels = space.kind === 'rgb' ? 3 : 1;
  const transform = colorTransform(space.source, scan.options);
  const background = backgroundFor(shading.dictionary.get(BACKGROUND), channels, transform);
  if (shading.dictionary.get(FUNCTION) !== undefined) return functionMesh(scan, { reference, shading, color, channels, transform, background });
  const internals = internalsOf(scan.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const data = decodedData(internals, shading);
  if (typeof data === 'string') return invalid(`mesh stream cannot be decoded: ${data}`);
  const converted = convertMeshSamples(
    data,
    meshParameters({ shading, type, channels, transform, maxBytes: Math.min(internals.maxDecodedBytes, MAX_MESH_WORKING_BYTES) }),
  );
  if (type === 5) {
    const vertices = integer(shading.dictionary.get(VERTICES_PER_ROW), 'VerticesPerRow');
    if (vertices < 2 || converted.records % vertices !== 0) return invalid('lattice mesh vertex rows are incomplete');
  }
  return {
    reference,
    shading,
    data: deflateZlib(converted.data),
    decode: outputDecode(shading),
    background,
    discarded: color.kind === 'reference' ? [color] : [],
    function: undefined,
  };
};

const scanResources = (scan: MeshScan, visit: ResourceVisit): void => {
  const internals = internalsOf(scan.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const planReference = (value: PdfDirectObject): void => {
    if (value.kind !== 'reference' || scan.plans.has(value.objectNumber)) return;
    const shading = internals.objects.deref(value);
    if (shading?.kind !== 'stream') return;
    const plan = meshPlan(scan, { reference: value, shading }, visit.resources);
    if (plan !== undefined) scan.plans.set(value.objectNumber, plan);
  };
  const category = internals.objects.deref(visit.resources.get(SHADING));
  if (category?.kind === 'dictionary') for (const [, value] of category.entries.entries()) planReference(value);
  const patterns = internals.objects.deref(visit.resources.get(PATTERN));
  if (patterns?.kind !== 'dictionary') return;
  for (const [, value] of patterns.entries.entries()) {
    const pattern = internals.objects.deref(value);
    if (pattern?.kind !== 'dictionary') continue;
    const type = pattern.entries.get(PATTERN_TYPE);
    if (type?.kind !== 'integer' || type.value !== 2) continue;
    const shading = pattern.entries.get(SHADING);
    if (shading !== undefined) planReference(shading);
  }
};

/** Converts unfunctioned Type 4–7 mesh vertex colours while retaining encoded geometry. */
export const convertMeshShadings = (document: LoadedDocument, options: RewriteColorOptions): MeshConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const scan: MeshScan = { document, options, plans: new Map() };
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) return invalid('page entry is missing');
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(page).resources() };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        scanResources(scan, visit);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('mesh shading resources cannot be read', 'unreadable-resource');
  }
  const discarded: PdfReference[] = [];
  for (const plan of scan.plans.values()) {
    const dictionary = new PdfDictionaryEntries(plan.shading.dictionary.entries());
    dictionary.set(COLOR_SPACE, pdfName('DeviceCMYK'));
    if (plan.function === undefined) {
      dictionary.set(DECODE, plan.decode);
      dictionary.set(FILTER, pdfName('FlateDecode'));
      dictionary.delete(DECODE_PARMS);
    } else dictionary.set(FUNCTION, writeCmykFunction(document, plan.function));
    if (plan.background !== undefined) dictionary.set(BACKGROUND, plan.background);
    document.set(plan.reference, { kind: 'stream', dictionary, data: plan.data });
    discarded.push(...plan.discarded);
  }
  if (scan.plans.size > 0) {
    deleteDiscarded(document, internals, discarded);
    internals.objects.requireFullRewrite('color-conversion');
  }
  const approximations: { shading: PdfReference; kind: 'mesh-interpolation' | 'function-sampling' }[] = [];
  for (const plan of scan.plans.values()) {
    if (plan.function === undefined) approximations.push({ shading: plan.reference, kind: 'mesh-interpolation' });
    else if (plan.function.kind === 'sampled' && plan.function.maxDeltaE2000 > 0.1) approximations.push({ shading: plan.reference, kind: 'function-sampling' });
  }
  return { meshes: scan.plans.size, approximations };
};
