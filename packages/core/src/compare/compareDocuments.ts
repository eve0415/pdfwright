import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { BoxName, EffectiveBoxes } from '../document/loadedPage.ts';
import type { CompareOptions, DifferenceArea, DocumentComparison, FontIdentity, PdfDifference } from './pdfDifference.ts';

import { internalsOf } from '../document/documentInternals.ts';
import { effectiveBoxes, inherited } from '../document/loadedPage.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { pdfName } from '../object/pdfObject.ts';

import { fontSet } from './fontSet.ts';
import { comparePageContent } from './pageContent.ts';
import { ValueGraph } from './valueGraph.ts';

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
export const compareDocuments = (a: LoadedDocument, b: LoadedDocument, options: CompareOptions = {}): DocumentComparison => {
  const sides: Sides = { a: internals(a, 'a'), b: internals(b, 'b') };
  const include = new Set(options.include ?? AREAS);
  const differences: PdfDifference[] = [];
  const pagesA = sides.a.pages;
  const pagesB = sides.b.pages;
  if (include.has('pages') && pagesA.length !== pagesB.length) differences.push({ kind: 'page-count', a: pagesA.length, b: pagesB.length });
  const shared = Math.min(pagesA.length, pagesB.length);
  const documentFonts = { a: new Map<string, FontIdentity>(), b: new Map<string, FontIdentity>() };
  for (let page = 0; page < shared; page++) {
    const entryA = pagesA[page];
    const entryB = pagesB[page];
    if (entryA === undefined || entryB === undefined) continue;
    if (include.has('boxes')) compareBoxes(page, [effectiveBoxes(sides.a.objects, entryA), effectiveBoxes(sides.b.objects, entryB)], differences);
    if (include.has('content')) comparePageContent(page, { ...sides, pageA: entryA, pageB: entryB }, differences);
    const resourcesA = inherited(sides.a.objects, entryA, RESOURCES)?.value;
    const resourcesB = inherited(sides.b.objects, entryB, RESOURCES)?.value;
    if (include.has('resources')) {
      new ValueGraph(sides, {
        mismatch: ({ path, a: left, b: right }) => {
          differences.push({ kind: 'page-resources', page, path, a: left, b: right });
        },
        undecodable: (where, document, reason) => {
          differences.push({ kind: 'undecodable', where: ['page', page, ...where], document, reason });
        },
      }).compare(resourcesA, resourcesB, ['Resources']);
    }
    if (include.has('fonts')) {
      const fontsA = fontSet(sides.a, resourcesA);
      const fontsB = fontSet(sides.b, resourcesB);
      for (const [key, font] of fontsA) documentFonts.a.set(key, font);
      for (const [key, font] of fontsB) documentFonts.b.set(key, font);
      compareFonts(page, [fontsA, fontsB], differences);
    }
  }
  if (include.has('fonts')) compareFonts('document', [documentFonts.a, documentFonts.b], differences);
  return { equal: differences.length === 0, differences };
};
