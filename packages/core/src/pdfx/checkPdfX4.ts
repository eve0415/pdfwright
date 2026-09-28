import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { DocumentMetadata } from '../metadata/readMetadata.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { PdfX4RuleId, RuleAuthority } from './pdfX4Rules.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { PdfwrightError } from '../error/pdfwrightError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { readTextString } from '../metadata/documentInfo.ts';
import { PDFX_ID_NAMESPACE, PDF_NAMESPACE, XMP_MM_NAMESPACE } from '../metadata/mapping.ts';
import { readMetadata } from '../metadata/readMetadata.ts';
import { pdfName } from '../object/pdfObject.ts';
import { reachableObjects } from '../resourceGraph/reachableObjects.ts';

import { pdfX4Rules } from './pdfX4Rules.ts';
import { registeredPrintingConditions } from './printingConditions.ts';

export { pdfX4Rules } from './pdfX4Rules.ts';
export type { PdfX4Rule, PdfX4RuleId, RuleAuthority } from './pdfX4Rules.ts';

export interface PdfX4Finding {
  readonly rule: PdfX4RuleId;
  readonly authority: RuleAuthority;
  readonly source: string;
  readonly status: 'violation' | 'passed' | 'not-checked';
  readonly location?: string | undefined;
  readonly detail: string;
}

export interface PdfX4Report {
  readonly findings: readonly PdfX4Finding[];
  readonly summary: 'no-violation-found-by-these-rules' | 'violations-found';
}

type Outcome = Pick<PdfX4Finding, 'status' | 'detail' | 'location'>;
type Check = (context: Context) => Outcome;

interface Context {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
  readonly catalog: PdfDictionaryEntries;
  readonly metadata: DocumentMetadata;
  readonly reachable: ReadonlyMap<number, number>;
  readonly unreadable: number;
}

const key = (name: string): Uint8Array => pdfName(name).bytes;
const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);
const textOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'string' ? readTextString(value.bytes).text : undefined);
const passed = (detail: string): Outcome => ({ status: 'passed', detail });
const violation = (detail: string, location?: string): Outcome => ({ status: 'violation', detail, location });
const unchecked = (detail: string): Outcome => ({ status: 'not-checked', detail });
const needsClause = (clause: string): Outcome => unchecked(`ISO 15930-7:2010 ${clause} is unavailable; the PDF/X-4 requirement was not checked`);

const xmpText = (metadata: DocumentMetadata, namespace: string, localName: string): string | undefined => {
  const { xmp } = metadata;
  if (xmp === undefined || !('packet' in xmp)) return undefined;
  const matches = xmp.packet.properties.filter(property => property.namespace === namespace && property.localName === localName);
  const value = matches.length === 1 ? matches[0]?.value : undefined;
  return value?.kind === 'text' ? value.text : undefined;
};

const entriesOf = (context: Context, value: PdfDirectObject | undefined): PdfDictionaryEntries | undefined => {
  const resolved = context.internals.objects.deref(value);
  if (resolved?.kind === 'dictionary') return resolved.entries;
  return resolved?.kind === 'stream' ? resolved.dictionary : undefined;
};
const resolvedText = (context: Context, entries: PdfDictionaryEntries, name: string): string | undefined => {
  const stored = entries.get(key(name));
  return textOf(context.internals.objects.deref(stored));
};

const outputIntent = (context: Context): PdfDictionaryEntries | undefined => {
  const value = context.internals.objects.deref(context.catalog.get(key('OutputIntents')));
  if (value?.kind !== 'array') return undefined;
  for (const item of value.items) {
    const entries = entriesOf(context, item);
    const subtype = context.internals.objects.deref(entries?.get(key('S')));
    if (nameOf(subtype) === 'GTS_PDFX') return entries;
  }
  return undefined;
};

const checkIntentEntries: Check = context => {
  const intent = outputIntent(context);
  if (intent === undefined) return unchecked('no GTS_PDFX output intent was available to inspect');
  const identifier = resolvedText(context, intent, 'OutputConditionIdentifier');
  if (identifier === undefined || identifier.length === 0) return violation('OutputConditionIdentifier is missing or not a text string');
  const registered = registeredPrintingConditions.some(condition => condition.identifier === identifier);
  const info = resolvedText(context, intent, 'Info');
  if (!registered && (info === undefined || info.length === 0)) return violation('an unregistered output condition needs Info');
  const registry = resolvedText(context, intent, 'RegistryName');
  if (registered && registry === undefined) {
    return passed('required entries are present; RegistryName is recommended for this registered identifier but absent');
  }
  return passed('required output intent entries are present');
};

const checkProfile: Check = context => {
  const intent = outputIntent(context);
  if (intent === undefined) return unchecked('no GTS_PDFX output intent was available to inspect');
  const value = context.internals.objects.deref(intent.get(key('DestOutputProfile')));
  if (value?.kind !== 'stream') return violation('DestOutputProfile is not an embedded ICC stream');
  const bytes = decodedData(context.internals, value);
  if (typeof bytes === 'string') return violation(`DestOutputProfile could not be decoded: ${bytes}`);
  try {
    const profile = parseIccProfile(bytes);
    const space = profile.header.colorSpace;
    if (space !== 'Gray' && space !== 'RGB' && space !== 'CMYK') {
      const label = typeof space === 'string' ? space : `${String(space.colorants)}-colorant`;
      return violation(`output profile colour space ${label} was not expected`);
    }
    if (profile.pcsToDevice[0] === undefined && profile.pcsToDevice[1] === undefined && profile.pcsToDevice[2] === undefined) {
      return violation('output profile has no BToA transform');
    }
    const identifier = resolvedText(context, intent, 'OutputConditionIdentifier');
    const registered = registeredPrintingConditions.some(condition => condition.identifier === identifier);
    if (!registered && profile.deviceToPcs[1] === undefined) {
      return unchecked('CGATS 3.3 calls for AtoB1 on unregistered conditions in PDF/X-1a; the PDF/X-4 requirement in ISO 15930-7 6.4 is unavailable');
    }
    if (profile.header.profileClass !== 'output') return unchecked('the output profile is not printer class; ISO 15930-7 6.4 is needed to judge this');
    return passed('an embedded ICC profile with an output transform was parsed');
  } catch (error: unknown) {
    if (error instanceof ResourceLimitError) return unchecked(`profile exceeds the checker resource limit: ${error.message}`);
    if (error instanceof PdfwrightError) return violation(`output ICC profile is invalid or unsupported: ${error.message}`);
    throw error;
  }
};

const within = (inner: readonly number[], outer: readonly number[]): boolean =>
  (inner[0] ?? 0) >= (outer[0] ?? 0) && (inner[1] ?? 0) >= (outer[1] ?? 0) && (inner[2] ?? 0) <= (outer[2] ?? 0) && (inner[3] ?? 0) <= (outer[3] ?? 0);

const checkBoxes: Check = context => {
  for (let index = 0; index < context.document.pageCount; index++) {
    const boxes = context.document.page(index).boxes();
    const print = boxes.TrimBox.explicit ? boxes.TrimBox : boxes.ArtBox;
    if (boxes.TrimBox.explicit === boxes.ArtBox.explicit) return violation('page needs either TrimBox or ArtBox, but not both', `page ${String(index)}`);
    if (!within(print.rect, boxes.MediaBox.rect)) return violation('print-area box extends beyond MediaBox', `page ${String(index)}`);
    if (boxes.BleedBox.explicit && !within(print.rect, boxes.BleedBox.rect)) {
      return violation('print-area box extends beyond BleedBox', `page ${String(index)}`);
    }
    if (boxes.CropBox.explicit && !within(print.rect, boxes.CropBox.rect)) {
      return violation('print-area box extends beyond CropBox', `page ${String(index)}`);
    }
  }
  return passed('each page has one print-area box inside its media, bleed and crop boxes');
};

const visitAll = (context: Context, predicate: (value: PdfObject) => boolean): boolean => {
  const work: PdfObject[] = [];
  for (const [number, generation] of context.reachable) work.push(context.internals.objects.resolve(number, generation));
  for (let value = work.pop(); value !== undefined; value = work.pop()) {
    if (predicate(value)) return true;
    if (value.kind === 'array') {
      for (const item of value.items) work.push(item);
    } else if (value.kind === 'dictionary' || value.kind === 'stream') {
      const entries = value.kind === 'dictionary' ? value.entries : value.dictionary;
      for (const [, child] of entries.entries()) work.push(child);
    }
  }
  return false;
};

const globalCheck = (context: Context, forbidden: (value: PdfObject) => boolean, what: string): Outcome => {
  if (context.unreadable > 0) return unchecked(`${String(context.unreadable)} reachable objects could not be inspected for ${what}`);
  return visitAll(context, forbidden) ? violation(`${what} was found`) : passed(`no ${what} was found in reachable objects`);
};

const hasName = (value: PdfDirectObject | undefined, expected: string): boolean => {
  if (value?.kind === 'array') return value.items.some(item => nameOf(item) === expected);
  return nameOf(value) === expected;
};

const javascript: Check = context => {
  const names = entriesOf(context, context.catalog.get(key('Names')));
  if (names?.has(key('JavaScript')) === true) return violation('the JavaScript name tree is present');
  return globalCheck(
    context,
    value => value.kind === 'dictionary' && (value.entries.has(key('AA')) || nameOf(value.entries.get(key('S'))) === 'JavaScript'),
    'JavaScript action or additional-action dictionary',
  );
};

const forms: Check = context => {
  const form = entriesOf(context, context.catalog.get(key('AcroForm')));
  if (form === undefined) return passed('no AcroForm is present');
  if (form.has(key('XFA'))) return violation('an XFA form is present');
  const fields = context.internals.objects.deref(form.get(key('Fields')));
  if (fields?.kind !== 'array') return unchecked('AcroForm Fields is not a readable array');
  return fields.items.length === 0 ? passed('AcroForm has no fields') : violation('AcroForm has fields');
};

const trapped: Check = context => {
  const info = context.metadata.info?.values.get('Trapped');
  const infoName = info?.kind === 'name' ? info.name : undefined;
  const xmp = xmpText(context.metadata, PDF_NAMESPACE, 'Trapped');
  if (infoName !== 'True' && infoName !== 'False') return violation('Info Trapped must be the name True or False');
  if (xmp !== infoName) return violation('XMP pdf:Trapped is absent or disagrees with Info Trapped');
  return passed('Info and XMP Trapped agree on True or False');
};

const xmpVersion: Check = context =>
  xmpText(context.metadata, PDFX_ID_NAMESPACE, 'GTS_PDFXVersion') === 'PDF/X-4'
    ? passed('XMP identifies PDF/X-4')
    : violation('XMP lacks a single pdfxid:GTS_PDFXVersion value of PDF/X-4');

const xmpMm: Check = context => {
  for (const name of ['DocumentID', 'VersionID', 'RenditionClass']) {
    if (xmpText(context.metadata, XMP_MM_NAMESPACE, name) === undefined) return violation(`XMP lacks xmpMM:${name}`);
  }
  return passed('XMP has DocumentID, VersionID and RenditionClass');
};

const checks: Readonly<Record<PdfX4RuleId, Check>> = {
  'X4-VERSION': context => unchecked(`PDF header ${context.document.structure.headerVersion}; ISO 15930-7 6.1 is unavailable, so no version limit is asserted`),
  'X4-PDF17-KEYS': () => needsClause('6.1 and 6.25; the effect of PDF 1.7-only keys'),
  'X4-ENCRYPT': context => (context.document.structure.trailer.has(key('Encrypt')) ? violation('Encrypt is present') : passed('no Encrypt entry')),
  'X4-OI-PRESENT': context =>
    outputIntent(context) === undefined ? violation('no GTS_PDFX output intent is present') : passed('GTS_PDFX output intent is present'),
  'X4-OI-ENTRIES': checkIntentEntries,
  'X4-OI-PROFILE': checkProfile,
  'X4-OI-PROFILE-VERSION': () => needsClause('6.4; the permitted ICC profile versions'),
  'X4-XMP-VERSION': xmpVersion,
  'X4-XMP-MM': xmpMm,
  'X4-TRAPPED': trapped,
  'X4-BOXES': checkBoxes,
  'X4-JS': javascript,
  'X4-FORMS': forms,
  'X4-ANNOTS': () => needsClause('6.17; printable annotation types and placement'),
  'X4-TRANSFER': () => needsClause('6.13; transfer-function restrictions'),
  'X4-LZW': context => globalCheck(context, value => value.kind === 'stream' && hasName(value.dictionary.get(key('Filter')), 'LZWDecode'), 'LZWDecode filter'),
  'X4-EMBEDDED': context =>
    globalCheck(
      context,
      value => value.kind === 'dictionary' && (value.entries.has(key('EmbeddedFiles')) || nameOf(value.entries.get(key('Subtype'))) === 'FileAttachment'),
      'embedded file or FileAttachment annotation',
    ),
  'X4-EXTERNAL': context =>
    globalCheck(
      context,
      value => value.kind === 'stream' && (value.dictionary.has(key('Ref')) || value.dictionary.has(key('Alternates')) || value.dictionary.has(key('OPI'))),
      'reference XObject, alternate image or OPI entry',
    ),
  'X4-FONTS': () => needsClause('6.5; font embedding and use requirements'),
  'X4-SPOT-ALTERNATE': () => needsClause('6.4; spot colour alternate-space equality'),
  'X4-PS': () => needsClause('6.14; PostScript XObject rule text'),
  'X4-BXEX': () => needsClause('6.19; compatibility-operator rule text'),
  'X4-INTENTS': () => needsClause('6.23; rendering-intent restrictions'),
  'X4-LIMITS': () => needsClause('6.25; architectural limits'),
  'X4-TRANSPARENCY': () => unchecked('ISO 15930-7 clause 1 permits transparency; no transparency conformance rule was checked'),
  'X4-OC': () => needsClause('6.24; optional-content configurations'),
};

/** Reports only the listed structural checks and their limits; a clean summary is not a PDF/X-4 conformance claim. */
export const checkPdfX4 = (document: LoadedDocument): PdfX4Report => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new TypeError('checkPdfX4 needs a document from loadDocument');
  const reachable = reachableObjects(internals);
  const context: Context = {
    document,
    internals,
    catalog: document.catalog(),
    metadata: readMetadata(document),
    reachable: reachable.objects,
    unreadable: reachable.unreadable.length,
  };
  const findings: PdfX4Finding[] = pdfX4Rules.map(rule => {
    const outcome = checks[rule.id](context);
    return { rule: rule.id, source: rule.source, authority: rule.authority, status: outcome.status, detail: outcome.detail, location: outcome.location };
  });
  return { findings, summary: findings.some(finding => finding.status === 'violation') ? 'violations-found' : 'no-violation-found-by-these-rules' };
};
