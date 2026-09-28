import type { ColorSource } from '../color/createColorTransform.ts';
import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { NamedInlineImage } from './inlineResources.ts';
import type { GrayFunctionPlan } from './luminosityShading.ts';
import type { OverprintNames, RewriteColorOptions } from './rewriteContent.ts';

import { calibratedProfile } from '../color/calibratedSource.ts';
import { labToXyz } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { PdfDictionaryEntries as Entries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfDictionary, pdfInteger, pdfName, pdfReal } from '../object/pdfObject.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { readImageSample } from './imageRows.ts';
import { addInlineXObjects } from './inlineResources.ts';
import { jpxHasRgbColor } from './jpxColor.ts';
import { deviceRgbLuminosity, rewriteDeviceRgbLuminosity } from './luminosityContent.ts';
import { grayInlineImage } from './luminosityInline.ts';
import { grayFunctionShading } from './luminosityShading.ts';
import { addOverprintStates, chooseOverprintNames } from './overprintResources.ts';
import { rewriteContentColors } from './rewriteContent.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

interface MaskGroup {
  readonly reference: PdfReference;
  readonly form: PdfStream;
  readonly group: PdfDictionaryEntries;
  readonly data: Uint8Array;
  readonly outputSpace: 'DeviceGray' | 'DeviceCMYK';
  readonly resources?: PdfDictionaryEntries | undefined;
  readonly overprintNames?: OverprintNames;
  readonly overprintAdjustments?: number;
  readonly newInlineImages?: readonly NamedInlineImage[];
  readonly grayXObjects?: readonly GrayXObjectPlan[];
  readonly grayShadings?: readonly GrayShadingPlan[];
}

interface GrayXObjectPlan {
  readonly name: Uint8Array;
  readonly stream: PdfStream;
  readonly resources?: PdfDictionaryEntries | undefined;
  readonly children: readonly GrayXObjectPlan[];
  readonly shadings: readonly GrayShadingPlan[];
}

interface GrayShadingPlan {
  readonly name: Uint8Array;
  readonly dictionary: PdfDictionaryEntries;
  readonly functionPlan: GrayFunctionPlan | undefined;
  readonly data: Uint8Array | undefined;
}

interface MaskResource {
  readonly owner: PdfReference;
  readonly resources: PdfDictionaryEntries;
  readonly stateName: Uint8Array;
  readonly state: PdfDictionaryEntries;
  readonly mask: PdfDictionaryEntries;
}

export interface LuminosityPreparation {
  readonly groupNumbers: ReadonlySet<number>;
  readonly changed: number;
  readonly kept: number;
  readonly approximated: number;
  apply: () => void;
}

interface MaskScan {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
  readonly options: RewriteColorOptions;
  readonly groups: Map<number, MaskGroup>;
  readonly resources: MaskResource[];
  readonly kept: Set<number>;
  readonly approximated: Set<number>;
  readonly seenForms: Set<number>;
  readonly seenCarriers: Set<number>;
}

const EXT_G_STATE = pdfName('ExtGState').bytes;
const PATTERN = pdfName('Pattern').bytes;
const PATTERN_TYPE = pdfName('PatternType').bytes;
const FONT = pdfName('Font').bytes;
const CHAR_PROCS = pdfName('CharProcs').bytes;
const ANNOTS = pdfName('Annots').bytes;
const AP = pdfName('AP').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const RESOURCES = pdfName('Resources').bytes;
const GROUP = pdfName('Group').bytes;
const COLOR_SPACE = pdfName('CS').bytes;
const MASK = pdfName('SMask').bytes;
const MASK_SUBTYPE = pdfName('S').bytes;
const MASK_GROUP = pdfName('G').bytes;
const BACKDROP = pdfName('BC').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const COLOR_SPACE_ENTRY = pdfName('ColorSpace').bytes;
const SHADING = pdfName('Shading').bytes;
const WIDTH = pdfName('Width').bytes;
const HEIGHT = pdfName('Height').bytes;
const BITS = pdfName('BitsPerComponent').bytes;
const DECODE = pdfName('Decode').bytes;

const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);

const filterName = (value: PdfObject | undefined): string | undefined => {
  if (value?.kind === 'name') return nameOf(value);
  if (value?.kind === 'array') return value.items.map(item => nameOf(item)).find(name => name === 'DCTDecode' || name === 'DCT' || name === 'JPXDecode');
  return undefined;
};

const compressedRgbFilter = (filter: string | undefined): boolean => filter === 'DCTDecode' || filter === 'DCT' || filter === 'JPXDecode';

const inlineParameter = (parameters: readonly PdfDirectObject[], names: readonly string[]): PdfDirectObject | undefined => {
  for (let index = 0; index + 1 < parameters.length; index += 2) {
    const key = nameOf(parameters[index]);
    if (key !== undefined && names.includes(key)) return parameters[index + 1];
  }
  return undefined;
};

const checkCompressedRgbImages = (scan: MaskScan, bytes: Uint8Array, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(XOBJECT));
  for (const operation of readContent(bytes, scan.internals.maxNesting)) {
    if (operation.operator === 'Do') {
      const [operand] = operation.operands;
      if (operand?.kind !== 'name' || category?.kind !== 'dictionary') continue;
      const image = scan.internals.objects.deref(category.entries.get(operand.bytes));
      if (image?.kind !== 'stream' || nameOf(scan.internals.objects.deref(image.dictionary.get(SUBTYPE))) !== 'Image') continue;
      const filter = filterName(scan.internals.objects.deref(image.dictionary.get(FILTER)));
      if (!compressedRgbFilter(filter)) continue;
      const color = image.dictionary.get(COLOR_SPACE_ENTRY);
      const rgb =
        color === undefined
          ? filter === 'JPXDecode' && jpxHasRgbColor(image.data, scan.internals.maxDecodedBytes)
          : resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile }).kind === 'rgb';
      if (rgb) throw new UnsupportedFeatureError('compressed RGB image in a luminosity mask', 'luminosity-compressed-rgb-image');
    }
    if (operation.operator === 'BI' && operation.inlineImage !== undefined) {
      const parameters = operation.inlineImage.parameters.filter(value => value.kind !== 'stray-delimiter');
      const filter = filterName(inlineParameter(parameters, ['F', 'Filter']));
      const color = inlineParameter(parameters, ['CS', 'ColorSpace']);
      if (compressedRgbFilter(filter) && color !== undefined) {
        const rgb = resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile }).kind === 'rgb';
        if (rgb) throw new UnsupportedFeatureError('compressed RGB inline image in a luminosity mask', 'luminosity-compressed-rgb-image');
      }
    }
  }
};

const imageInteger = (scan: MaskScan, image: PdfStream, key: Uint8Array): number => {
  const value = scan.internals.objects.deref(image.dictionary.get(key));
  if (value?.kind !== 'integer' || !Number.isSafeInteger(value.value) || value.value < 1) {
    throw new ValidationError('luminosity image dimensions or bit depth are invalid', 'color-space');
  }
  return value.value;
};

const imageDecode = (scan: MaskScan, image: PdfStream): number[] => {
  const value = scan.internals.objects.deref(image.dictionary.get(DECODE));
  if (value === undefined) return [0, 1, 0, 1, 0, 1];
  if (value.kind !== 'array' || value.items.length !== 6) throw new ValidationError('luminosity image Decode is invalid', 'color-space');
  return value.items.map(item => {
    const resolved = scan.internals.objects.deref(item);
    if ((resolved?.kind !== 'integer' && resolved?.kind !== 'real') || typeof resolved.value !== 'number') {
      throw new ValidationError('luminosity image Decode is invalid', 'color-space');
    }
    return resolved.value;
  });
};

const grayImage = (scan: MaskScan, image: PdfStream, rgbToGray: (values: readonly number[]) => number): PdfStream => {
  const width = imageInteger(scan, image, WIDTH);
  const height = imageInteger(scan, image, HEIGHT);
  const bits = imageInteger(scan, image, BITS);
  if (![1, 2, 4, 8, 16].includes(bits)) throw new UnsupportedFeatureError('luminosity image bit depth is unsupported');
  const inputRowBytes = Math.ceil((width * 3 * bits) / 8);
  const outputBits = bits === 16 ? 16 : 8;
  const outputRowBytes = width * (outputBits / 8);
  if (!Number.isSafeInteger((inputRowBytes + outputRowBytes) * height) || (inputRowBytes + outputRowBytes) * height > scan.internals.maxDecodedBytes) {
    throw new ResourceLimitError('luminosity image exceeds maxDecodedBytes');
  }
  const data = decodedData(scan.internals, image);
  if (typeof data === 'string') throw new ValidationError(`luminosity image cannot be decoded: ${data}`, 'color-space');
  if (data.length !== inputRowBytes * height) throw new ValidationError('luminosity image sample count is invalid', 'color-space');
  const output = new Uint8Array(outputRowBytes * height);
  const decode = imageDecode(scan, image);
  const maximum = 2 ** bits - 1;
  const outputMaximum = 2 ** outputBits - 1;
  for (let row = 0; row < height; row++) {
    const input = data.subarray(row * inputRowBytes, (row + 1) * inputRowBytes);
    for (let pixel = 0; pixel < width; pixel++) {
      const rgb = Array.from({ length: 3 }, (_, channel) => {
        const raw = readImageSample(input, pixel * 3 + channel, bits) / maximum;
        return (decode[channel * 2] ?? 0) + raw * ((decode[channel * 2 + 1] ?? 1) - (decode[channel * 2] ?? 0));
      });
      const luminance = rgbToGray(rgb);
      const gray = Math.round(Math.min(1, Math.max(0, luminance)) * outputMaximum);
      const offset = row * outputRowBytes + pixel * (outputBits / 8);
      if (outputBits === 8) output[offset] = gray;
      else {
        output[offset] = Math.floor(gray / 256);
        output[offset + 1] = gray % 256;
      }
    }
  }
  const dictionary = new Entries(image.dictionary.entries());
  dictionary.set(COLOR_SPACE_ENTRY, pdfName('DeviceGray'));
  dictionary.set(BITS, pdfInteger(outputBits));
  dictionary.set(FILTER, pdfName('FlateDecode'));
  dictionary.delete(DECODE);
  dictionary.delete(DECODE_PARMS);
  return { kind: 'stream', dictionary, data: deflateZlib(output) };
};

const cieLuminosity = (source: ColorSource, encoding: 'icc' | 'adobe'): ((values: readonly number[]) => number) => {
  const profile = source.kind === 'icc' ? source.profile : calibratedProfile(source);
  const toPcs = sourceEvaluator(profile, 'relativeColorimetric', encoding);
  return values => {
    const pcs = toPcs(values);
    return pcs.space === 'XYZ' ? (pcs.values[1] ?? 0) : (labToXyz(pcs.values)[1] ?? 0);
  };
};

const planGrayShadings = (
  scan: MaskScan,
  config: { bytes: Uint8Array; resources: PdfDictionaryEntries; paintGray: (values: readonly number[]) => number },
): readonly GrayShadingPlan[] => {
  const { bytes, resources, paintGray } = config;
  const category = scan.internals.objects.deref(resources.get(SHADING));
  const plans: GrayShadingPlan[] = [];
  const seen = new Set<string>();
  for (const operation of readContent(bytes, scan.internals.maxNesting)) {
    if (operation.operator !== 'sh') continue;
    const [operand] = operation.operands;
    if (operand?.kind !== 'name' || category?.kind !== 'dictionary') throw new ValidationError('luminosity Shading resource is missing', 'color-space');
    const key = [...operand.bytes].join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const shading = scan.internals.objects.deref(category.entries.get(operand.bytes));
    if (shading?.kind !== 'dictionary' && shading?.kind !== 'stream') throw new ValidationError('luminosity shading is missing', 'color-space');
    const shadingEntries = shading.kind === 'dictionary' ? shading.entries : shading.dictionary;
    const color = shadingEntries.get(COLOR_SPACE_ENTRY);
    if (color === undefined) throw new ValidationError('luminosity shading ColorSpace is missing', 'color-space');
    const space = resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile });
    if (space.kind === 'gray') continue;
    if (space.kind !== 'rgb') throw new UnsupportedFeatureError('luminosity shading colour space is unsupported');
    const name = nameOf(scan.internals.objects.deref(color));
    const gray = name === 'DeviceRGB' || name === 'RGB' ? paintGray : cieLuminosity(space.source, scan.options.lut8LabEncoding ?? 'icc');
    const planned = grayFunctionShading(scan.internals, shading, gray);
    plans.push({ name: Uint8Array.from(operand.bytes), ...planned });
  }
  return plans;
};

interface GrayWalk {
  readonly bytes: Uint8Array;
  readonly resources: PdfDictionaryEntries;
  readonly paintGray: (values: readonly number[]) => number;
  readonly active: ReadonlySet<number>;
}

const planGrayForm = (
  scan: MaskScan,
  input: { name: Uint8Array; reference: PdfReference; form: PdfStream; walk: GrayWalk; recurse: (walk: GrayWalk) => readonly GrayXObjectPlan[] },
): GrayXObjectPlan => {
  const { name, reference, form, walk, recurse } = input;
  if (walk.active.size >= scan.internals.maxNesting || walk.active.has(reference.objectNumber)) {
    throw new ResourceLimitError('luminosity form nesting exceeds maxNesting');
  }
  const own = scan.internals.objects.deref(form.dictionary.get(RESOURCES));
  const resources = own?.kind === 'dictionary' ? own.entries : walk.resources;
  const bytes = decodedData(scan.internals, form);
  if (typeof bytes === 'string') throw new ValidationError(`luminosity form cannot be read: ${bytes}`, 'color-operator');
  checkCompressedRgbImages(scan, bytes, resources);
  const children = recurse({ bytes, resources, paintGray: walk.paintGray, active: new Set([...walk.active, reference.objectNumber]) });
  const shadings = planGrayShadings(scan, { bytes, resources, paintGray: walk.paintGray });
  const rewritten = rewriteDeviceRgbLuminosity(bytes, walk.paintGray, image => grayInlineImage(image, walk.paintGray, scan.internals.maxDecodedBytes));
  if (rewritten.length > scan.internals.maxDecodedBytes) throw new ResourceLimitError('converted luminosity form exceeds maxDecodedBytes');
  const dictionary = new Entries(form.dictionary.entries());
  const groupValue = scan.internals.objects.deref(dictionary.get(GROUP));
  if (groupValue?.kind === 'dictionary' && groupValue.entries.get(COLOR_SPACE) !== undefined) {
    const group = new Entries(groupValue.entries.entries());
    group.set(COLOR_SPACE, pdfName('DeviceGray'));
    dictionary.set(GROUP, pdfDictionary(group));
  }
  dictionary.set(FILTER, pdfName('FlateDecode'));
  dictionary.delete(DECODE_PARMS);
  return { name, stream: { kind: 'stream', dictionary, data: deflateZlib(rewritten) }, resources, children, shadings };
};

const planGrayImage = (
  scan: MaskScan,
  input: { name: Uint8Array; image: PdfStream; resources: PdfDictionaryEntries; paintGray: (values: readonly number[]) => number },
): GrayXObjectPlan | undefined => {
  const { name, image, resources, paintGray } = input;
  const color = image.dictionary.get(COLOR_SPACE_ENTRY);
  if (color === undefined) throw new ValidationError('luminosity image ColorSpace is missing', 'color-space');
  const space = resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile });
  if (space.kind === 'gray') return undefined;
  if (space.kind !== 'rgb') throw new UnsupportedFeatureError('luminosity image colour space is unsupported');
  const gray = nameOf(scan.internals.objects.deref(color));
  const imageGray = gray === 'DeviceRGB' || gray === 'RGB' ? paintGray : cieLuminosity(space.source, scan.options.lut8LabEncoding ?? 'icc');
  return { name, stream: grayImage(scan, image, imageGray), children: [], shadings: [] };
};

const planGrayXObjects = (scan: MaskScan, walk: GrayWalk): readonly GrayXObjectPlan[] => {
  const { bytes, resources } = walk;
  const category = scan.internals.objects.deref(resources.get(XOBJECT));
  const plans: GrayXObjectPlan[] = [];
  const seen = new Set<string>();
  for (const operation of readContent(bytes, scan.internals.maxNesting)) {
    if (operation.operator !== 'Do') continue;
    const [operand] = operation.operands;
    if (operand?.kind !== 'name' || category?.kind !== 'dictionary') throw new ValidationError('luminosity XObject is missing', 'color-space');
    const key = [...operand.bytes].join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const reference = category.entries.get(operand.bytes);
    const object = scan.internals.objects.deref(reference);
    if (reference?.kind !== 'reference' || object?.kind !== 'stream') throw new ValidationError('luminosity XObject is missing', 'color-space');
    const subtype = nameOf(scan.internals.objects.deref(object.dictionary.get(SUBTYPE)));
    if (subtype === 'Form') {
      plans.push(planGrayForm(scan, { name: Uint8Array.from(operand.bytes), reference, form: object, walk, recurse: child => planGrayXObjects(scan, child) }));
      continue;
    }
    if (subtype !== 'Image') throw new UnsupportedFeatureError('luminosity mask XObject subtype is unsupported');
    const planned = planGrayImage(scan, { name: Uint8Array.from(operand.bytes), image: object, resources, paintGray: walk.paintGray });
    if (planned !== undefined) plans.push(planned);
  }
  return plans;
};

const numberOf = (value: PdfDirectObject): number => {
  if (value.kind === 'integer') return value.value;
  if (value.kind === 'real' && typeof value.value === 'number') return value.value;
  throw new ValidationError('soft-mask backdrop is not numeric', 'color-space');
};

const convertBackdrop = (mask: PdfDictionaryEntries, rgbToGray: (values: readonly number[]) => number): PdfDictionaryEntries => {
  const mapped = new Entries(mask.entries());
  const backdrop = mask.get(BACKDROP);
  if (backdrop === undefined) return mapped;
  if (backdrop.kind !== 'array' || backdrop.items.length !== 3) throw new ValidationError('RGB soft-mask backdrop needs three components', 'color-space');
  const values = backdrop.items.map(item => numberOf(item));
  const gray = rgbToGray(values);
  mapped.set(BACKDROP, pdfArray([pdfReal(gray)]));
  return mapped;
};

const maskGroupForm = (scan: MaskScan, mask: PdfDictionaryEntries) => {
  const groupReference = mask.get(MASK_GROUP);
  if (groupReference?.kind !== 'reference') throw new ValidationError('luminosity mask group is not indirect', 'color-space');
  const form = scan.internals.objects.deref(groupReference);
  if (form?.kind !== 'stream') throw new ValidationError('luminosity mask group is missing', 'color-space');
  const groupValue = scan.internals.objects.deref(form.dictionary.get(GROUP));
  if (groupValue?.kind !== 'dictionary') throw new ValidationError('luminosity mask has no transparency group', 'color-space');
  return { reference: groupReference, form, group: groupValue.entries };
};

const planAlphaMask = (
  scan: MaskScan,
  input: { reference: PdfReference; form: PdfStream; group: PdfDictionaryEntries; resources: PdfDictionaryEntries },
): void => {
  const { reference, form, group, resources } = input;
  if (scan.groups.has(reference.objectNumber)) return;
  const color = group.get(COLOR_SPACE);
  if (color === undefined) return;
  const source = resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile });
  if (source.kind !== 'rgb') return;
  if (scan.options.blendingSpace === 'refuse') throw new ValidationError('RGB alpha mask group would change blending space', 'blend-space-change');
  const bytes = decodedData(scan.internals, form);
  if (typeof bytes === 'string') throw new ValidationError(`alpha mask content cannot be read: ${bytes}`, 'color-operator');
  const names = chooseOverprintNames(scan.document, resources);
  const rewritten = rewriteContentColors(scan.document, bytes, { resources, options: scan.options, overprintNames: names });
  if (rewritten.formUses.length > 0) throw new UnsupportedFeatureError('alpha mask contains a nested form');
  if (rewritten.bytes.length > scan.internals.maxDecodedBytes) throw new ResourceLimitError('converted alpha mask exceeds maxDecodedBytes');
  scan.groups.set(reference.objectNumber, {
    reference,
    form,
    group,
    data: deflateZlib(rewritten.bytes),
    outputSpace: 'DeviceCMYK',
    resources,
    overprintNames: names,
    overprintAdjustments: rewritten.overprintAdjustments,
    newInlineImages: rewritten.newInlineImages,
  });
};

const planRgbLuminosityMask = (
  scan: MaskScan,
  input: {
    owner: PdfReference;
    resources: PdfDictionaryEntries;
    name: Uint8Array;
    state: PdfDictionaryEntries;
    mask: PdfDictionaryEntries;
    groupForm: ReturnType<typeof maskGroupForm>;
    groupResources: PdfDictionaryEntries;
  },
): void => {
  const { owner, resources, name, state, mask, groupForm, groupResources } = input;
  const { reference: groupReference, form, group } = groupForm;
  const color = group.get(COLOR_SPACE);
  if (color === undefined) return;
  const space = resolveSourceSpace(scan.document, color, { resources: groupResources, sourceRgbProfile: scan.options.sourceRgbProfile });
  if (space.kind !== 'rgb') return;
  const colorValue = scan.internals.objects.deref(color);
  const explicit = nameOf(colorValue);
  const cie = explicit !== 'DeviceRGB' && explicit !== 'RGB';
  const bytes = decodedData(scan.internals, form);
  if (typeof bytes === 'string') throw new ValidationError(`luminosity mask content cannot be read: ${bytes}`, 'color-operator');
  checkCompressedRgbImages(scan, bytes, groupResources);
  if (cie && scan.options.luminosityGroups !== 'gray') {
    scan.kept.add(groupReference.objectNumber);
    return;
  }
  if (scan.options.blendingSpace === 'refuse') throw new ValidationError('RGB luminosity group would change blending space', 'blend-space-change');
  if (!scan.groups.has(groupReference.objectNumber)) {
    const rgbSource = resolveSourceSpace(scan.document, pdfName('DeviceRGB'), { resources: groupResources, sourceRgbProfile: scan.options.sourceRgbProfile });
    if (rgbSource.kind !== 'rgb') throw new ValidationError('DeviceRGB does not resolve to an RGB profile', 'color-space');
    const paintGray = cie ? cieLuminosity(rgbSource.source, scan.options.lut8LabEncoding ?? 'icc') : deviceRgbLuminosity;
    const grayXObjects = planGrayXObjects(scan, { bytes, resources: groupResources, paintGray, active: new Set([groupReference.objectNumber]) });
    const grayShadings = planGrayShadings(scan, { bytes, resources: groupResources, paintGray });
    const rewritten = rewriteDeviceRgbLuminosity(bytes, paintGray, image => grayInlineImage(image, paintGray, scan.internals.maxDecodedBytes));
    if (rewritten.length > scan.internals.maxDecodedBytes) throw new ResourceLimitError('converted luminosity mask exceeds maxDecodedBytes');
    scan.groups.set(groupReference.objectNumber, {
      reference: groupReference,
      form,
      group,
      data: deflateZlib(rewritten),
      outputSpace: 'DeviceGray',
      resources: grayXObjects.length === 0 && grayShadings.length === 0 ? undefined : groupResources,
      grayXObjects,
      grayShadings,
    });
    if (cie) scan.approximated.add(groupReference.objectNumber);
  }
  const backdropGray = cie ? cieLuminosity(space.source, scan.options.lut8LabEncoding ?? 'icc') : deviceRgbLuminosity;
  scan.resources.push({ owner, resources, stateName: Uint8Array.from(name), state, mask: convertBackdrop(mask, backdropGray) });
};

const planMask = (scan: MaskScan, input: { owner: PdfReference; resources: PdfDictionaryEntries; name: Uint8Array; state: PdfDictionaryEntries }): void => {
  const { resources, state } = input;
  const maskValue = scan.internals.objects.deref(state.get(MASK));
  if (maskValue?.kind !== 'dictionary') return;
  const subtype = nameOf(scan.internals.objects.deref(maskValue.entries.get(MASK_SUBTYPE)));
  if (subtype !== 'Luminosity' && subtype !== 'Alpha') return;
  const groupForm = maskGroupForm(scan, maskValue.entries);
  const own = scan.internals.objects.deref(groupForm.form.dictionary.get(RESOURCES));
  const groupResources = own?.kind === 'dictionary' ? own.entries : resources;
  if (subtype === 'Alpha') {
    planAlphaMask(scan, { ...groupForm, resources: groupResources });
    return;
  }
  planRgbLuminosityMask(scan, { ...input, mask: maskValue.entries, groupForm, groupResources });
};

const scanContent = (scan: MaskScan, scope: { owner: PdfReference; resources: PdfDictionaryEntries; content: Uint8Array | readonly Uint8Array[] }): void => {
  const { owner, resources, content } = scope;
  const category = scan.internals.objects.deref(resources.get(EXT_G_STATE));
  if (category?.kind !== 'dictionary') return;
  for (const operation of readContent(content, scan.internals.maxNesting)) {
    if (operation.operator !== 'gs') continue;
    const [operand] = operation.operands;
    if (operand?.kind !== 'name') continue;
    const state = scan.internals.objects.deref(category.entries.get(operand.bytes));
    if (state?.kind === 'dictionary') planMask(scan, { owner, resources, name: operand.bytes, state: state.entries });
  }
};

const scanForms = (scan: MaskScan, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(XOBJECT));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference' || scan.seenForms.has(value.objectNumber)) continue;
    const form = scan.internals.objects.deref(value);
    if (form?.kind !== 'stream') continue;
    if (nameOf(scan.internals.objects.deref(form.dictionary.get(SUBTYPE))) !== 'Form') continue;
    scan.seenForms.add(value.objectNumber);
    const own = scan.internals.objects.deref(form.dictionary.get(RESOURCES));
    const formResources = own?.kind === 'dictionary' ? own.entries : resources;
    const bytes = decodedData(scan.internals, form);
    if (typeof bytes === 'string') throw new ValidationError(`form content cannot be read: ${bytes}`, 'color-operator');
    scanContent(scan, { owner: value, resources: formResources, content: bytes });
    scanForms(scan, formResources);
  }
};

const scanCarrier = (scan: MaskScan, reference: PdfReference, fallback: PdfDictionaryEntries): void => {
  if (scan.seenCarriers.has(reference.objectNumber)) return;
  scan.seenCarriers.add(reference.objectNumber);
  const stream = scan.internals.objects.deref(reference);
  if (stream?.kind !== 'stream') return;
  const own = scan.internals.objects.deref(stream.dictionary.get(RESOURCES));
  const resources = own?.kind === 'dictionary' ? own.entries : fallback;
  const bytes = decodedData(scan.internals, stream);
  if (typeof bytes === 'string') throw new ValidationError(`carrier content cannot be read: ${bytes}`, 'color-operator');
  scanContent(scan, { owner: reference, resources, content: bytes });
  scanForms(scan, resources);
};

const scanPatterns = (scan: MaskScan, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(PATTERN));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    if (value.kind !== 'reference') continue;
    const pattern = scan.internals.objects.deref(value);
    if (pattern?.kind !== 'stream') continue;
    const type = pattern.dictionary.get(PATTERN_TYPE);
    if (type?.kind === 'integer' && type.value === 1) scanCarrier(scan, value, resources);
  }
};

const scanGlyphs = (scan: MaskScan, resources: PdfDictionaryEntries): void => {
  const category = scan.internals.objects.deref(resources.get(FONT));
  if (category?.kind !== 'dictionary') return;
  for (const [, value] of category.entries.entries()) {
    const font = scan.internals.objects.deref(value);
    if (font?.kind !== 'dictionary' || nameOf(scan.internals.objects.deref(font.entries.get(SUBTYPE))) !== 'Type3') continue;
    const own = scan.internals.objects.deref(font.entries.get(RESOURCES));
    const effective = own?.kind === 'dictionary' ? own.entries : resources;
    const glyphs = scan.internals.objects.deref(font.entries.get(CHAR_PROCS));
    if (glyphs?.kind !== 'dictionary') continue;
    for (const [, glyph] of glyphs.entries.entries()) {
      if (glyph.kind !== 'reference') continue;
      const stream = scan.internals.objects.deref(glyph);
      if (stream?.kind !== 'stream') continue;
      const bytes = decodedData(scan.internals, stream);
      if (typeof bytes === 'string') throw new ValidationError(`glyph content cannot be read: ${bytes}`, 'color-operator');
      const [first] = readContent(bytes, scan.internals.maxNesting);
      if (first?.operator === 'd0') scanCarrier(scan, glyph, effective);
    }
  }
};

const scanAppearances = (scan: MaskScan, page: PdfReference, resources: PdfDictionaryEntries): void => {
  const owner = scan.internals.objects.deref(page);
  if (owner?.kind !== 'dictionary') return;
  const annotations = scan.internals.objects.deref(owner.entries.get(ANNOTS));
  if (annotations?.kind !== 'array') return;
  for (const annotation of annotations.items) {
    const item = scan.internals.objects.deref(annotation);
    if (item?.kind !== 'dictionary') continue;
    const appearances = scan.internals.objects.deref(item.entries.get(AP));
    if (appearances?.kind !== 'dictionary') continue;
    for (const state of ['N', 'R', 'D']) {
      const entry = appearances.entries.get(pdfName(state).bytes);
      if (entry?.kind === 'reference') scanCarrier(scan, entry, resources);
      const variants = scan.internals.objects.deref(entry);
      if (variants?.kind !== 'dictionary') continue;
      for (const [, value] of variants.entries.entries()) if (value.kind === 'reference') scanCarrier(scan, value, resources);
    }
  }
};

const writeGrayFunction = (scan: MaskScan, plan: GrayFunctionPlan): PdfReference => {
  if (plan.kind === 'sampled') return scan.document.object(plan.stream);
  const children = plan.children.map(child => writeGrayFunction(scan, child));
  const dictionary = new Entries(plan.dictionary.entries());
  dictionary.set(pdfName('Functions').bytes, pdfArray(children));
  return scan.document.object(pdfDictionary(dictionary));
};

const grayShadings = (scan: MaskScan, resources: PdfDictionaryEntries, plans: readonly GrayShadingPlan[]): PdfDictionaryEntries => {
  const original = scan.internals.objects.deref(resources.get(SHADING));
  if (original?.kind !== 'dictionary') throw new ValidationError('luminosity Shading resources are missing', 'color-space');
  const shadings = new Entries(original.entries.entries());
  for (const plan of plans) {
    const dictionary = new Entries(plan.dictionary.entries());
    if (plan.functionPlan !== undefined) dictionary.set(pdfName('Function').bytes, writeGrayFunction(scan, plan.functionPlan));
    const object = plan.data === undefined ? pdfDictionary(dictionary) : { kind: 'stream' as const, dictionary, data: plan.data };
    shadings.set(plan.name, scan.document.object(object));
  }
  const mapped = new Entries(resources.entries());
  mapped.set(SHADING, pdfDictionary(shadings));
  return mapped;
};

const grayXObjects = (scan: MaskScan, resources: PdfDictionaryEntries, plans: readonly GrayXObjectPlan[]): PdfDictionaryEntries => {
  const original = scan.internals.objects.deref(resources.get(XOBJECT));
  if (original?.kind !== 'dictionary') throw new ValidationError('luminosity XObjects are missing', 'color-space');
  const xobjects = new Entries(original.entries.entries());
  for (const plan of plans) {
    const dictionary = new Entries(plan.stream.dictionary.entries());
    if (plan.children.length > 0 || plan.shadings.length > 0) {
      if (plan.resources === undefined) throw new ValidationError('luminosity form resources are missing', 'color-space');
      let mapped = plan.resources;
      if (plan.children.length > 0) mapped = grayXObjects(scan, mapped, plan.children);
      if (plan.shadings.length > 0) mapped = grayShadings(scan, mapped, plan.shadings);
      dictionary.set(RESOURCES, pdfDictionary(mapped));
    }
    xobjects.set(plan.name, scan.document.object({ kind: 'stream', dictionary, data: plan.stream.data }));
  }
  const mapped = new Entries(resources.entries());
  mapped.set(XOBJECT, pdfDictionary(xobjects));
  return mapped;
};

const applyGroups = (scan: MaskScan, discarded: PdfReference[]): void => {
  for (const plan of scan.groups.values()) {
    const dictionary = new Entries(plan.form.dictionary.entries());
    const group = new Entries(plan.group.entries());
    group.set(COLOR_SPACE, pdfName(plan.outputSpace));
    const oldGroup = dictionary.get(GROUP);
    if (oldGroup?.kind === 'reference') discarded.push(oldGroup);
    dictionary.set(GROUP, pdfDictionary(group));
    dictionary.set(FILTER, pdfName('FlateDecode'));
    dictionary.delete(DECODE_PARMS);
    if (plan.resources !== undefined) {
      const resources = new Entries(plan.resources.entries());
      if (plan.overprintAdjustments !== undefined && plan.overprintAdjustments > 0 && plan.overprintNames !== undefined) {
        addOverprintStates(scan.document, resources, plan.overprintNames);
      }
      addInlineXObjects(scan.document, resources, plan.newInlineImages ?? []);
      if (plan.grayXObjects !== undefined && plan.grayXObjects.length > 0) {
        const mapped = grayXObjects(scan, resources, plan.grayXObjects);
        const xobjects = mapped.get(XOBJECT);
        if (xobjects === undefined) throw new ValidationError('luminosity XObjects are missing', 'color-space');
        resources.set(XOBJECT, xobjects);
      }
      if (plan.grayShadings !== undefined && plan.grayShadings.length > 0) {
        const mapped = grayShadings(scan, resources, plan.grayShadings);
        const shadings = mapped.get(SHADING);
        if (shadings === undefined) throw new ValidationError('luminosity Shading resources are missing', 'color-space');
        resources.set(SHADING, shadings);
      }
      const oldResources = dictionary.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      dictionary.set(RESOURCES, pdfDictionary(resources));
    }
    scan.document.set(plan.reference, { kind: 'stream', dictionary, data: plan.data });
  }
};

const applyResources = (scan: MaskScan, discarded: PdfReference[]): void => {
  const grouped = new Map<number, MaskResource[]>();
  for (const plan of scan.resources) {
    const list = grouped.get(plan.owner.objectNumber) ?? [];
    list.push(plan);
    grouped.set(plan.owner.objectNumber, list);
  }
  for (const group of grouped.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const original = scan.internals.objects.deref(first.resources.get(EXT_G_STATE));
    if (original?.kind !== 'dictionary') throw new ValidationError('ExtGState resources are missing', 'color-space');
    const states = new Entries(original.entries.entries());
    for (const plan of group) {
      const state = new Entries(plan.state.entries());
      const oldMask = state.get(MASK);
      if (oldMask?.kind === 'reference') discarded.push(oldMask);
      state.set(MASK, pdfDictionary(plan.mask));
      const oldState = original.entries.get(plan.stateName);
      if (oldState?.kind === 'reference') discarded.push(oldState);
      states.set(plan.stateName, pdfDictionary(state));
    }
    const resources = new Entries(first.resources.entries());
    const oldStates = resources.get(EXT_G_STATE);
    if (oldStates?.kind === 'reference') discarded.push(oldStates);
    resources.set(EXT_G_STATE, pdfDictionary(states));
    const owner = scan.document.get(first.owner);
    if (owner.kind === 'dictionary') {
      const oldResources = owner.entries.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      owner.entries.set(RESOURCES, pdfDictionary(resources));
      scan.document.set(first.owner, owner);
    } else if (owner.kind === 'stream') {
      const dictionary = new Entries(owner.dictionary.entries());
      const oldResources = dictionary.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      dictionary.set(RESOURCES, pdfDictionary(resources));
      scan.document.set(first.owner, { kind: 'stream', dictionary, data: owner.data });
    }
  }
};

/** Prepares RGB luminosity masks before any document edits are made. */
export const prepareLuminosityMasks = (document: LoadedDocument, options: RewriteColorOptions): LuminosityPreparation => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const scan: MaskScan = {
    document,
    internals,
    options,
    groups: new Map(),
    resources: [],
    kept: new Set(),
    approximated: new Set(),
    seenForms: new Set(),
    seenCarriers: new Set(),
  };
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) throw new ValidationError('page content cannot be read', 'color-operator');
    const resources = document.page(page).resources();
    scanContent(scan, { owner: entry.reference, resources, content: content.streams });
    scanForms(scan, resources);
    scanPatterns(scan, resources);
    scanGlyphs(scan, resources);
    scanAppearances(scan, entry.reference, resources);
    const unreadable = walkResources(internals, entry, {
      resources: pdfDictionary(resources),
      visit: visit => {
        scanForms(scan, visit.resources);
        scanPatterns(scan, visit.resources);
        scanGlyphs(scan, visit.resources);
      },
    });
    if (unreadable.length > 0) throw new ValidationError('mask carriers cannot be read', 'unreadable-resource');
  }
  return {
    groupNumbers: new Set([...scan.groups.keys(), ...scan.kept]),
    changed: scan.groups.size,
    kept: scan.kept.size,
    approximated: scan.approximated.size,
    apply() {
      if (scan.groups.size === 0) return;
      const discarded: PdfReference[] = [];
      applyGroups(scan, discarded);
      applyResources(scan, discarded);
      deleteDiscarded(document, internals, discarded);
      internals.objects.requireFullRewrite('color-conversion');
    },
  };
};
