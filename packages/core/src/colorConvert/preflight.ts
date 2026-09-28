import type { PdfDate } from '../date/pdfDate.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { IccProfile } from '../icc/iccProfile.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { ResourceVisit } from '../resourceGraph/walkResources.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';
import { walkResources } from '../resourceGraph/walkResources.ts';

export interface ConversionPreflightPolicy {
  readonly applicationData?: 'refuse' | 'remove' | { readonly invalidate: PdfDate };
  readonly removeDefaultGray?: boolean;
  readonly outputIntent?: { readonly existing?: 'refuse' | 'replace' };
}

const PIECE_INFO = pdfName('PieceInfo').bytes;
const OUTPUT_INTENTS = pdfName('OutputIntents').bytes;
const DEST_OUTPUT_PROFILE = pdfName('DestOutputProfile').bytes;
const COLOR_SPACE = pdfName('ColorSpace').bytes;
const DEFAULT_GRAY = pdfName('DefaultGray').bytes;
const DEFAULT_CMYK = pdfName('DefaultCMYK').bytes;

const entriesOf = (value: PdfObject | undefined): PdfDictionaryEntries | undefined => {
  if (value?.kind === 'dictionary') return value.entries;
  if (value?.kind === 'stream') return value.dictionary;
  return undefined;
};

const sameIdentity = (first: IccProfile, second: IccProfile): boolean => first.identity.every((byte, index) => byte === second.identity[index]);

/** Checks every reachable owner because ISO 32000-1:2008, 14.5 permits private PieceInfo on the catalog, pages and form XObjects. */
const checkApplicationData = (document: LoadedDocument, policy: ConversionPreflightPolicy): void => {
  if (policy.applicationData !== undefined && policy.applicationData !== 'refuse') return;
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const reachable = reachableObjects(internals);
  if (reachable.unreadable.length > 0) throw new ValidationError('reachable objects could not be checked for PieceInfo', 'unreadable-resource');
  for (const [number, generation] of reachable.objects) {
    const entries = entriesOf(internals.objects.resolve(number, generation));
    if (entries?.has(PIECE_INFO) === true) throw new ValidationError('PieceInfo would be invalidated by colour conversion', 'application-data');
  }
};

const profileIn = (document: LoadedDocument, value: PdfDirectObject | undefined): IccProfile | undefined => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const stream = internals.objects.deref(value);
  if (stream?.kind !== 'stream') return undefined;
  const bytes = decodedData(internals, stream);
  if (typeof bytes === 'string') throw new ValidationError(`ICC profile stream cannot be read: ${bytes}`, 'unreadable-resource');
  return parseIccProfile(bytes);
};

/** ISO 32000-1:2008, 14.11.5 Table 365 permits output intents of several subtypes; each existing profile is checked. */
const checkOutputIntents = (document: LoadedDocument, destination: IccProfile, policy: ConversionPreflightPolicy): void => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const value = internals.objects.deref(document.catalog().get(OUTPUT_INTENTS));
  if (value === undefined) return;
  if (value.kind !== 'array') throw new ValidationError('OutputIntents is not an array', 'output-intent-conflict');
  for (const item of value.items) {
    const entries = entriesOf(internals.objects.deref(item));
    const existing = profileIn(document, entries?.get(DEST_OUTPUT_PROFILE));
    if (existing !== undefined && sameIdentity(existing, destination)) continue;
    if (policy.outputIntent?.existing === 'replace') continue;
    throw new ValidationError('an existing output intent names a different printing condition', 'output-intent-conflict');
  }
};

/** ISO 32000-1:2008, 8.6.5.6 remaps device colours through DefaultGray and DefaultCMYK in the current resources. */
const checkResources = (document: LoadedDocument, destination: IccProfile, policy: ConversionPreflightPolicy): void => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const visit = (resource: ResourceVisit): void => {
    const colorSpaces = entriesOf(internals.objects.deref(resource.resources.get(COLOR_SPACE)));
    if (colorSpaces === undefined) return;
    if (colorSpaces.has(DEFAULT_GRAY) && policy.removeDefaultGray !== true) {
      throw new ValidationError('DefaultGray would remap DeviceGray colours', 'default-gray');
    }
    const defaultCmyk = internals.objects.deref(colorSpaces.get(DEFAULT_CMYK));
    if (defaultCmyk === undefined) return;
    const profileReference = defaultCmyk.kind === 'array' && defaultCmyk.items[0]?.kind === 'name' ? defaultCmyk.items[1] : undefined;
    const name = defaultCmyk.kind === 'array' ? defaultCmyk.items[0] : undefined;
    const profile = name?.kind === 'name' && new TextDecoder('latin1').decode(name.bytes) === 'ICCBased' ? profileIn(document, profileReference) : undefined;
    if (profile === undefined || !sameIdentity(profile, destination)) {
      throw new ValidationError('DefaultCMYK differs from the output profile', 'default-cmyk-conflict');
    }
  };
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'unreadable-resource');
    const resources: PdfDirectObject = { kind: 'dictionary', entries: document.page(page).resources() };
    const unreadable = walkResources(internals, entry, { resources, visit });
    if (unreadable.length > 0) throw new ValidationError('page resources could not be checked for default colour spaces', 'unreadable-resource');
  }
};

/** Checks conversion refusals without changing the document. */
export const checkConversionRefusals = (document: LoadedDocument, destination: IccProfile, policy: ConversionPreflightPolicy = {}): void => {
  checkApplicationData(document, policy);
  checkOutputIntents(document, destination, policy);
  checkResources(document, destination, policy);
};
