import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject, PdfReference } from '../object/pdfObject.ts';
import type { RewriteColorOptions } from './rewriteContent.ts';

import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { PdfDictionaryEntries as Entries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';

import { prepareLuminosityMasks } from './luminosityMasks.ts';
import { checkConversionRefusals } from './preflight.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

export interface GroupConversionReport {
  readonly groups: number;
  readonly blendingSpaceChanges: Readonly<Record<'blendMode' | 'alpha' | 'softMask', number>>;
  readonly keptLuminosityGroups: number;
  readonly approximateLuminosityGroups: number;
}

interface Compositing {
  readonly blendMode: boolean;
  readonly alpha: boolean;
  readonly softMask: boolean;
}

interface GroupPlan {
  readonly owner: PdfReference;
  readonly groupReference: PdfReference | undefined;
  readonly group: PdfDictionaryEntries;
  readonly flags: Compositing;
}

interface Scan {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
  readonly options: RewriteColorOptions;
  readonly plans: GroupPlan[];
  readonly seenForms: Set<number>;
  readonly luminosityGroups: ReadonlySet<number>;
}

const GROUP = pdfName('Group').bytes;
const COLOR_SPACE = pdfName('CS').bytes;
const RESOURCES = pdfName('Resources').bytes;
const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const GROUP_SUBTYPE = pdfName('S').bytes;
const EXT_G_STATE = pdfName('ExtGState').bytes;

const nameOf = (value: PdfObject | undefined): string | undefined => (value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined);

const numberOf = (value: PdfObject | undefined): number | undefined => {
  if (value?.kind === 'integer') return value.value;
  if (value?.kind === 'real' && typeof value.value === 'number') return value.value;
  return undefined;
};

const usedState = (scan: Scan, resources: PdfDictionaryEntries, name: Uint8Array): PdfDictionaryEntries | undefined => {
  const category = scan.internals.objects.deref(resources.get(EXT_G_STATE));
  if (category?.kind !== 'dictionary') return undefined;
  const state = scan.internals.objects.deref(category.entries.get(name));
  return state?.kind === 'dictionary' ? state.entries : undefined;
};

const stateFlags = (scan: Scan, entries: PdfDictionaryEntries): Compositing => {
  const blend = scan.internals.objects.deref(entries.get(pdfName('BM').bytes));
  const modes = blend?.kind === 'array' ? blend.items.map(item => nameOf(scan.internals.objects.deref(item))) : [nameOf(blend)];
  const fillValue = scan.internals.objects.deref(entries.get(pdfName('ca').bytes));
  const strokeValue = scan.internals.objects.deref(entries.get(pdfName('CA').bytes));
  const alpha = numberOf(fillValue);
  const strokeAlpha = numberOf(strokeValue);
  const mask = scan.internals.objects.deref(entries.get(pdfName('SMask').bytes));
  return {
    blendMode: modes.some(mode => mode !== undefined && mode !== 'Normal' && mode !== 'Compatible'),
    alpha: (alpha !== undefined && alpha < 1) || (strokeAlpha !== undefined && strokeAlpha < 1),
    softMask: mask !== undefined && nameOf(mask) !== 'None',
  };
};

const compositing = (scan: Scan, bytes: Uint8Array | readonly Uint8Array[], resources: PdfDictionaryEntries): Compositing => {
  let blendMode = false;
  let alpha = false;
  let softMask = false;
  for (const operation of readContent(bytes, scan.internals.maxNesting)) {
    if (operation.operator !== 'gs') continue;
    const [operand] = operation.operands;
    if (operand?.kind !== 'name') continue;
    const state = usedState(scan, resources, operand.bytes);
    if (state === undefined) continue;
    const flags = stateFlags(scan, state);
    blendMode ||= flags.blendMode;
    alpha ||= flags.alpha;
    softMask ||= flags.softMask;
  }
  return { blendMode, alpha, softMask };
};

const planGroup = (scan: Scan, input: { owner: PdfReference; dictionary: PdfDictionaryEntries; resources: PdfDictionaryEntries; flags: Compositing }): void => {
  const { owner, dictionary, resources, flags } = input;
  if (scan.luminosityGroups.has(owner.objectNumber)) return;
  const entry = dictionary.get(GROUP);
  const value = scan.internals.objects.deref(entry);
  if (value?.kind !== 'dictionary') return;
  const subtypeValue = scan.internals.objects.deref(value.entries.get(GROUP_SUBTYPE));
  const subtype = nameOf(subtypeValue);
  if (subtype !== 'Transparency') return;
  const color = value.entries.get(COLOR_SPACE);
  if (color === undefined) return;
  const source = resolveSourceSpace(scan.document, color, { resources, sourceRgbProfile: scan.options.sourceRgbProfile });
  if (source.kind !== 'rgb') return;
  if (scan.options.blendingSpace === 'refuse' && (flags.blendMode || flags.alpha || flags.softMask)) {
    throw new ValidationError('RGB group compositing would change in DeviceCMYK', 'blend-space-change');
  }
  scan.plans.push({ owner, groupReference: entry?.kind === 'reference' ? entry : undefined, group: value.entries, flags });
};

const scanForms = (scan: Scan, resources: PdfDictionaryEntries): void => {
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
    planGroup(scan, { owner: value, dictionary: form.dictionary, resources: formResources, flags: compositing(scan, bytes, formResources) });
    scanForms(scan, formResources);
  }
};

const applyGroup = (scan: Scan, plan: GroupPlan): void => {
  const group = new Entries(plan.group.entries());
  // ISO 32000-1:2008, 11.4.7 and Table 147: an explicit group CS governs blending, so it follows the converted paints.
  group.set(COLOR_SPACE, pdfName('DeviceCMYK'));
  if (plan.groupReference !== undefined) {
    scan.document.set(plan.groupReference, pdfDictionary(group));
    return;
  }
  const owner = scan.document.get(plan.owner);
  if (owner.kind === 'dictionary') {
    owner.entries.set(GROUP, pdfDictionary(group));
    scan.document.set(plan.owner, owner);
  } else if (owner.kind === 'stream') {
    const dictionary = new Entries(owner.dictionary.entries());
    dictionary.set(GROUP, pdfDictionary(group));
    scan.document.set(plan.owner, { kind: 'stream', dictionary, data: owner.data });
  }
};

/** Converts explicit RGB transparency group spaces after checking their compositing effects. */
export const convertTransparencyGroups = (document: LoadedDocument, options: RewriteColorOptions): GroupConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const masks = prepareLuminosityMasks(document, options);
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const scan: Scan = { document, internals, options, plans: [], seenForms: new Set(), luminosityGroups: masks.groupNumbers };
  for (let page = 0; page < document.pageCount; page++) {
    const { reference } = document.page(page);
    const owner = document.get(reference);
    if (owner.kind !== 'dictionary') throw new ValidationError('page is not a dictionary', 'color-space');
    const resources = document.page(page).resources();
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) throw new ValidationError('page content cannot be read', 'color-operator');
    planGroup(scan, { owner: reference, dictionary: owner.entries, resources, flags: compositing(scan, content.streams, resources) });
    scanForms(scan, resources);
  }
  for (const plan of scan.plans) applyGroup(scan, plan);
  masks.apply();
  if (scan.plans.length > 0) internals.objects.requireFullRewrite('color-conversion');
  return {
    groups: scan.plans.length + masks.changed,
    blendingSpaceChanges: {
      blendMode: scan.plans.filter(plan => plan.flags.blendMode).length,
      alpha: scan.plans.filter(plan => plan.flags.alpha).length,
      softMask: scan.plans.filter(plan => plan.flags.softMask).length + masks.changed,
    },
    keptLuminosityGroups: masks.kept,
    approximateLuminosityGroups: masks.approximated,
  };
};
