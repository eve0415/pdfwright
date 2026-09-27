import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ResourceOrigin, ResourceVisit, UnreadableObject } from './walkResources.ts';

import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { inherited } from '../document/loadedPage.ts';
import { pdfName } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

import { walkResources } from './walkResources.ts';

const internals = (page: string, objects: readonly TestObject[]): DocumentInternals => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R${page}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const parts = internalsOf(document);
  if (parts === undefined) throw new Error('the document has no internals');
  return parts;
};

interface Walked {
  readonly visits: readonly ResourceVisit[];
  readonly fonts: readonly PdfDirectObject[];
  readonly unreadable: readonly UnreadableObject[];
}

const walk = (document: DocumentInternals): Walked => {
  const [page] = document.pages;
  if (page === undefined) throw new Error('the document has no page');
  const visits: ResourceVisit[] = [];
  const fonts: PdfDirectObject[] = [];
  const unreadable = walkResources(document, page, {
    resources: inherited(document.objects, page, { key: pdfName('Resources').bytes })?.value,
    visit: visit => {
      visits.push(visit);
    },
    font: ({ value }) => {
      fonts.push(value);
    },
  });
  return { visits, fonts, unreadable };
};

// The origins of the visit whose dictionary is the given indirect object, or of the page's direct dictionary.
const originsOf = (walked: Walked, objectNumber?: number): readonly ResourceOrigin[] | undefined =>
  walked.visits.find(visit => visit.reference?.objectNumber === objectNumber)?.origins;

const reference = (objectNumber: number): PdfDirectObject => ({ kind: 'reference', objectNumber, generation: 0 });

const annotation = (number: number, flags: string): TestObject => ({
  number,
  body: `<</Type/Annot/Subtype/Square/Rect[0 0 1 1]${flags}/AP<</N 10 0 R/D 12 0 R>>>>`,
});

const describeOrigin = (origin: ResourceOrigin): string =>
  origin.kind === 'annotation' ? `${String(origin.index)}${origin.state}:${String(origin.printable)}` : origin.kind;

const reads = (calls: readonly (readonly [PdfDirectObject | undefined])[], objectNumber: number): number =>
  calls.filter(([value]) => value?.kind === 'reference' && value.objectNumber === objectNumber).length;

const form = (number: number, resources: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources ${resources}`, ''),
});

describe('resource walks', () => {
  it('reports a form reached from page content and from an annotation once, with both origins', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R>>>>/Annots[11 0 R]', [
      form(10, '20 0 R'),
      { number: 11, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/F 4/AP<</N 10 0 R>>>>' },
      { number: 20, body: '<<>>' },
    ]);
    expect(originsOf(walk(document), 20)).toStrictEqual([
      { kind: 'annotation', index: 0, state: 'N', printable: true },
      { kind: 'form', reference: reference(10) },
    ]);
  });

  it('reads each object once however many origins reach it', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R/X2 12 0 R>>>>/Annots[11 0 R]', [
      form(10, '20 0 R'),
      form(12, '<</XObject<</X1 10 0 R>>>>'),
      { number: 11, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/AP<</N 10 0 R/R 10 0 R/D 10 0 R>>>>' },
      { number: 20, body: '<<>>' },
    ]);
    const deref = vi.spyOn(document.objects, 'deref');
    const walked = walk(document);
    expect([reads(deref.mock.calls, 10), reads(deref.mock.calls, 20), originsOf(walked, 20)?.length]).toStrictEqual([1, 1, 4]);
  });

  it('reports every form that shares one resource dictionary', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R/X2 12 0 R>>>>', [form(10, '20 0 R'), form(12, '20 0 R'), { number: 20, body: '<<>>' }]);
    const walked = walk(document);
    expect([walked.visits.length, originsOf(walked, 20)]).toStrictEqual([
      2,
      [
        { kind: 'form', reference: reference(12) },
        { kind: 'form', reference: reference(10) },
      ],
    ]);
  });

  it('marks only the normal appearance of an annotation that prints and is not hidden as printable', () => {
    const document = internals('/Annots[21 0 R 22 0 R 23 0 R]', [
      form(10, '<<>>'),
      form(12, '<<>>'),
      annotation(21, '/F 4'),
      annotation(22, '/F 6'),
      annotation(23, ''),
    ]);
    const walked = walk(document);
    expect(
      walked.visits
        .flatMap(visit => visit.origins)
        .map(origin => describeOrigin(origin))
        .toSorted(),
    ).toStrictEqual(['0D:false', '0N:true', '1D:false', '1N:false', '2D:false', '2N:false']);
  });

  it('prints the state of a normal appearance subdictionary that AS selects, and no state without AS', () => {
    const states = '/AP<</N<</On 10 0 R/Off 12 0 R>>>>';
    const document = internals('/Annots[21 0 R 22 0 R]', [
      form(10, '30 0 R'),
      form(12, '31 0 R'),
      { number: 21, body: `<</Type/Annot/Subtype/Widget/Rect[0 0 1 1]/F 4/AS/On${states}>>` },
      { number: 22, body: `<</Type/Annot/Subtype/Widget/Rect[0 0 1 1]/F 4${states}>>` },
      { number: 30, body: '<<>>' },
      { number: 31, body: '<<>>' },
    ]);
    const walked = walk(document);
    expect([originsOf(walked, 30), originsOf(walked, 31)]).toStrictEqual([
      [
        { kind: 'annotation', index: 1, state: 'N', printable: false },
        { kind: 'annotation', index: 0, state: 'N', printable: true },
      ],
      [
        { kind: 'annotation', index: 1, state: 'N', printable: false },
        { kind: 'annotation', index: 0, state: 'N', printable: false },
      ],
    ]);
  });

  it('adds a Type 3 font without Resources as an origin of the page resources', () => {
    const type3 =
      '/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<<>>/Encoding<</Differences[]>>/FirstChar 0/LastChar 0/Widths[0]';
    const document = internals('/Resources 20 0 R', [
      { number: 20, body: '<</Font<</T1 10 0 R/T2 12 0 R>>>>' },
      { number: 10, body: `<<${type3}>>` },
      { number: 12, body: `<<${type3}/Resources 21 0 R>>` },
      { number: 21, body: '<<>>' },
    ]);
    const walked = walk(document);
    expect([originsOf(walked, 20), originsOf(walked, 21), walked.fonts]).toStrictEqual([
      [{ kind: 'page' }, { kind: 'type3', font: reference(10), inheritsPageResources: true }],
      [{ kind: 'type3', font: reference(12), inheritsPageResources: false }],
      [reference(12), reference(10)],
    ]);
  });

  it('reports tiling patterns and soft-mask groups as origins', () => {
    const document = internals('/Resources<</Pattern<</P1 10 0 R>>/ExtGState<</G1<</SMask<</S/Luminosity/G 12 0 R>>>>>>>>', [
      { number: 10, body: streamBody('/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1/Resources 20 0 R', '') },
      form(12, '21 0 R'),
      { number: 20, body: '<<>>' },
      { number: 21, body: '<<>>' },
    ]);
    const walked = walk(document);
    expect([originsOf(walked, 20), originsOf(walked, 21), originsOf(walked)]).toStrictEqual([
      [{ kind: 'tiling-pattern', reference: reference(10) }],
      [{ kind: 'soft-mask', group: reference(12) }],
      [{ kind: 'page' }],
    ]);
  });

  it('returns objects it cannot parse with the page entry they were reached from', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R>>>>/Annots[11 0 R]', [
      { number: 10, body: '<</Type/XObject/Subtype/Form (unterminated' },
      { number: 11, body: '<</Type/Annot/AP<</N [1 2>>>>' },
    ]);
    expect(walk(document).unreadable.map(({ from }) => from)).toStrictEqual(['Annots', 'Resources']);
  });
});
