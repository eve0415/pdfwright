import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries as Entries } from '../object/pdfDictionaryEntries.ts';
import type { PdfDirectObject, PdfReference } from '../object/pdfObject.ts';
import type { OverprintNames, RewriteColorOptions } from './rewriteContent.ts';

import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { deflateZlib } from '../flate/deflate.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfDictionary, pdfName } from '../object/pdfObject.ts';

import { combineContentStreams } from './combinedContent.ts';
import { deleteDiscarded } from './discardedObjects.ts';
import { addOverprintStates, chooseOverprintNames } from './overprintResources.ts';
import { checkConversionRefusals } from './preflight.ts';
import { rewriteContentColors } from './rewriteContent.ts';

interface PreparedPage {
  readonly reference: PdfReference;
  readonly encoded: Uint8Array;
  readonly oldContent: PdfDirectObject | undefined;
  readonly resources: Entries;
  readonly overprintNames: OverprintNames;
  readonly overprintAdjustments: number;
}

export interface PageRewriteReport {
  readonly operators: number;
  readonly kOnly: number;
  readonly overprintAdjustments: number;
}

const CONTENTS = pdfName('Contents').bytes;
const FILTER = pdfName('Filter').bytes;
const LENGTH = pdfName('Length').bytes;
const DECODE_PARMS = pdfName('DecodeParms').bytes;
const RESOURCES = pdfName('Resources').bytes;

const oldReferences = (document: LoadedDocument, contents: PdfDirectObject | undefined): PdfReference[] => {
  const result: PdfReference[] = [];
  if (contents?.kind === 'reference') {
    result.push(contents);
    const value = document.get(contents);
    if (value.kind === 'array') for (const item of value.items) if (item.kind === 'reference') result.push(item);
  } else if (contents?.kind === 'array') {
    for (const item of contents.items) if (item.kind === 'reference') result.push(item);
  }
  return result;
};

const applyPreparedPages = (document: LoadedDocument, prepared: readonly PreparedPage[]): void => {
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const discarded: PdfReference[] = [];
  for (const item of prepared) {
    const page = document.get(item.reference);
    if (page.kind !== 'dictionary') throw new ValidationError('page is not a dictionary');
    const old = item.oldContent;
    discarded.push(...oldReferences(document, old));
    const first = old?.kind === 'reference' ? document.get(old) : undefined;
    const dictionary = first?.kind === 'stream' ? new PdfDictionaryEntries(first.dictionary.entries()) : new PdfDictionaryEntries();
    dictionary.set(FILTER, pdfName('FlateDecode'));
    dictionary.delete(DECODE_PARMS);
    dictionary.delete(LENGTH);
    const reference = document.object({ kind: 'stream', dictionary, data: item.encoded });
    page.entries.set(CONTENTS, reference);
    if (item.overprintAdjustments > 0) {
      const oldResources = page.entries.get(RESOURCES);
      if (oldResources?.kind === 'reference') discarded.push(oldResources);
      addOverprintStates(document, item.resources, item.overprintNames);
      page.entries.set(RESOURCES, pdfDictionary(item.resources));
    }
    document.set(item.reference, page);
  }
  deleteDiscarded(document, internals, discarded);
  internals.objects.requireFullRewrite('color-conversion');
};

/** Rewrites page colour operators after checking every conversion refusal, then switches each changed page to one content stream. */
export const rewritePageColors = (document: LoadedDocument, options: RewriteColorOptions): PageRewriteReport => {
  if (options.outputProfile.header.profileClass !== 'output' || options.outputProfile.header.colorSpace !== 'CMYK') {
    throw new ValidationError('colour conversion requires an output-class CMYK profile', 'color-space');
  }
  checkConversionRefusals(document, options.outputProfile);
  const internals = internalsOf(document);
  if (internals === undefined) throw new ValidationError('document internals are unavailable');
  const prepared: PreparedPage[] = [];
  let operators = 0;
  let kOnly = 0;
  let overprintAdjustments = 0;
  for (let index = 0; index < document.pageCount; index++) {
    const entry = internals.pages[index];
    if (entry === undefined) throw new ValidationError('page entry is missing');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) throw new ValidationError(`page content cannot be converted: ${content.problems.join('; ')}`, 'color-operator');
    const decoded = combineContentStreams(content.streams);
    const resources = document.page(index).resources();
    const names = chooseOverprintNames(document, resources);
    const rewritten = rewriteContentColors(document, decoded, { resources, options, overprintNames: names });
    if (rewritten.operators === 0 && rewritten.overprintAdjustments === 0) continue;
    if (rewritten.bytes.length > internals.maxDecodedBytes) {
      throw new ResourceLimitError(`converted page content exceeds maxDecodedBytes (${String(internals.maxDecodedBytes)} bytes)`);
    }
    const page = document.get(entry.reference);
    if (page.kind !== 'dictionary') throw new ValidationError('page is not a dictionary');
    prepared.push({
      reference: entry.reference,
      encoded: deflateZlib(rewritten.bytes),
      oldContent: page.entries.get(CONTENTS),
      resources,
      overprintNames: names,
      overprintAdjustments: rewritten.overprintAdjustments,
    });
    operators += rewritten.operators;
    kOnly += rewritten.kOnly;
    overprintAdjustments += rewritten.overprintAdjustments;
  }
  if (prepared.length === 0) return { operators, kOnly, overprintAdjustments };
  applyPreparedPages(document, prepared);
  return { operators, kOnly, overprintAdjustments };
};
