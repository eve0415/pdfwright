import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfStream } from '../font/fontValues.ts';
import type { PdfReference } from '../object/pdfObject.ts';
import type { NamedInlineImage } from './inlineResources.ts';
import type { ColorEntryState, FormUse, OverprintNames, RewriteColorOptions } from './rewriteContent.ts';
import type { SourceSpace } from './sourceSpace.ts';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { decodedData } from '../font/fontValues.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';

import { combineContentStreams } from './combinedContent.ts';
import { deleteDiscarded } from './discardedObjects.ts';
import { addInlineXObjects } from './inlineResources.ts';
import { addOverprintStates, chooseOverprintNames } from './overprintResources.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewriteContentColors } from './rewriteContent.ts';

export interface FormConversionReport {
  readonly forms: number;
  readonly clones: number;
}

interface Assignment {
  readonly name: Uint8Array;
  readonly plan: FormPlan;
}

interface Scope {
  readonly resources: PdfDictionaryEntries;
  readonly assignments: Map<string, Assignment>;
  readonly sourceBytes: Uint8Array;
  readonly nameEdits: NameEdit[];
}

interface NameEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface PageScope extends Scope {
  readonly reference: PdfReference;
}

interface FormPlan extends Scope {
  readonly original: PdfReference;
  readonly stream: PdfStream;
  readonly data: Uint8Array;
  readonly entry: ColorEntryState;
  readonly overprintNames: OverprintNames;
  readonly overprintAdjustments: number;
  readonly newInlineImages: readonly NamedInlineImage[];
  readonly clone: boolean;
  output?: PdfReference;
}

const XOBJECT = pdfName('XObject').bytes;
const SUBTYPE = pdfName('Subtype').bytes;
const RESOURCES = pdfName('Resources').bytes;
const FILTER = pdfName('Filter').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const LENGTH = pdfName('Length').bytes;
const CONTENTS = pdfName('Contents').bytes;

const bytesKey = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const referenceKey = (reference: PdfReference): string => `${String(reference.objectNumber)}:${String(reference.generation)}`;

const spaceKey = (space: SourceSpace): string => {
  if (space.kind === 'rgb' || space.kind === 'gray') {
    const { source } = space;
    return `${space.kind}:${source.kind === 'icc' ? bytesKey(source.profile.identity) : JSON.stringify(source)}`;
  }
  if (space.kind === 'indexed') return `indexed:${spaceKey(space.base)}:${space.hival}:${bytesKey(space.lookup)}`;
  if (space.kind === 'separation' || space.kind === 'deviceN') {
    return `${space.kind}:${space.names.map(name => bytesKey(name)).join(',')}:${spaceKey(space.alternate)}`;
  }
  if (space.kind === 'pattern') return `pattern:${space.underlying === undefined ? '' : spaceKey(space.underlying)}`;
  return space.kind;
};

const stateKey = (state: ColorEntryState): string =>
  JSON.stringify([
    spaceKey(state.fill),
    spaceKey(state.stroke),
    state.intent,
    state.fillOverprint,
    state.strokeOverprint,
    state.overprintMode,
    state.fillConvertedZero,
    state.strokeConvertedZero,
    state.textRenderMode,
  ]);

const outputReference = (plan: FormPlan): PdfReference => {
  if (plan.output === undefined) throw new ValidationError('converted form has no output reference', 'color-operator');
  return plan.output;
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.length === right.length && left.every((byte, index) => byte === right[index]);

const samePlan = (left: FormPlan, right: FormPlan): boolean => {
  if (
    !sameBytes(left.data, right.data) ||
    left.assignments.size !== right.assignments.size ||
    left.nameEdits.length !== right.nameEdits.length ||
    left.newInlineImages.length !== right.newInlineImages.length
  ) {
    return false;
  }
  for (const [index, image] of left.newInlineImages.entries()) {
    const other = right.newInlineImages[index];
    if (other?.name !== image.name || !sameBytes(other.data, image.data)) return false;
  }
  for (const [key, assignment] of left.assignments) if (right.assignments.get(key)?.plan !== assignment.plan) return false;
  for (const [index, edit] of left.nameEdits.entries()) {
    const other = right.nameEdits[index];
    if (other?.start !== edit.start || other.end !== edit.end || other.text !== edit.text) return false;
  }
  return true;
};

const assign = (scope: Scope, use: FormUse, plan: FormPlan): void => {
  const key = bytesKey(use.name);
  const existing = scope.assignments.get(key);
  if (existing !== undefined && existing.plan !== plan) {
    const category = scope.resources.get(XOBJECT);
    const used = category?.kind === 'dictionary' ? category.entries : undefined;
    for (let index = 0; ; index++) {
      const name = pdfName(`PWFORM${String(index)}`).bytes;
      const generatedKey = bytesKey(name);
      if (used?.has(name) === true || scope.assignments.has(generatedKey)) continue;
      scope.assignments.set(generatedKey, { name, plan });
      scope.nameEdits.push({ start: use.start, end: use.end, text: `/${new TextDecoder('ascii').decode(name)} Do` });
      return;
    }
  }
  scope.assignments.set(key, { name: Uint8Array.from(use.name), plan });
};

const applyNameEdits = (bytes: Uint8Array, edits: readonly NameEdit[]): Uint8Array => {
  if (edits.length === 0) return bytes;
  const writer = new ByteWriter();
  let offset = 0;
  for (const edit of edits.toSorted((left, right) => left.start - right.start)) {
    if (edit.start < offset) throw new ValidationError('overlapping form calls', 'color-operator');
    writer.writeBytes(bytes.subarray(offset, edit.start));
    writer.writeAscii(edit.text);
    offset = edit.end;
  }
  writer.writeBytes(bytes.subarray(offset));
  return writer.toUint8Array();
};

class FormPlanner {
  readonly plans: FormPlan[] = [];
  private readonly variants = new Map<string, Map<string, FormPlan>>();
  private readonly active = new Set<string>();
  private readonly document: LoadedDocument;
  private readonly internals: DocumentInternals;
  private readonly options: RewriteColorOptions;

  constructor(document: LoadedDocument, internals: DocumentInternals, options: RewriteColorOptions) {
    this.document = document;
    this.internals = internals;
    this.options = options;
  }

  private form(resources: PdfDictionaryEntries, name: Uint8Array): { reference: PdfReference; stream: PdfStream } | undefined {
    const category = this.internals.objects.deref(resources.get(XOBJECT));
    if (category?.kind !== 'dictionary') return undefined;
    const value = category.entries.get(name);
    const stream = this.internals.objects.deref(value);
    if (stream?.kind !== 'stream') return undefined;
    const subtype = this.internals.objects.deref(stream.dictionary.get(SUBTYPE));
    if (subtype?.kind !== 'name' || new TextDecoder('latin1').decode(subtype.bytes) !== 'Form') return undefined;
    if (value?.kind !== 'reference') throw new ValidationError('form XObject must be an indirect stream', 'color-operator');
    return { reference: value, stream };
  }

  private planForm(spec: { reference: PdfReference; stream: PdfStream; inherited: PdfDictionaryEntries; entry: ColorEntryState; clone: boolean }): FormPlan {
    // ISO 32000-1:2008, 8.10.1: a form inherits the graphics state in effect at Do.
    const { reference, stream, inherited, entry, clone } = spec;
    const own = this.internals.objects.deref(stream.dictionary.get(RESOURCES));
    const resources = own?.kind === 'dictionary' ? own.entries : inherited;
    const bytes = decodedData(this.internals, stream);
    if (typeof bytes === 'string') throw new ValidationError(`form content cannot be converted: ${bytes}`, 'color-operator');
    const names = chooseOverprintNames(this.document, resources);
    const rewritten = rewriteContentColors(this.document, bytes, {
      resources,
      options: this.options,
      initialState: entry,
      overprintNames: names,
    });
    const plan: FormPlan = {
      original: reference,
      stream,
      resources,
      sourceBytes: bytes,
      data: rewritten.bytes,
      entry,
      overprintNames: names,
      overprintAdjustments: rewritten.overprintAdjustments,
      newInlineImages: rewritten.newInlineImages,
      clone,
      assignments: new Map(),
      nameEdits: [],
    };
    const key = referenceKey(reference);
    this.active.add(key);
    try {
      this.scanUses(plan, rewritten.formUses);
    } finally {
      this.active.delete(key);
    }
    return plan;
  }

  private scanUses(scope: Scope, uses: readonly FormUse[]): void {
    for (const use of uses) {
      const found = this.form(scope.resources, use.name);
      if (found === undefined) continue;
      const key = referenceKey(found.reference);
      if (this.active.has(key)) throw new ResourceLimitError('recursive form XObject conversion is unsupported');
      let variants = this.variants.get(key);
      if (variants === undefined) {
        variants = new Map();
        this.variants.set(key, variants);
      }
      const entry = stateKey(use.entry);
      let plan = variants.get(entry);
      if (plan === undefined) {
        const candidate = this.planForm({
          reference: found.reference,
          stream: found.stream,
          inherited: scope.resources,
          entry: use.entry,
          clone: variants.size > 0,
        });
        plan = [...new Set(variants.values())].find(previous => samePlan(previous, candidate)) ?? candidate;
        variants.set(entry, plan);
        if (plan === candidate) this.plans.push(plan);
      }
      assign(scope, use, plan);
    }
  }

  pageScopes(): PageScope[] {
    const scopes: PageScope[] = [];
    for (let page = 0; page < this.document.pageCount; page++) {
      const entry = this.internals.pages[page];
      if (entry === undefined) throw new ValidationError('page entry is missing', 'color-operator');
      const content = pageContent(this.internals, entry);
      if (content.problems.length > 0) throw new ValidationError(`page content cannot be read: ${content.problems.join('; ')}`, 'color-operator');
      const resources = this.document.page(page).resources();
      const sourceBytes = combineContentStreams(content.streams);
      const rewritten = rewriteContentColors(this.document, sourceBytes, {
        resources,
        options: this.options,
        overprintNames: { off: 'PWOPM0', on: 'PWOPM1' },
      });
      const scope: PageScope = { reference: entry.reference, resources, sourceBytes, assignments: new Map(), nameEdits: [] };
      this.scanUses(scope, rewritten.formUses);
      scopes.push(scope);
    }
    return scopes;
  }

  private mappedResources(scope: Scope): PdfDictionaryEntries | undefined {
    const category = this.internals.objects.deref(scope.resources.get(XOBJECT));
    if (category?.kind !== 'dictionary') return undefined;
    const mapped = new PdfDictionaryEntries(category.entries.entries());
    let changed = false;
    for (const { name, plan } of scope.assignments.values()) {
      const reference = outputReference(plan);
      const original = category.entries.get(name);
      if (original?.kind === 'reference' && original.objectNumber === reference.objectNumber && original.generation === reference.generation) continue;
      mapped.set(name, reference);
      changed = true;
    }
    if (!changed) return undefined;
    const resources = new PdfDictionaryEntries(scope.resources.entries());
    resources.set(XOBJECT, pdfDictionary(mapped));
    return resources;
  }

  private finalFormData(plan: FormPlan): Uint8Array {
    const renamed = applyNameEdits(plan.sourceBytes, plan.nameEdits);
    const data =
      plan.nameEdits.length === 0
        ? plan.data
        : rewriteContentColors(this.document, renamed, {
            resources: plan.resources,
            options: this.options,
            initialState: plan.entry,
            overprintNames: plan.overprintNames,
          }).bytes;
    if (data.length > this.internals.maxDecodedBytes) throw new ResourceLimitError('converted form exceeds maxDecodedBytes');
    return data;
  }

  private writeForm(plan: FormPlan, data: Uint8Array): PdfReference | undefined {
    const dictionary = new PdfDictionaryEntries(plan.stream.dictionary.entries());
    const mapped = this.mappedResources(plan);
    let discarded: PdfReference | undefined = undefined;
    if (mapped !== undefined || plan.overprintAdjustments > 0 || plan.newInlineImages.length > 0) {
      const old = dictionary.get(RESOURCES);
      if (old?.kind === 'reference') discarded = old;
      const resources = new PdfDictionaryEntries((mapped ?? plan.resources).entries());
      if (plan.overprintAdjustments > 0) addOverprintStates(this.document, resources, plan.overprintNames);
      addInlineXObjects(this.document, resources, plan.newInlineImages);
      dictionary.set(RESOURCES, pdfDictionary(resources));
    }
    dictionary.set(FILTER, pdfName('FlateDecode'));
    dictionary.delete(DECODE_PARMS);
    dictionary.delete(LENGTH);
    this.document.set(outputReference(plan), { kind: 'stream', dictionary, data: deflateZlib(data) });
    return discarded;
  }

  private writePage(scope: PageScope, renamed: Uint8Array | undefined): PdfReference[] {
    const resources = this.mappedResources(scope);
    if (resources === undefined && renamed === undefined) return [];
    const page = this.document.get(scope.reference);
    if (page.kind !== 'dictionary') throw new ValidationError('page is not a dictionary', 'color-operator');
    const discarded: PdfReference[] = [];
    if (resources !== undefined) {
      const oldResources = page.entries.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      page.entries.set(RESOURCES, pdfDictionary(resources));
    }
    if (renamed !== undefined) {
      const old = page.entries.get(CONTENTS);
      if (old?.kind === 'reference') discarded.push(old);
      if (old?.kind === 'array') for (const item of old.items) if (item.kind === 'reference') discarded.push(item);
      const stream = this.document.object({
        kind: 'stream',
        dictionary: new PdfDictionaryEntries([[FILTER, pdfName('FlateDecode')]]),
        data: deflateZlib(renamed),
      });
      page.entries.set(CONTENTS, stream);
    }
    this.document.set(scope.reference, page);
    return discarded;
  }

  write(pages: readonly PageScope[]): FormConversionReport {
    const formData = new Map(this.plans.map(plan => [plan, this.finalFormData(plan)] as const));
    const pageData = new Map<PageScope, Uint8Array>();
    for (const page of pages) {
      if (page.nameEdits.length === 0) continue;
      const data = applyNameEdits(page.sourceBytes, page.nameEdits);
      if (data.length > this.internals.maxDecodedBytes) throw new ResourceLimitError('renamed page content exceeds maxDecodedBytes');
      pageData.set(page, data);
    }
    for (const plan of this.plans) plan.output = plan.clone ? this.document.object({ kind: 'null' }) : plan.original;
    const discarded: PdfReference[] = [];
    for (const plan of this.plans) {
      const data = formData.get(plan);
      if (data === undefined) throw new ValidationError('converted form has no content', 'color-operator');
      const oldResources = this.writeForm(plan, data);
      if (oldResources !== undefined) discarded.push(oldResources);
    }
    for (const page of pages) discarded.push(...this.writePage(page, pageData.get(page)));
    deleteDiscarded(this.document, this.internals, discarded);
    if (this.plans.length > 0) this.internals.objects.requireFullRewrite('color-conversion');
    return { forms: this.plans.length, clones: this.plans.filter(plan => plan.clone).length };
  }
}

/** Converts forms for each distinct graphics state inherited at Do. */
export const convertForms = (document: LoadedDocument, options: RewriteColorOptions): FormConversionReport => {
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const planner = new FormPlanner(document, internals, options);
  const pages = planner.pageScopes();
  return planner.write(pages);
};
