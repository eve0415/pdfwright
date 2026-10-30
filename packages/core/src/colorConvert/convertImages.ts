import type { ColorSource, ColorTransform } from '../color/createColorTransform.ts';
import type { DocumentInternals } from '../document/documentInternals.ts';
import type { StreamProducer } from '../document/editedObjects.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PredictorParameters } from '../filter/predictor.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { IccProfile } from '../icc/iccProfile.ts';
import type { RenderingIntent } from '../icc/iccStructure.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { ResourceVisit } from '../resourceGraph/walkResources.ts';
import type { RowMatte } from './imageRows.ts';
import type { FormUse, RewriteColorOptions } from './rewriteContent.ts';
import type { SourceSpace } from './sourceSpace.ts';

import { createColorTransform } from '../color/createColorTransform.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { undoPredictor } from '../filter/predictor.ts';
import { createDeflateStream } from '../flate/deflate.ts';
import { inflateChunks } from '../flate/inflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { decodeJpeg } from '../jpeg/decodeJpeg.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { combineContentStreams } from './combinedContent.ts';
import { deleteDiscarded } from './discardedObjects.ts';
import { convertImageRow, readImageSample } from './imageRows.ts';
import { jpxHasRgbColor } from './jpxColor.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewriteContentColors } from './rewriteContent.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

export interface ImageConversionReport {
  readonly converted: number;
  readonly keptRgbImages: readonly {
    readonly ref: PdfReference;
    readonly filter: 'DCTDecode' | 'JPXDecode';
    readonly tagged: 'added' | 'existing' | 'jpx-colr';
  }[];
}

interface ImagePlan {
  readonly reference: PdfReference;
  readonly image: PdfStream;
  readonly source: SourceSpace;
  readonly filter: 'DCTDecode' | 'JPXDecode' | undefined;
  readonly converted: StreamProducer | undefined;
  readonly stencil: StreamProducer | undefined;
  readonly outputBits: number | undefined;
  readonly explicitColorSpace: PdfDirectObject | undefined;
  readonly matte: SoftMaskMatte | undefined;
}

interface ImageScan {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
  readonly options: RewriteColorOptions;
  readonly plans: ImagePlan[];
  readonly seen: Map<number, string>;
  readonly uses: Map<number, RenderingIntent>;
  readonly transforms: Map<string, ColorTransform>;
  readonly activeForms: Set<number>;
}

interface EncodedImageData {
  readonly data: StreamProducer;
  readonly bits: number;
  readonly stencil: StreamProducer | undefined;
  readonly matte: SoftMaskMatte | undefined;
}

interface ImageGeometry {
  readonly width: number;
  readonly height: number;
  readonly bits: number;
  readonly channels: number;
  readonly inputRow: number;
  readonly outputBits: number;
  readonly ranges: readonly number[] | undefined;
  readonly matte: SoftMaskMatte | undefined;
}

/** A soft mask whose Matte says the parent image's samples were preblended with that colour. */
interface SoftMaskMatte {
  readonly reference: PdfReference;
  readonly mask: PdfStream;
  readonly values: readonly number[];
  readonly geometry: ImageGeometry;
  readonly decode: readonly number[];
}

const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const DEFAULT_RGB = pdfName('DefaultRGB').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const DECODE = pdfName('Decode').bytes;
const IMAGE_MASK = pdfName('ImageMask').bytes;
const MASK = pdfName('Mask').bytes;
const SOFT_MASK = pdfName('SMask').bytes;
const MATTE = pdfName('Matte').bytes;
const TYPE = pdfName('Type').bytes;
const BITS = pdfName('BitsPerComponent').bytes;
const WIDTH = pdfName('Width').bytes;
const HEIGHT = pdfName('Height').bytes;
const INTENT = pdfName('Intent').bytes;
const N = pdfName('N').bytes;
const COLOR_TRANSFORM = pdfName('ColorTransform').bytes;
const MAX_IMAGE_WORKING_BYTES = 4 * 1024 * 1024;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const deref = (scan: ImageScan, value: PdfDirectObject | undefined): PdfDirectObject | PdfStream | undefined => scan.internals.objects.deref(value);

const imageNumber = (scan: ImageScan, image: PdfStream, key: Uint8Array): number => {
  const value = deref(scan, image.dictionary.get(key));
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value) || value.value < 1) return invalid('image dimensions or bit depth are invalid');
  return value.value;
};

const filterNames = (scan: ImageScan, image: PdfStream): string[] => {
  const value = deref(scan, image.dictionary.get(FILTER));
  let entries: readonly PdfDirectObject[] = [];
  if (value?.kind === 'array') entries = value.items;
  else if (value !== undefined) {
    if (value.kind !== 'name') return invalid('image filter is not a name');
    entries = [value];
  }
  return entries.map(item => {
    const resolved = deref(scan, item);
    if (resolved?.kind !== 'name') return invalid('image filter is not a name');
    const name = new TextDecoder('latin1').decode(resolved.bytes);
    if (name === 'DCT') return 'DCTDecode';
    if (name === 'Fl') return 'FlateDecode';
    return name;
  });
};

const compressedFilter = (names: readonly string[]): 'DCTDecode' | 'JPXDecode' | undefined => {
  if (names.includes('JPXDecode')) return 'JPXDecode';
  if (names.includes('DCTDecode')) return 'DCTDecode';
  return undefined;
};

const colorSource = (space: SourceSpace): ColorSource | undefined => (space.kind === 'rgb' || space.kind === 'gray' ? space.source : undefined);

const explicitDefaultRgb = (scan: ImageScan, resources: PdfDictionaryEntries): PdfDirectObject => {
  const category = deref(scan, resources.get(COLOR_SPACE));
  if (category?.kind !== 'dictionary') return invalid('DefaultRGB resource is missing');
  const value = category.entries.get(DEFAULT_RGB);
  if (value === undefined) return invalid('DefaultRGB resource is missing');
  const resolved = deref(scan, value);
  if (resolved?.kind === 'array') return resolved;
  if (value.kind === 'reference') return value;
  return invalid('DefaultRGB cannot be made explicit on an image');
};

const sourceKey = (space: SourceSpace): string => {
  const source = colorSource(space);
  if (source === undefined) return space.kind;
  return source.kind === 'icc' ? [...source.profile.identity].join(',') : JSON.stringify(source);
};

const intentName = (value: PdfDirectObject | PdfStream | undefined): RenderingIntent | undefined => {
  if (value?.kind !== 'name') return undefined;
  const name = new TextDecoder('latin1').decode(value.bytes);
  if (name === 'Perceptual') return 'perceptual';
  if (name === 'Saturation') return 'saturation';
  if (name === 'AbsoluteColorimetric') return 'absoluteColorimetric';
  return 'relativeColorimetric';
};

const transformFor = (scan: ImageScan, image: PdfStream, selection: { source: ColorSource; reference: PdfReference }): ColorTransform => {
  const intent =
    scan.options.intent === undefined || scan.options.intent === 'document'
      ? (intentName(deref(scan, image.dictionary.get(INTENT))) ?? scan.uses.get(selection.reference.objectNumber) ?? 'relativeColorimetric')
      : scan.options.intent;
  const key = `${intent}:${selection.source.kind === 'icc' ? [...selection.source.profile.identity].join(',') : JSON.stringify(selection.source)}`;
  const cached = scan.transforms.get(key);
  if (cached !== undefined) return cached;
  const transform = createColorTransform(selection.source, scan.options.outputProfile, {
    intent,
    blackPointCompensation: scan.options.blackPointCompensation !== false,
    lut8LabEncoding: scan.options.lut8LabEncoding ?? 'icc',
  });
  scan.transforms.set(key, transform);
  return transform;
};

const decodeArray = (scan: ImageScan, image: PdfStream, channels: number): number[] | undefined => {
  const value = deref(scan, image.dictionary.get(DECODE));
  if (value === undefined) return undefined;
  if (value.kind !== 'array' || value.items.length !== channels * 2) return invalid('image Decode array has the wrong length');
  const values: number[] = [];
  for (const item of value.items) {
    const component = deref(scan, item);
    if (component?.kind !== 'integer' && component?.kind !== 'real') return invalid('image Decode entry is not numeric');
    if (typeof component.value !== 'number') return invalid('image Decode entry is not numeric');
    values.push(component.value);
  }
  return values;
};

const maskRanges = (scan: ImageScan, image: PdfStream, config: { channels: number; bits: number }): readonly number[] | undefined => {
  const { channels, bits } = config;
  const mask = deref(scan, image.dictionary.get(MASK));
  if (mask?.kind !== 'array') return undefined;
  if (mask.items.length !== channels * 2) return invalid('image colour-key mask has the wrong number of ranges');
  const maximum = 2 ** bits - 1;
  const ranges: number[] = [];
  for (const item of mask.items) {
    const value = deref(scan, item);
    if (value?.kind !== 'integer' || value.value < 0 || value.value > maximum) return invalid('image colour-key mask range is invalid');
    ranges.push(value.value);
  }
  return ranges;
};

const stencilRow = (row: Uint8Array, config: { width: number; channels: number; bits: number; ranges: readonly number[] }): Uint8Array => {
  const { width, channels, bits, ranges } = config;
  // ISO 32000-1:2008, 8.9.6.4 tests the raw samples before Decode; 8.9.6.2 makes stencil bit 1 transparent by default.
  const stencil = new Uint8Array(Math.ceil(width / 8));
  for (let pixel = 0; pixel < width; pixel++) {
    let keyed = true;
    for (let channel = 0; channel < channels; channel++) {
      const value = readImageSample(row, pixel * channels + channel, bits);
      if (value < (ranges[channel * 2] ?? 0) || value > (ranges[channel * 2 + 1] ?? -1)) keyed = false;
    }
    if (keyed) stencil[Math.floor(pixel / 8)] = (stencil[Math.floor(pixel / 8)] ?? 0) + 2 ** (7 - (pixel % 8));
  }
  return stencil;
};

const imageBits = (scan: ImageScan, image: PdfStream): number => {
  const bits = imageNumber(scan, image, BITS);
  if (![1, 2, 4, 8, 16].includes(bits)) return invalid('image BitsPerComponent is unsupported');
  return bits;
};

const softMaskMatte = (scan: ImageScan, image: PdfStream, parent: { width: number; height: number; channels: number }): SoftMaskMatte | undefined => {
  const reference = image.dictionary.get(SOFT_MASK);
  const mask = deref(scan, reference);
  if (mask?.kind !== 'stream') return undefined;
  const matte = deref(scan, mask.dictionary.get(MATTE));
  if (matte === undefined) return undefined;
  if (reference?.kind !== 'reference') return invalid('soft-mask image must be indirect');
  // ISO 32000-1:2008, 11.6.5.3, Table 146: Matte has one component per component of the parent image's colour space, and a preblended image and its soft mask have the same Width and Height.
  if (matte.kind !== 'array' || matte.items.length !== parent.channels) return invalid('soft-mask Matte does not match the image colour space');
  const values = matte.items.map(item => {
    const component = deref(scan, item);
    if (component?.kind !== 'integer' && component?.kind !== 'real') return invalid('soft-mask Matte entry is not numeric');
    if (typeof component.value !== 'number') return invalid('soft-mask Matte entry is not numeric');
    return component.value;
  });
  const width = imageNumber(scan, mask, WIDTH);
  const height = imageNumber(scan, mask, HEIGHT);
  if (width !== parent.width || height !== parent.height) return invalid('preblended image and its soft mask differ in size');
  const bits = imageBits(scan, mask);
  const geometry: ImageGeometry = {
    width,
    height,
    bits,
    channels: 1,
    inputRow: Math.ceil((width * bits) / 8),
    outputBits: 8,
    ranges: undefined,
    matte: undefined,
  };
  return { reference, mask, values, geometry, decode: decodeArray(scan, mask, 1) ?? [0, 1] };
};

const imageGeometry = (scan: ImageScan, image: PdfStream, space: SourceSpace): ImageGeometry => {
  const width = imageNumber(scan, image, WIDTH);
  const height = imageNumber(scan, image, HEIGHT);
  const bits = imageBits(scan, image);
  const channels = space.kind === 'rgb' ? 3 : 1;
  const inputRow = Math.ceil((width * channels * bits) / 8);
  const outputBits = bits === 16 ? 16 : 8;
  const outputRowBytes = width * 4 * (outputBits / 8);
  const ranges = maskRanges(scan, image, { channels, bits });
  const maskRowBytes = ranges === undefined ? 0 : Math.ceil(width / 8);
  const matte = softMaskMatte(scan, image, { width, height, channels });
  const alphaRowBytes = matte === undefined ? 0 : matte.geometry.inputRow * 3 + width * Float64Array.BYTES_PER_ELEMENT;
  const workingBytes = inputRow * 3 + outputRowBytes + maskRowBytes + alphaRowBytes;
  if (!Number.isSafeInteger(inputRow * height) || !Number.isSafeInteger(workingBytes) || workingBytes > scan.internals.maxDecodedBytes) {
    throw new ResourceLimitError(`RGB image rows exceed maxDecodedBytes (${String(scan.internals.maxDecodedBytes)} bytes)`);
  }
  return { width, height, bits, channels, inputRow, outputBits, ranges, matte };
};

const imagePredictor = (scan: ImageScan, image: PdfStream): PredictorParameters => {
  const parameters = deref(scan, image.dictionary.get(DECODE_PARMS));
  const parms = parameters?.kind === 'array' ? deref(scan, parameters.items[0]) : parameters;
  const predictorValue = parms?.kind === 'dictionary' ? deref(scan, parms.entries.get(pdfName('Predictor').bytes)) : undefined;
  const colorsValue = parms?.kind === 'dictionary' ? deref(scan, parms.entries.get(pdfName('Colors').bytes)) : undefined;
  const bitsValue = parms?.kind === 'dictionary' ? deref(scan, parms.entries.get(pdfName('BitsPerComponent').bytes)) : undefined;
  const columnsValue = parms?.kind === 'dictionary' ? deref(scan, parms.entries.get(pdfName('Columns').bytes)) : undefined;
  return {
    predictor: predictorValue?.kind === 'integer' ? predictorValue.value : 1,
    colors: colorsValue?.kind === 'integer' ? colorsValue.value : 1,
    bitsPerComponent: bitsValue?.kind === 'integer' ? bitsValue.value : 8,
    columns: columnsValue?.kind === 'integer' ? columnsValue.value : 1,
  };
};

class ImageChunkCursor {
  private readonly iterator: Iterator<Uint8Array>;
  private current: IteratorResult<Uint8Array>;
  private position = 0;

  constructor(chunks: Iterable<Uint8Array>) {
    this.iterator = chunks[Symbol.iterator]();
    this.current = this.iterator.next();
  }

  private advance(): void {
    while (this.current.done !== true && this.position === this.current.value.length) {
      this.current = this.iterator.next();
      this.position = 0;
    }
  }

  take(length: number): Uint8Array {
    const output = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      this.advance();
      if (this.current.done === true) return invalid('decoded image length does not match its dimensions');
      const count = Math.min(this.current.value.length - this.position, length - filled);
      output.set(this.current.value.subarray(this.position, this.position + count), filled);
      this.position += count;
      filled += count;
    }
    return output;
  }

  hasMore(): boolean {
    this.advance();
    return this.current.done !== true;
  }
}

const imageChunks = (image: PdfStream, filters: readonly string[], expected: number): Iterable<Uint8Array> | undefined => {
  if (filters.length === 1 && filters[0] === 'FlateDecode') return inflateChunks(image.data, { maxOutputBytes: expected, copyInput: false });
  if (filters.length === 0) return [image.data];
  return undefined;
};

const imageRows = function* (scan: ImageScan, image: PdfStream, geometry: ImageGeometry): Generator<Uint8Array> {
  const filters = filterNames(scan, image);
  const settings = imagePredictor(scan, image);
  const encodedRow = geometry.inputRow + (settings.predictor >= 10 ? 1 : 0);
  const expected = encodedRow * geometry.height;
  const chunks = imageChunks(image, filters, expected);
  if (chunks === undefined) {
    const data = decodedData(scan.internals, image);
    if (typeof data === 'string') throw new ValidationError(`image data cannot be decoded: ${data}`, 'color-space');
    if (data.length !== geometry.inputRow * geometry.height) invalid('decoded image length does not match its dimensions');
    for (let row = 0; row < geometry.height; row++) yield data.subarray(row * geometry.inputRow, (row + 1) * geometry.inputRow);
    return;
  }
  const cursor = new ImageChunkCursor(chunks);
  let previous: Uint8Array = new Uint8Array(geometry.inputRow);
  for (let row = 0; row < geometry.height; row++) {
    const encoded = cursor.take(encodedRow);
    let decoded: Uint8Array = encoded;
    if (settings.predictor >= 10) {
      const pair = new Uint8Array(geometry.inputRow + 1 + encodedRow);
      pair.set(previous, 1);
      pair.set(encoded, geometry.inputRow + 1);
      decoded = undoPredictor(pair, settings).subarray(geometry.inputRow);
    } else if (settings.predictor !== 1) decoded = undoPredictor(encoded, settings);
    if (decoded.length !== geometry.inputRow) invalid('decoded image row has the wrong width');
    previous = decoded;
    yield decoded;
  }
  if (cursor.hasMore()) invalid('decoded image length does not match its dimensions');
};

const alphaRow = (row: Uint8Array, matte: SoftMaskMatte): Float64Array => {
  const { width, bits } = matte.geometry;
  const maximum = 2 ** bits - 1;
  const start = matte.decode[0] ?? 0;
  const end = matte.decode[1] ?? 1;
  // ISO 32000-1:2008, 8.9.5.2 and 11.6.5.3: soft-mask samples map through the mask's Decode array to alpha.
  return Float64Array.from({ length: width }, (_, pixel) => start + (readImageSample(row, pixel, bits) / maximum) * (end - start));
};

/** Pairs each image row with the matte and alpha its samples were preblended with. */
const withMatte = function* (scan: ImageScan, rows: Iterable<Uint8Array>, matte: SoftMaskMatte | undefined): Generator<[Uint8Array, RowMatte | undefined]> {
  if (matte === undefined) {
    for (const row of rows) yield [row, undefined];
    return;
  }
  const alphas = imageRows(scan, matte.mask, matte.geometry);
  for (const row of rows) {
    const alpha = alphas.next();
    if (alpha.done === true) throw new ValidationError('soft-mask data is shorter than its image', 'color-space');
    yield [row, { values: matte.values, alpha: alphaRow(alpha.value, matte) }];
  }
};

const checkSoftMaskRows = (scan: ImageScan, matte: SoftMaskMatte | undefined): void => {
  if (matte === undefined) return;
  for (const row of imageRows(scan, matte.mask, matte.geometry)) void row;
};

const convertPixels = (scan: ImageScan, image: PdfStream, target: { space: SourceSpace; reference: PdfReference }): EncodedImageData => {
  const { space, reference } = target;
  const source = colorSource(space);
  if (source === undefined) return invalid('image colour space cannot be converted');
  const geometry = imageGeometry(scan, image, space);
  const { width, bits, channels, outputBits, ranges, matte } = geometry;
  for (const row of imageRows(scan, image, geometry)) void row;
  checkSoftMaskRows(scan, matte);
  const transform = transformFor(scan, image, { source, reference });
  const decode = decodeArray(scan, image, channels);
  const data: StreamProducer = function* () {
    const deflater = createDeflateStream();
    for (const [input, rowMatte] of withMatte(scan, imageRows(scan, image, geometry), matte)) {
      yield* deflater.push(convertImageRow(input, { width, channels, bits, transform, decode, matte: rowMatte }));
    }
    yield deflater.finish();
  };
  const stencil: StreamProducer | undefined =
    ranges === undefined
      ? undefined
      : function* () {
          const deflater = createDeflateStream();
          for (const input of imageRows(scan, image, geometry)) yield* deflater.push(stencilRow(input, { width, channels, bits, ranges }));
          yield deflater.finish();
        };
  return { data, bits: outputBits, stencil, matte };
};

const jpegColorTransform = (scan: ImageScan, image: PdfStream): 0 | 1 | undefined => {
  const parameters = deref(scan, image.dictionary.get(DECODE_PARMS));
  const dictionary = parameters?.kind === 'array' ? deref(scan, parameters.items[0]) : parameters;
  if (dictionary === undefined || dictionary.kind === 'null') return undefined;
  if (dictionary.kind !== 'dictionary') throw new ParseError('JPEG DecodeParms must be a dictionary', 0);
  const value = deref(scan, dictionary.entries.get(COLOR_TRANSFORM));
  if (value === undefined) return undefined;
  if (value.kind !== 'integer' || (value.value !== 0 && value.value !== 1)) throw new ParseError('JPEG ColorTransform must be 0 or 1', 0);
  return value.value;
};

const transcodeJpegImage = (
  scan: ImageScan,
  input: { readonly reference: PdfReference; readonly image: PdfStream; readonly space: SourceSpace },
): EncodedImageData => {
  const { reference, image, space } = input;
  if (space.kind !== 'rgb') throw new UnsupportedFeatureError('compressed non-RGB JPEG conversion is unavailable', 'compressed-rgb-image');
  const geometry = imageGeometry(scan, image, space);
  if (geometry.bits !== 8) return invalid('JPEG image BitsPerComponent must be 8');
  // ISO 32000-1:2008, 7.4.8, Table 13: DecodeParms ColorTransform applies only when Adobe APP14 does not override it.
  const maxRowBytes = Math.min(scan.internals.maxDecodedBytes, MAX_IMAGE_WORKING_BYTES);
  const colorTransform = jpegColorTransform(scan, image);
  const { maxDecodedBytes } = scan.internals;
  const jpeg = decodeJpeg(image.data, colorTransform === undefined ? { maxRowBytes, maxDecodedBytes } : { maxRowBytes, maxDecodedBytes, colorTransform });
  if (jpeg.components !== 3 || jpeg.width !== geometry.width || jpeg.height !== geometry.height) {
    return invalid('JPEG frame geometry differs from the image dictionary');
  }
  for (const row of jpeg.rows()) void row;
  const { matte } = geometry;
  checkSoftMaskRows(scan, matte);
  const transform = transformFor(scan, image, { source: space.source, reference });
  const decode = decodeArray(scan, image, 3);
  const data: StreamProducer = function* () {
    const deflater = createDeflateStream();
    for (const [row, rowMatte] of withMatte(scan, jpeg.rows(), matte)) {
      yield* deflater.push(convertImageRow(row, { width: geometry.width, channels: 3, bits: 8, transform, decode, matte: rowMatte }));
    }
    yield deflater.finish();
  };
  const { ranges } = geometry;
  const stencil: StreamProducer | undefined =
    ranges === undefined
      ? undefined
      : function* () {
          const deflater = createDeflateStream();
          for (const row of jpeg.rows()) yield* deflater.push(stencilRow(row, { width: geometry.width, channels: 3, bits: 8, ranges }));
          yield deflater.finish();
        };
  return { data, bits: 8, stencil, matte };
};

const planUntaggedJpx = (scan: ImageScan, target: { reference: PdfReference; image: PdfStream }): void => {
  const { reference, image } = target;
  if (!jpxHasRgbColor(image.data, Math.min(scan.internals.maxDecodedBytes, MAX_IMAGE_WORKING_BYTES))) {
    throw new UnsupportedFeatureError('JPX image has no classifiable RGB colour space', 'jpx-color-space');
  }
  if (scan.options.compressedRgbImages === 'refuse' || scan.options.compressedRgbImages === 'transcode') {
    throw new UnsupportedFeatureError('compressed RGB image conversion is unavailable', 'compressed-rgb-image');
  }
  scan.seen.set(reference.objectNumber, 'jpx-colr');
  scan.plans.push({
    reference,
    image,
    source: { kind: 'untouched' },
    filter: 'JPXDecode',
    converted: undefined,
    stencil: undefined,
    outputBits: undefined,
    explicitColorSpace: undefined,
    matte: undefined,
  });
};

const planCompressedRgb = (
  scan: ImageScan,
  input: {
    reference: PdfReference;
    image: PdfStream;
    space: SourceSpace;
    filter: 'DCTDecode' | 'JPXDecode';
    color: PdfDirectObject;
    resources: PdfDictionaryEntries;
    filters: readonly string[];
  },
): void => {
  if (scan.options.compressedRgbImages === 'refuse') {
    throw new UnsupportedFeatureError('compressed RGB image conversion is unavailable', 'compressed-rgb-image');
  }
  if (scan.options.compressedRgbImages === 'transcode') {
    if (input.filter !== 'DCTDecode' || input.filters.length !== 1) {
      throw new UnsupportedFeatureError('only a single DCTDecode filter can be transcoded', 'compressed-rgb-image');
    }
    const converted = transcodeJpegImage(scan, input);
    scan.plans.push({
      reference: input.reference,
      image: input.image,
      source: input.space,
      filter: undefined,
      converted: converted.data,
      stencil: converted.stencil,
      outputBits: converted.bits,
      explicitColorSpace: undefined,
      matte: converted.matte,
    });
    return;
  }
  if (input.space.kind === 'rgb' && input.space.source.kind === 'icc' && input.space.source.profile.bytes.length > MAX_IMAGE_WORKING_BYTES) {
    throw new ResourceLimitError(`RGB image profile exceeds the in-memory ceiling (${String(MAX_IMAGE_WORKING_BYTES)} bytes)`);
  }
  const explicitColorSpace =
    input.color.kind === 'name' && input.space.kind === 'rgb' && input.space.source.kind === 'calRGB' ? explicitDefaultRgb(scan, input.resources) : undefined;
  scan.plans.push({
    reference: input.reference,
    image: input.image,
    source: input.space,
    filter: input.filter,
    converted: undefined,
    stencil: undefined,
    outputBits: undefined,
    explicitColorSpace,
    matte: undefined,
  });
};

const planImage = (scan: ImageScan, target: { reference: PdfReference; image: PdfStream }, resources: PdfDictionaryEntries): void => {
  const { reference, image } = target;
  // ISO 32000-1:2008, 8.9.5 Table 89: ColorSpace is required except for JPXDecode images and forbidden for image masks.
  const masked = deref(scan, image.dictionary.get(IMAGE_MASK));
  if (masked?.kind === 'boolean' && masked.value) return;
  const filters = filterNames(scan, image);
  const compressed = compressedFilter(filters);
  const color = image.dictionary.get(COLOR_SPACE);
  if (color === undefined) {
    if (compressed === 'JPXDecode') {
      planUntaggedJpx(scan, target);
      return;
    }
    return invalid('image ColorSpace is missing');
  }
  const space = resolveSourceSpace(scan.document, color, {
    resources,
    sourceRgbProfile: scan.options.sourceRgbProfile,
    options: { iccGray: scan.options.iccGray ?? 'convert' },
  });
  if (space.kind !== 'rgb' && space.kind !== 'gray') return;
  const key = sourceKey(space);
  const previous = scan.seen.get(reference.objectNumber);
  if (previous !== undefined && previous !== key) throw new ValidationError('shared image has conflicting source colour spaces', 'color-space');
  if (previous !== undefined) return;
  scan.seen.set(reference.objectNumber, key);
  if (compressed !== undefined) {
    planCompressedRgb(scan, { reference, image, space, filter: compressed, color, resources, filters });
    return;
  }
  const converted = convertPixels(scan, image, { space, reference });
  scan.plans.push({
    reference,
    image,
    source: space,
    filter: undefined,
    converted: converted.data,
    stencil: converted.stencil,
    outputBits: converted.bits,
    explicitColorSpace: undefined,
    matte: converted.matte,
  });
};

const scanResources = (scan: ImageScan, visit: ResourceVisit): void => {
  const category = deref(scan, visit.resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    const image = deref(scan, value);
    if (image?.kind !== 'stream') continue;
    const subtype = deref(scan, image.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Image') continue;
    if (value.kind !== 'reference') return invalid('image XObject must be indirect');
    planImage(scan, { reference: value, image }, visit.resources);
  }
};

const scanUses = (scan: ImageScan, resources: PdfDictionaryEntries, uses: readonly FormUse[]): void => {
  const category = deref(scan, resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const use of uses) {
    const value = category.entries.get(use.name);
    const stream = deref(scan, value);
    if (stream?.kind !== 'stream' || value?.kind !== 'reference') continue;
    const subtype = deref(scan, stream.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name') continue;
    const kind = new TextDecoder('latin1').decode(subtype.bytes);
    if (kind === 'Image' && stream.dictionary.get(INTENT) === undefined) {
      const previous = scan.uses.get(value.objectNumber);
      if (previous !== undefined && previous !== use.entry.intent) {
        throw new ValidationError('shared image is used under different rendering intents', 'color-space');
      }
      scan.uses.set(value.objectNumber, use.entry.intent);
    }
    if (kind !== 'Form') continue;
    if (scan.activeForms.has(value.objectNumber)) throw new ResourceLimitError('recursive form image walk is unsupported');
    const own = deref(scan, stream.dictionary.get(pdfName('Resources').bytes));
    const formResources = own?.kind === 'dictionary' ? own.entries : resources;
    const bytes = decodedData(scan.internals, stream);
    if (typeof bytes === 'string') throw new ValidationError(`form content cannot be read: ${bytes}`, 'color-operator');
    scan.activeForms.add(value.objectNumber);
    try {
      const rewritten = rewriteContentColors(scan.document, bytes, {
        resources: formResources,
        options: scan.options,
        initialState: use.entry,
        overprintNames: { off: 'PWOPM0', on: 'PWOPM1' },
      });
      scanUses(scan, formResources, rewritten.formUses);
    } finally {
      scan.activeForms.delete(value.objectNumber);
    }
  }
};

const scanPageUses = (scan: ImageScan, page: number): void => {
  const entry = scan.internals.pages[page];
  if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
  const content = pageContent(scan.internals, entry);
  if (content.problems.length > 0) throw new ValidationError(`page content cannot be read: ${content.problems.join('; ')}`, 'color-operator');
  const resources = scan.document.page(page).resources();
  const rewritten = rewriteContentColors(scan.document, combineContentStreams(content.streams), {
    resources,
    options: scan.options,
    overprintNames: { off: 'PWOPM0', on: 'PWOPM1' },
  });
  scanUses(scan, resources, rewritten.formUses);
};

const addStencil = (scan: ImageScan, plan: ImagePlan): PdfReference | undefined => {
  if (plan.stencil === undefined) return undefined;
  const dictionary = new PdfDictionaryEntries([
    [TYPE, pdfName('XObject')],
    [SUBTYPE, pdfName('Image')],
    [IMAGE_MASK, { kind: 'boolean', value: true }],
    [WIDTH, pdfInteger(imageNumber(scan, plan.image, WIDTH))],
    [HEIGHT, pdfInteger(imageNumber(scan, plan.image, HEIGHT))],
    [BITS, pdfInteger(1)],
    [FILTER, pdfName('FlateDecode')],
  ]);
  return scan.internals.objects.addProduced(dictionary, plan.stencil);
};

// ISO 32000-1:2008, 11.6.5.3, Table 146: without Matte the image data is not preblended. A converted image holds unblended samples, so it gets a copy of its soft mask without Matte; the original stays for any image that still needs it.
const unblendedSoftMask = (scan: ImageScan, matte: SoftMaskMatte, copies: Map<number, PdfReference>): PdfReference => {
  const existing = copies.get(matte.reference.objectNumber);
  if (existing !== undefined) return existing;
  const dictionary = new PdfDictionaryEntries(matte.mask.dictionary.entries());
  dictionary.delete(MATTE);
  const copy = scan.document.object({ kind: 'stream', dictionary, data: matte.mask.data });
  copies.set(matte.reference.objectNumber, copy);
  return copy;
};

const applyPlans = (scan: ImageScan): ImageConversionReport => {
  const profileReferences = new Map<string, PdfReference>();
  const softMaskCopies = new Map<number, PdfReference>();
  const discarded: PdfReference[] = [];
  const keptRgbImages: { ref: PdfReference; filter: 'DCTDecode' | 'JPXDecode'; tagged: 'added' | 'existing' | 'jpx-colr' }[] = [];
  let converted = 0;
  let changed = false;
  for (const plan of scan.plans) {
    const dictionary = new PdfDictionaryEntries(plan.image.dictionary.entries());
    if (plan.filter !== undefined) {
      let tagged: 'added' | 'existing' | 'jpx-colr' = 'existing';
      if (plan.source.kind === 'rgb' && plan.source.source.kind === 'icc' && dictionary.get(COLOR_SPACE)?.kind === 'name') {
        const profile: IccProfile = plan.source.source.profile;
        const key = sourceKey(plan.source);
        let profileReference = profileReferences.get(key);
        if (profileReference === undefined) {
          profileReference = scan.document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries([[N, pdfInteger(3)]]), data: profile.bytes });
          profileReferences.set(key, profileReference);
        }
        dictionary.set(COLOR_SPACE, pdfArray([pdfName('ICCBased'), profileReference]));
        scan.document.set(plan.reference, { kind: 'stream', dictionary, data: plan.image.data });
        changed = true;
        tagged = 'added';
      } else if (plan.explicitColorSpace !== undefined) {
        dictionary.set(COLOR_SPACE, plan.explicitColorSpace);
        scan.document.set(plan.reference, { kind: 'stream', dictionary, data: plan.image.data });
        changed = true;
        tagged = 'added';
      }
      if (dictionary.get(COLOR_SPACE) === undefined) tagged = 'jpx-colr';
      keptRgbImages.push({ ref: plan.reference, filter: plan.filter, tagged });
      continue;
    }
    if (plan.converted === undefined || plan.outputBits === undefined) throw new ValidationError('converted image has no data', 'color-space');
    dictionary.set(COLOR_SPACE, pdfName('DeviceCMYK'));
    dictionary.set(BITS, pdfInteger(plan.outputBits));
    dictionary.set(FILTER, pdfName('FlateDecode'));
    dictionary.delete(DECODE_PARMS);
    dictionary.delete(DECODE);
    const stencil = addStencil(scan, plan);
    if (stencil !== undefined) dictionary.set(MASK, stencil);
    if (plan.matte !== undefined) {
      dictionary.set(SOFT_MASK, unblendedSoftMask(scan, plan.matte, softMaskCopies));
      discarded.push(plan.matte.reference);
    }
    scan.internals.objects.setProduced(plan.reference, dictionary, plan.converted);
    converted++;
    changed = true;
  }
  if (discarded.length > 0) deleteDiscarded(scan.document, scan.internals, discarded);
  if (changed) scan.internals.objects.requireFullRewrite('color-conversion');
  return { converted, keptRgbImages };
};

/** Converts bounded RGB and calibrated gray image data and tags compressed RGB images with their source profile. */
export const convertImages = (document: LoadedDocument, options: RewriteColorOptions): ImageConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const scan: ImageScan = { document, internals, options, plans: [], seen: new Map(), uses: new Map(), transforms: new Map(), activeForms: new Set() };
  if (options.intent === undefined || options.intent === 'document') {
    for (let page = 0; page < document.pageCount; page++) scanPageUses(scan, page);
  }
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(page).resources() };
    const unreadable = walkResources(internals, entry, {
      resources,
      visit: visit => {
        scanResources(scan, visit);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('image resources cannot be read', 'unreadable-resource');
  }
  const report = applyPlans(scan);
  scan.plans.length = 0;
  return report;
};
