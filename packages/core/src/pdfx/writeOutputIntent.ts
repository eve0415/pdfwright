import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { IccProfile } from '../icc/iccProfile.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { PrintingCondition } from './printingConditions.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { versionNumber } from '../document/readStructure.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfTextString } from '../metadata/documentInfo.ts';
import { PdfDictionaryEntries as Entries, pdfArray, pdfDictionary, pdfInteger, pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

import { registeredPrintingConditions } from './printingConditions.ts';

/** Embeds a CMYK output profile and printing-condition identifier; conflicting intents are refused and PDF/X version handling defaults on, with ValidationError reasons `output-intent-conflict`, `color-space`, or `pdf-extensions` under ISO 32000-1:2008, 14.11.5, Table 365. */
export interface OutputIntentOptions {
  /** Output-class CMYK ICC profile embedded in the intent. */
  readonly outputProfile: Uint8Array;
  /** Identifier of the intended printing condition. */
  readonly outputConditionIdentifier: string;
  /** Description required for an unregistered condition. */
  readonly info?: string;
  /** Human-readable condition, defaulting from the registry when known. */
  readonly outputCondition?: string;
  /** Registry URI for a registered condition. */
  readonly registryName?: string;
  /** Whether to refuse or replace a conflicting intent; defaults to refuse. */
  readonly existing?: 'refuse' | 'replace';
  /** Whether to write PDF version 1.6 in place of a higher catalog Version and header version, for PDF/X-4; defaults to true. */
  readonly pdfx?: boolean;
}

/** Reports whether an output intent was added, updated, or replaced, the removed subtypes, and the embedded profile reference under ISO 32000-1:2008, 14.11.5, Table 365. */
export interface OutputIntentChange {
  readonly action: 'added' | 'updated' | 'replaced';
  readonly removedSubtypes: readonly string[];
  readonly profile: PdfReference;
}

interface ExistingIntent {
  readonly reference: PdfReference | undefined;
  readonly entries: PdfDictionaryEntries;
  readonly profile: PdfReference | undefined;
  readonly matches: boolean;
  readonly subtype: string;
}

const key = (name: string): Uint8Array => pdfName(name).bytes;
const nameOf = (value: PdfDirectObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);
const sameIdentity = (a: IccProfile, b: IccProfile): boolean => a.identity.every((byte, index) => byte === b.identity[index]);

interface ReadExistingInput {
  readonly internals: DocumentInternals;
  readonly catalog: PdfDictionaryEntries;
  readonly destination: IccProfile;
  readonly replacement: boolean;
}

const readExisting = ({ internals, catalog, destination, replacement }: ReadExistingInput): ExistingIntent[] => {
  const { objects } = internals;
  const intents = objects.deref(catalog.get(key('OutputIntents')));
  if (intents !== undefined && intents.kind !== 'array') throw new ValidationError('OutputIntents is not an array', 'output-intent-conflict');
  const existing: ExistingIntent[] = [];
  for (const item of intents?.kind === 'array' ? intents.items : []) {
    const value = objects.deref(item);
    if (value?.kind !== 'dictionary') throw new ValidationError('an output intent is not a dictionary', 'output-intent-conflict');
    const reference = item.kind === 'reference' ? item : undefined;
    const profileValue = value.entries.get(key('DestOutputProfile'));
    const profile = profileValue?.kind === 'reference' ? profileValue : undefined;
    const stream = objects.deref(profileValue);
    let matches = false;
    if (stream?.kind === 'stream') {
      const bytes = decodedData(internals, stream);
      if (typeof bytes === 'string') throw new ValidationError(`output profile cannot be read: ${bytes}`, 'unreadable-resource');
      matches = sameIdentity(parseIccProfile(bytes), destination);
    }
    if (!matches && !replacement) throw new ValidationError('an existing output intent names a different printing condition', 'output-intent-conflict');
    const subtype = nameOf(value.entries.get(key('S'))) ?? 'other';
    existing.push({ reference, entries: value.entries, profile, matches, subtype });
  }
  return existing;
};

interface Prepared {
  readonly internals: DocumentInternals;
  readonly root: PdfReference;
  readonly catalog: PdfDictionaryEntries;
  readonly condition: PrintingCondition | undefined;
  readonly existing: readonly ExistingIntent[];
}

const prepare = (document: LoadedDocument, options: OutputIntentOptions): Prepared => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable', 'unreadable-resource');
  const destination = parseIccProfile(options.outputProfile);
  if (destination.header.profileClass !== 'output' || destination.header.colorSpace !== 'CMYK') {
    throw new ValidationError('the output intent needs an output-class CMYK ICC profile', 'color-space');
  }
  const condition = registeredPrintingConditions.find(entry => entry.identifier === options.outputConditionIdentifier);
  if (options.outputConditionIdentifier.length === 0 || (condition === undefined && options.info === undefined)) {
    throw new ValidationError('an unregistered output condition needs an identifier and Info', 'output-intent-conflict');
  }
  const root = internals.structure.trailer.get(key('Root'));
  if (root?.kind !== 'reference') throw new ValidationError('the document catalog is unavailable', 'unreadable-resource');
  const catalog = document.get(root);
  if (catalog.kind !== 'dictionary') throw new ValidationError('the document catalog is not a dictionary', 'unreadable-resource');
  if (catalog.entries.has(key('Extensions'))) throw new ValidationError('PDF extensions prevent PDF/X-4 version lowering', 'pdf-extensions');
  const existing = readExisting({ internals, catalog: catalog.entries, destination, replacement: options.existing === 'replace' });
  return { internals, root, catalog: catalog.entries, condition, existing };
};

interface NewEntriesInput {
  readonly options: OutputIntentOptions;
  readonly condition: PrintingCondition | undefined;
  readonly sameGts: ExistingIntent | undefined;
  readonly profile: PdfReference;
}

const newEntries = ({ options, condition, sameGts, profile }: NewEntriesInput): PdfDictionaryEntries => {
  const entries = new Entries(sameGts === undefined ? [] : [...sameGts.entries.entries()]);
  entries.set(key('Type'), pdfName('OutputIntent'));
  entries.set(key('S'), pdfName('GTS_PDFX'));
  entries.set(key('DestOutputProfile'), profile);
  entries.set(key('OutputConditionIdentifier'), pdfTextString(options.outputConditionIdentifier));
  const setText = (name: string, explicit: string | undefined, fallback: string | undefined): void => {
    const value = explicit ?? (sameGts === undefined ? fallback : undefined);
    if (value !== undefined) entries.set(key(name), pdfTextString(value));
  };
  setText('Info', options.info, condition?.identifier);
  setText('OutputCondition', options.outputCondition, condition === undefined ? undefined : `${condition.designation} — ${condition.media}`);
  setText('RegistryName', options.registryName, condition === undefined ? undefined : 'http://www.color.org');
  return entries;
};

interface PlaceInput {
  readonly document: LoadedDocument;
  readonly prepared: Prepared;
  readonly sameGts: ExistingIntent | undefined;
  readonly profile: PdfReference;
  readonly options: OutputIntentOptions;
}

const place = ({ document, prepared, sameGts, profile, options }: PlaceInput): boolean => {
  const { catalog, root, existing, internals, condition } = prepared;
  const entries = newEntries({ options, condition, sameGts, profile });
  const intentReference = sameGts?.reference;
  const updated = intentReference ?? document.object(pdfDictionary(entries));
  if (intentReference !== undefined) document.set(intentReference, pdfDictionary(entries));
  const items: PdfDirectObject[] = [updated];
  for (const intent of existing) {
    if (intent.matches && intent !== sameGts && intent.reference !== undefined) items.push(intent.reference);
  }
  catalog.set(key('OutputIntents'), pdfArray(items));
  const catalogVersion = nameOf(catalog.get(key('Version')));
  const catalogLowered = options.pdfx !== false && catalogVersion !== undefined && versionNumber(catalogVersion) > 16;
  if (catalogLowered) catalog.set(key('Version'), pdfName('1.6'));
  document.set(root, pdfDictionary(catalog));
  for (const intent of existing) {
    if (!intent.matches && intent.reference !== undefined) document.delete(intent.reference);
  }
  const reachable = reachableObjects(internals).objects;
  for (const intent of existing) {
    if (!intent.matches && intent.profile !== undefined && !reachable.has(intent.profile.objectNumber)) document.delete(intent.profile);
  }
  return catalogLowered;
};

/** Writes a GTS_PDFX output intent (ISO 32000-1:2008, 14.11.5, Table 365) whose DestOutputProfile is the caller's output-class CMYK profile; an existing intent with a different profile throws ValidationError `output-intent-conflict` unless `existing` is `replace`. */
export const writeGtsPdfxOutputIntent = (document: LoadedDocument, options: OutputIntentOptions): OutputIntentChange => {
  const prepared = prepare(document, options);
  const { existing, internals } = prepared;
  const retained = existing.filter(intent => intent.matches);
  const sameGts = retained.find(intent => intent.subtype === 'GTS_PDFX');
  const reused = retained.find(intent => intent.profile !== undefined)?.profile;
  const compressed = reused === undefined ? deflateZlib(options.outputProfile) : undefined;
  const profile =
    reused ??
    document.object({
      kind: 'stream',
      dictionary: new Entries([
        [key('N'), pdfInteger(4)],
        [key('Filter'), pdfName('FlateDecode')],
      ]),
      data: compressed ?? new Uint8Array(),
    });
  if (reused !== undefined) {
    const stream = document.get(reused);
    if (stream.kind !== 'stream') throw new ValidationError('the reused output profile is not a stream', 'unreadable-resource');
    stream.dictionary.set(key('N'), pdfInteger(4));
    document.set(reused, stream);
  }
  const catalogLowered = place({ document, prepared, sameGts, profile, options });
  const removed = existing.filter(intent => !intent.matches);
  internals.objects.requireFullRewrite('color-conversion');
  if (options.pdfx !== false) internals.lowerPdfX4Version(catalogLowered);
  let action: OutputIntentChange['action'] = 'updated';
  if (removed.length > 0) action = 'replaced';
  else if (sameGts === undefined) action = 'added';
  return {
    action,
    removedSubtypes: removed.map(intent => intent.subtype),
    profile,
  };
};
