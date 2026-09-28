import type { ColorSource } from '../color/createColorTransform.ts';
import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { NamedInlineImage } from './inlineResources.ts';
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
import { pdfArray, pdfDictionary, pdfName, pdfReal } from '../object/pdfObject.ts';

import { deleteDiscarded } from './discardedObjects.ts';
import { addInlineXObjects } from './inlineResources.ts';
import { deviceRgbLuminosity, rewriteDeviceRgbLuminosity } from './luminosityContent.ts';
import { addOverprintStates, chooseOverprintNames } from './overprintResources.ts';
import { rewriteContentColors } from './rewriteContent.ts';
import { resolveSourceSpace } from './sourceSpace.ts';

interface MaskGroup {
  readonly reference: PdfReference;
  readonly form: PdfStream;
  readonly group: PdfDictionaryEntries;
  readonly data: Uint8Array;
  readonly outputSpace: 'DeviceGray' | 'DeviceCMYK';
  readonly resources?: PdfDictionaryEntries;
  readonly overprintNames?: OverprintNames;
  readonly overprintAdjustments?: number;
  readonly newInlineImages?: readonly NamedInlineImage[];
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
}

const EXT_G_STATE = pdfName('ExtGState').bytes;
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

const nameOf = (value: PdfDirectObject | PdfStream | undefined): string | undefined =>
  value?.kind === 'name' ? new TextDecoder('latin1').decode(value.bytes) : undefined;

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

const cieLuminosity = (source: ColorSource, encoding: 'icc' | 'adobe'): ((values: readonly number[]) => number) => {
  const profile = source.kind === 'icc' ? source.profile : calibratedProfile(source);
  const toPcs = sourceEvaluator(profile, 'relativeColorimetric', encoding);
  return values => {
    const pcs = toPcs(values);
    return pcs.space === 'XYZ' ? (pcs.values[1] ?? 0) : (labToXyz(pcs.values)[1] ?? 0);
  };
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
  if (cie && scan.options.luminosityGroups !== 'gray') {
    scan.kept.add(groupReference.objectNumber);
    return;
  }
  if (scan.options.blendingSpace === 'refuse') throw new ValidationError('RGB luminosity group would change blending space', 'blend-space-change');
  if (!scan.groups.has(groupReference.objectNumber)) {
    const bytes = decodedData(scan.internals, form);
    if (typeof bytes === 'string') throw new ValidationError(`luminosity mask content cannot be read: ${bytes}`, 'color-operator');
    const rgbSource = resolveSourceSpace(scan.document, pdfName('DeviceRGB'), { resources: groupResources, sourceRgbProfile: scan.options.sourceRgbProfile });
    if (rgbSource.kind !== 'rgb') throw new ValidationError('DeviceRGB does not resolve to an RGB profile', 'color-space');
    const paintGray = cie ? cieLuminosity(rgbSource.source, scan.options.lut8LabEncoding ?? 'icc') : deviceRgbLuminosity;
    const rewritten = rewriteDeviceRgbLuminosity(bytes, paintGray);
    if (rewritten.length > scan.internals.maxDecodedBytes) throw new ResourceLimitError('converted luminosity mask exceeds maxDecodedBytes');
    scan.groups.set(groupReference.objectNumber, { reference: groupReference, form, group, data: deflateZlib(rewritten), outputSpace: 'DeviceGray' });
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
  const scan: MaskScan = { document, internals, options, groups: new Map(), resources: [], kept: new Set(), approximated: new Set(), seenForms: new Set() };
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new ValidationError('page entry is missing', 'color-space');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) throw new ValidationError('page content cannot be read', 'color-operator');
    const resources = document.page(page).resources();
    scanContent(scan, { owner: entry.reference, resources, content: content.streams });
    scanForms(scan, resources);
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
