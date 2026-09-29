import type { ColorSource } from '../color/createColorTransform.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { IccProfile } from '../icc/iccProfile.ts';
import type { Xyz } from '../icc/iccStructure.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { colorSpaceChannels } from '../icc/iccStructure.ts';
import { pdfName } from '../object/pdfObject.ts';

export type SourceSpace =
  | { readonly kind: 'rgb'; readonly source: ColorSource }
  | { readonly kind: 'gray'; readonly source: ColorSource }
  | { readonly kind: 'deviceGray' }
  | { readonly kind: 'indexed'; readonly base: SourceSpace; readonly hival: number; readonly lookup: Uint8Array }
  | { readonly kind: 'separation' | 'deviceN'; readonly names: readonly Uint8Array[]; readonly alternate: SourceSpace; readonly tint: PdfObject }
  | { readonly kind: 'pattern'; readonly underlying?: SourceSpace }
  | { readonly kind: 'untouched' };

export interface SourceSpaceOptions {
  readonly iccGray?: 'convert' | 'keep';
}

interface ResolveContext {
  readonly document: LoadedDocument;
  readonly resources: PdfDictionaryEntries;
  readonly fallback: IccProfile;
  readonly options: SourceSpaceOptions;
  readonly depth: number;
  readonly allowDefault: boolean;
}

const COLOR_SPACE = pdfName('ColorSpace').bytes;
const DEFAULT_RGB = pdfName('DefaultRGB').bytes;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

const invalid = (detail: string): never => {
  throw new ValidationError(detail, 'color-space');
};

const child = (context: ResolveContext, allowDefault = true): ResolveContext => ({ ...context, depth: context.depth + 1, allowDefault });

const deref = (context: ResolveContext, value: PdfDirectObject | undefined): PdfObject | undefined => {
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  return internals.objects.deref(value);
};

const array = (context: ResolveContext, value: PdfDirectObject | undefined): readonly PdfDirectObject[] | undefined => {
  const found = deref(context, value);
  return found?.kind === 'array' ? found.items : undefined;
};

const dictionary = (context: ResolveContext, value: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const found = deref(context, value);
  return found?.kind === 'dictionary' ? found.entries : undefined;
};

const number = (context: ResolveContext, value: PdfDirectObject | undefined): number | undefined => {
  const found = deref(context, value);
  if (found?.kind === 'integer') return found.value;
  if (found?.kind === 'real' && typeof found.value === 'number') return found.value;
  return undefined;
};

const numbers = (context: ResolveContext, value: PdfDirectObject | undefined, length: number): number[] | undefined => {
  const items = array(context, value);
  if (items?.length !== length) return undefined;
  const result = items.map(item => number(context, item));
  if (result.some(item => item === undefined)) return undefined;
  return result.map(item => item ?? 0);
};

const whitePoint = (context: ResolveContext, entries: PdfDictionaryEntries): Xyz => {
  const values = numbers(context, entries.get(pdfName('WhitePoint').bytes), 3);
  if (values === undefined) return invalid('calibrated colour space has no valid WhitePoint');
  return { x: values[0] ?? 0, y: values[1] ?? 0, z: values[2] ?? 0 };
};

const calibrated = (context: ResolveContext, family: 'CalRGB' | 'CalGray', parameters: PdfDirectObject | undefined): SourceSpace => {
  // ISO 32000-1:2008, 8.6.5.2–8.6.5.3: WhitePoint is required; Gamma and Matrix have unit defaults.
  const entries = dictionary(context, parameters);
  if (entries === undefined) return invalid(`${family} parameters are not a dictionary`);
  const white = whitePoint(context, entries);
  if (family === 'CalGray') {
    const gamma = number(context, entries.get(pdfName('Gamma').bytes)) ?? 1;
    return context.options.iccGray === 'keep' ? { kind: 'untouched' } : { kind: 'gray', source: { kind: 'calGray', whitePoint: white, gamma } };
  }
  const gamma = numbers(context, entries.get(pdfName('Gamma').bytes), 3) ?? [1, 1, 1];
  const matrix = numbers(context, entries.get(pdfName('Matrix').bytes), 9) ?? IDENTITY;
  return {
    kind: 'rgb',
    source: {
      kind: 'calRGB',
      whitePoint: white,
      gamma: [gamma[0] ?? 1, gamma[1] ?? 1, gamma[2] ?? 1],
      matrix: [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5], matrix[6], matrix[7], matrix[8]],
    },
  };
};

const icc = (context: ResolveContext, reference: PdfDirectObject | undefined): SourceSpace => {
  // ISO 32000-1:2008, 8.6.5.5, Table 66: N gives the profile's number of colour components.
  const internals = internalsOf(context.document);
  if (internals === undefined) return invalid('document internals are unavailable');
  const stream = deref(context, reference);
  if (stream?.kind !== 'stream') return invalid('ICCBased profile is not a stream');
  const bytes = decodedData(internals, stream);
  if (typeof bytes === 'string') return invalid(`ICCBased profile cannot be read: ${bytes}`);
  const profile = parseIccProfile(bytes);
  const components = number(context, stream.dictionary.get(pdfName('N').bytes));
  if (components !== colorSpaceChannels(profile.header.colorSpace)) return invalid('ICCBased N disagrees with the profile');
  if (components === 3 && profile.header.colorSpace === 'RGB') return { kind: 'rgb', source: { kind: 'icc', profile } };
  if (components === 1 && profile.header.colorSpace === 'Gray') {
    return context.options.iccGray === 'keep' ? { kind: 'untouched' } : { kind: 'gray', source: { kind: 'icc', profile } };
  }
  return { kind: 'untouched' };
};

type Resolver = (context: ResolveContext, value: PdfDirectObject | undefined) => SourceSpace;

const named = (context: ResolveContext, name: Uint8Array, visitSpace: Resolver): SourceSpace => {
  const text = new TextDecoder('latin1').decode(name);
  if (text === 'DeviceRGB' || text === 'RGB') {
    // ISO 32000-1:2008, 8.6.5.6: DefaultRGB remaps DeviceRGB in the current resources.
    const resources = dictionary(context, context.resources.get(COLOR_SPACE));
    const replacement = context.allowDefault ? resources?.get(DEFAULT_RGB) : undefined;
    if (replacement !== undefined) return visitSpace(child(context, false), replacement);
    return { kind: 'rgb', source: { kind: 'icc', profile: context.fallback } };
  }
  if (text === 'DeviceGray' || text === 'G') return { kind: 'deviceGray' };
  if (text === 'DeviceCMYK' || text === 'CMYK' || text === 'Lab') return { kind: 'untouched' };
  if (text === 'Pattern') return { kind: 'pattern' };
  const resources = dictionary(context, context.resources.get(COLOR_SPACE));
  const value = resources?.get(name);
  if (value === undefined) return invalid(`colour space resource ${text} is missing`);
  return visitSpace(child(context, context.allowDefault), value);
};

const lookupBytes = (context: ResolveContext, value: PdfDirectObject | undefined): Uint8Array => {
  const lookup = deref(context, value);
  if (lookup?.kind === 'string') return Uint8Array.from(lookup.bytes);
  if (lookup?.kind === 'stream') {
    const internals = internalsOf(context.document);
    if (internals === undefined) return invalid('document internals are unavailable');
    const decoded = decodedData(internals, lookup);
    if (typeof decoded === 'string') return invalid(`Indexed lookup cannot be read: ${decoded}`);
    return Uint8Array.from(decoded);
  }
  return invalid('Indexed lookup is not a byte string or stream');
};

const indexed = (context: ResolveContext, items: readonly PdfDirectObject[], visitSpace: Resolver): SourceSpace => {
  // ISO 32000-1:2008, 8.6.6.3: hival is at most 255 and the lookup stores base-space components.
  const base = visitSpace(child(context), items[1]);
  const hival = number(context, items[2]);
  if (hival === undefined || !Number.isInteger(hival) || hival < 0 || hival > 255) return invalid('Indexed hival must be from 0 to 255');
  return { kind: 'indexed', base, hival, lookup: lookupBytes(context, items[3]) };
};

const colorantNames = (context: ResolveContext, value: PdfDirectObject | undefined, family: 'Separation' | 'DeviceN'): Uint8Array[] => {
  // ISO 32000-1:2008, 8.6.6.4–8.6.6.5: colorant names are PDF names, so their decoded bytes are kept unchanged.
  const first = deref(context, value);
  if (family === 'Separation') {
    if (first?.kind !== 'name') return invalid('Separation colorant name is invalid');
    return [Uint8Array.from(first.bytes)];
  }
  if (first?.kind !== 'array') return invalid('DeviceN colorant names are invalid');
  const bytes: Uint8Array[] = [];
  for (const item of first.items) {
    const name = deref(context, item);
    if (name?.kind !== 'name') return invalid('DeviceN colorant name is invalid');
    bytes.push(Uint8Array.from(name.bytes));
  }
  return bytes;
};

const special = (context: ResolveContext, spec: { items: readonly PdfDirectObject[]; family: 'Separation' | 'DeviceN' }, visitSpace: Resolver): SourceSpace => {
  const names = colorantNames(context, spec.items[1], spec.family);
  const alternate = visitSpace(child(context), spec.items[2]);
  const tint = deref(context, spec.items[3]);
  if (tint === undefined) return invalid(`${spec.family} tint transform is missing`);
  return { kind: spec.family === 'Separation' ? 'separation' : 'deviceN', names, alternate, tint };
};

const resolve: Resolver = (context, value) => {
  if (context.depth > 32) throw new ResourceLimitError('colour-space resource nesting exceeds 32 levels');
  const found = deref(context, value);
  if (found?.kind === 'name') return named(context, found.bytes, resolve);
  if (found?.kind !== 'array') return invalid('colour space is not a name or array');
  const family = deref(context, found.items[0]);
  if (family?.kind !== 'name') return invalid('colour-space family is not a name');
  const text = new TextDecoder('latin1').decode(family.bytes);
  if (text === 'ICCBased') return icc(context, found.items[1]);
  if (text === 'CalRGB' || text === 'CalGray') return calibrated(context, text, found.items[1]);
  if (text === 'Indexed' || text === 'I') return indexed(context, found.items, resolve);
  if (text === 'Separation' || text === 'DeviceN') return special(context, { items: found.items, family: text }, resolve);
  if (text === 'Pattern') {
    return found.items[1] === undefined ? { kind: 'pattern' } : { kind: 'pattern', underlying: resolve(child(context), found.items[1]) };
  }
  if (text === 'Lab') return { kind: 'untouched' };
  return invalid(`unsupported colour space ${text}`);
};

/** Resolves a content, image or shading colour space against the current resource dictionary. */
export const resolveSourceSpace = (
  document: LoadedDocument,
  value: PdfDirectObject,
  config: { readonly resources: PdfDictionaryEntries; readonly sourceRgbProfile: IccProfile; readonly options?: SourceSpaceOptions | undefined },
): SourceSpace =>
  resolve({ document, resources: config.resources, fallback: config.sourceRgbProfile, options: config.options ?? {}, depth: 0, allowDefault: true }, value);
