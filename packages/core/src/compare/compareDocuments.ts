import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { BoxName, EffectiveBoxes } from '../document/loadedPage.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { CompareOptions, DifferenceArea, DocumentComparison, FontIdentity, PdfDifference } from './pdfDifference.ts';
import type { GraphContext } from './valueGraph.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { effectiveBoxes, inherited } from '../document/loadedPage.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { pdfName } from '../object/pdfObject.ts';

import {
  catalogDictionary,
  catalogReference,
  compareDocumentAttributes,
  compareDuplicateKeys,
  comparePageAttributes,
  formOwners,
  pageDictionary,
} from './attributes.ts';
import { DocumentFonts } from './documentFonts.ts';
import { fontSet } from './fontSet.ts';
import { comparePageContent } from './pageContent.ts';
import { comparePieceInfo } from './pieceInfo.ts';
import { ValueGraph, graphContext } from './valueGraph.ts';

const AREAS: readonly DifferenceArea[] = [
  'pages',
  'boxes',
  'content',
  'resources',
  'fonts',
  'pieceInfo',
  'lastModified',
  'pageAttributes',
  'documentAttributes',
];
const BOXES: readonly BoxName[] = ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'];
const RESOURCES = pdfName('Resources').bytes;

interface Sides {
  readonly a: DocumentInternals;
  readonly b: DocumentInternals;
}

const internals = (document: LoadedDocument, name: string): DocumentInternals => {
  const parts = internalsOf(document);
  if (parts === undefined) throw new InvalidArgumentError(`document ${name} was not loaded by loadDocument`);
  return parts;
};

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// ISO 32000-1:2008, 7.7.3.3, Table 30 and 7.7.3.4: the five boxes with inheritance and defaults, and the inheritable Rotate and non-inheritable UserUnit.
const compareBoxes = (page: number, [left, right]: readonly [EffectiveBoxes, EffectiveBoxes], differences: PdfDifference[]): void => {
  for (const box of BOXES) {
    const a = left[box];
    const b = right[box];
    if (!sameNumbers(a.rect, b.rect) || a.explicit !== b.explicit) {
      differences.push({ kind: 'page-box', page, box, a: { value: a.rect, explicit: a.explicit }, b: { value: b.rect, explicit: b.explicit } });
    }
  }
  if (left.rotate !== right.rotate) {
    differences.push({ kind: 'page-box', page, box: 'Rotate', a: { value: left.rotate, explicit: true }, b: { value: right.rotate, explicit: true } });
  }
  if (left.userUnit !== right.userUnit) {
    differences.push({ kind: 'page-box', page, box: 'UserUnit', a: { value: left.userUnit, explicit: true }, b: { value: right.userUnit, explicit: true } });
  }
};

// Fonts compare as sets of identities (ISO 32000-1:2008, 9.6 and 9.9): which appear only in the second document and which only in the first.
const compareFonts = (
  page: number | 'document',
  [left, right]: readonly [ReadonlyMap<string, FontIdentity>, ReadonlyMap<string, FontIdentity>],
  differences: PdfDifference[],
): void => {
  const added = [...right].filter(([key]) => !left.has(key)).map(([, font]) => font);
  const removed = [...left].filter(([key]) => !right.has(key)).map(([, font]) => font);
  if (added.length > 0 || removed.length > 0) differences.push({ kind: 'font-set', page, added, removed });
};

/**
 * Compares two loaded documents by what they show and carry, never by object numbers: page count, boxes, content, resources, fonts, page-piece data and the remaining page and document entries.
 * Each difference means the documents differ there; a caller decides which kinds an edit was allowed to produce.
 */
class Comparison {
  private readonly sides: GraphContext;
  private readonly include: ReadonlySet<DifferenceArea>;
  readonly differences: PdfDifference[] = [];
  private readonly pieces: PdfDifference[] = [];
  private readonly fonts = { a: new Map<string, FontIdentity>(), b: new Map<string, FontIdentity>() };
  private readonly documentFonts: { readonly a: DocumentFonts; readonly b: DocumentFonts };

  constructor(sides: Sides, include: ReadonlySet<DifferenceArea>) {
    this.sides = graphContext(sides.a, sides.b);
    this.documentFonts = { a: new DocumentFonts(sides.a), b: new DocumentFonts(sides.b) };
    this.include = include;
  }

  private resources(page: number, [resourcesA, resourcesB]: readonly [PdfDirectObject | undefined, PdfDirectObject | undefined]): void {
    const { differences } = this;
    new ValueGraph(this.sides, {
      mismatch: ({ path, a, b }) => {
        differences.push({ kind: 'page-resources', page, path, a, b });
      },
      undecodable: (where, document, reason) => {
        differences.push({ kind: 'undecodable', where: ['page', page, ...where], document, reason });
      },
    }).compare(resourcesA, resourcesB, ['Resources']);
  }

  // The fonts of one page of one document, with objects that cannot be read reported.
  private fontsOn(side: 'a' | 'b', page: number, [entry, resources]: readonly [PageEntry, PdfDirectObject | undefined]): Map<string, FontIdentity> {
    const found = fontSet(this.documentFonts[side], entry, resources);
    for (const reason of new Set(found.unreadable)) this.differences.push({ kind: 'undecodable', where: ['page', page, 'Resources'], document: side, reason });
    for (const [key, font] of found.fonts) this.fonts[side].set(key, font);
    return found.fonts;
  }

  private pageFonts(
    page: number,
    [entryA, entryB]: readonly [PageEntry, PageEntry],
    resources: readonly [PdfDirectObject | undefined, PdfDirectObject | undefined],
  ): void {
    const fontsA = this.fontsOn('a', page, [entryA, resources[0]]);
    const fontsB = this.fontsOn('b', page, [entryB, resources[1]]);
    compareFonts(page, [fontsA, fontsB], this.differences);
  }

  page(page: number, [entryA, entryB]: readonly [PageEntry, PageEntry]): void {
    const { sides, include, differences } = this;
    if (include.has('boxes')) compareBoxes(page, [effectiveBoxes(sides.a.objects, entryA), effectiveBoxes(sides.b.objects, entryB)], differences);
    if (include.has('content')) comparePageContent(page, { ...sides, pageA: entryA, pageB: entryB }, differences);
    const resources = [inherited(sides.a.objects, entryA, RESOURCES)?.value, inherited(sides.b.objects, entryB, RESOURCES)?.value] as const;
    if (include.has('resources')) this.resources(page, resources);
    if (include.has('pieceInfo') || include.has('lastModified')) {
      const owner = {
        owner: { kind: 'page', page } as const,
        a: pageDictionary(sides.a, entryA),
        b: pageDictionary(sides.b, entryB),
        referenceA: entryA.reference,
        referenceB: entryB.reference,
      };
      for (const each of [owner, ...formOwners(sides, { page, a: resources[0], b: resources[1] })]) comparePieceInfo(sides, each, this.pieces);
    }
    if (include.has('pageAttributes')) {
      comparePageAttributes(sides, { page, a: entryA, b: entryB }, differences);
      compareDuplicateKeys(sides, { where: ['page', page], a: entryA.reference, b: entryB.reference }, differences);
    }
    if (include.has('fonts')) this.pageFonts(page, [entryA, entryB], resources);
  }

  document(): void {
    const { sides, include, differences } = this;
    if (include.has('fonts')) {
      // The document's font set covers every page, including those only one document has.
      for (const side of ['a', 'b'] as const) {
        const { pages } = sides[side];
        for (let page = Math.min(sides.a.pages.length, sides.b.pages.length); page < pages.length; page++) {
          const entry = pages[page];
          if (entry !== undefined) this.fontsOn(side, page, [entry, inherited(sides[side].objects, entry, RESOURCES)?.value]);
        }
      }
      compareFonts('document', [this.fonts.a, this.fonts.b], differences);
    }
    if (include.has('pieceInfo') || include.has('lastModified')) {
      const catalog = {
        owner: { kind: 'catalog' } as const,
        a: catalogDictionary(sides.a),
        b: catalogDictionary(sides.b),
        referenceA: catalogReference(sides.a),
        referenceB: catalogReference(sides.b),
      };
      comparePieceInfo(sides, catalog, this.pieces);
    }
    for (const difference of this.pieces) {
      if (difference.kind === 'last-modified' ? include.has('lastModified') : include.has('pieceInfo')) differences.push(difference);
    }
    if (include.has('documentAttributes')) {
      compareDocumentAttributes(sides, differences);
      compareDuplicateKeys(sides, { where: ['Root'], a: catalogReference(sides.a), b: catalogReference(sides.b) }, differences);
    }
  }
}

export const compareDocuments = (a: LoadedDocument, b: LoadedDocument, options: CompareOptions = {}): DocumentComparison => {
  const sides: Sides = { a: internals(a, 'a'), b: internals(b, 'b') };
  const include = new Set(options.include ?? AREAS);
  const comparison = new Comparison(sides, include);
  const pagesA = sides.a.pages;
  const pagesB = sides.b.pages;
  if (include.has('pages') && pagesA.length !== pagesB.length) comparison.differences.push({ kind: 'page-count', a: pagesA.length, b: pagesB.length });
  for (let page = 0; page < Math.min(pagesA.length, pagesB.length); page++) {
    const entryA = pagesA[page];
    const entryB = pagesB[page];
    if (entryA !== undefined && entryB !== undefined) comparison.page(page, [entryA, entryB]);
  }
  comparison.document();
  return { equal: comparison.differences.length === 0, differences: comparison.differences };
};
