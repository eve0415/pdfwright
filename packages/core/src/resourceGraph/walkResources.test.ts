import type { DocumentInternals } from '../document/documentInternals.ts';
import type { PageEntry } from '../document/pageTree.ts';
import type { PdfDirectObject } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';
import type { ResourceOrigin, ResourceVisit, UnreadableObject } from './walkResources.ts';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { inherited } from '../document/loadedPage.ts';
import { ParseError } from '../error/parseError.ts';
import { fontKey, pageResourcesOwner } from '../font/loadFont.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { walkAcroFormResources, walkResources } from './walkResources.ts';

const internals = (page: string, objects: ReadonlyArray<TestObject>, tree = '', catalog = ''): DocumentInternals => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: `<</Type/Catalog/Pages 2 0 R${catalog}>>` },
          { number: 2, body: `<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]${tree}>>` },
          { number: 3, body: `<</Type/Page/Parent 2 0 R${page}>>` },
          ...objects,
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes,
  );
  const parts = internalsOf(document);
  if (parts === undefined) {
    throw new Error('the document has no internals');
  }
  return parts;
};

interface Walked {
  readonly visits: ReadonlyArray<ResourceVisit>;
  readonly fonts: ReadonlyArray<PdfDirectObject>;
  /** The key the content interpreter gives each font, from the name and owner the walk reports. */
  readonly keys: ReadonlyArray<string>;
  readonly unreadable: ReadonlyArray<UnreadableObject>;
}

const walk = (document: DocumentInternals): Walked => {
  const [page] = document.pages;
  if (page === undefined) {
    throw new Error('the document has no page');
  }
  const visits: Array<ResourceVisit> = [];
  const fonts: Array<PdfDirectObject> = [];
  const keys: Array<string> = [];
  const found = inherited(document.objects, page, { key: pdfName('Resources').bytes });
  const unreadable = walkResources(document, page, {
    resources: found?.value,
    owner: pageResourcesOwner(found, page),
    visit: visit => {
      visits.push(visit);
    },
    font: ({ value, owner, name }) => {
      fonts.push(value);
      keys.push(fontKey(value, owner, name));
    },
  });
  return { visits, fonts, keys, unreadable };
};

// The origins of the visit whose dictionary is the given indirect object, or of the page's direct dictionary.
const originsOf = (walked: Walked, objectNumber?: number): ReadonlyArray<ResourceOrigin> | undefined =>
  walked.visits.find(visit => visit.reference?.objectNumber === objectNumber)?.origins;

const reference = (objectNumber: number): PdfDirectObject => ({ kind: 'reference', objectNumber, generation: 0 });

const annotation = (number: number, flags: string): TestObject => ({
  number,
  body: `<</Type/Annot/Subtype/Square/Rect[0 0 1 1]${flags}/AP<</N 10 0 R/D 12 0 R>>>>`,
});

// A key that does not depend on the order an object's properties were written in, so that unordered lists can be compared item by item.
const canonical = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? `{${Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, item]) => `${name}:${canonical(item)}`)
        .join(',')}}`
    : String(value);

// The walk documents no order for origins, fonts or unreadable objects, so they are compared as multisets.
const unordered = <T>(items: ReadonlyArray<T> | undefined): ReadonlyArray<T> | undefined =>
  items?.toSorted((left, right) => canonical(left).localeCompare(canonical(right)));

const describeOrigin = (origin: ResourceOrigin): string =>
  origin.kind === 'annotation' ? `${String(origin.index)}${origin.state}:${String(origin.printable)}` : origin.kind;

const reads = (calls: ReadonlyArray<readonly [PdfDirectObject | undefined]>, objectNumber: number): number =>
  calls.filter(([value]) => value?.kind === 'reference' && value.objectNumber === objectNumber).length;

const TYPE3 = '/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<<>>/Encoding<</Differences[]>>/FirstChar 0/LastChar 0/Widths[0]';
const HELVETICA = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';

const firstPage = (document: DocumentInternals): PageEntry => {
  const [page] = document.pages;
  if (page === undefined) {
    throw new Error('the document has no page');
  }
  return page;
};

const form = (number: number, resources: string): TestObject => ({
  number,
  body: streamBody(`/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Resources ${resources}`, ''),
});

interface AcroFormWalk {
  readonly visits: ReadonlyArray<readonly [number | undefined, ReadonlyArray<ResourceOrigin>]>;
  readonly fonts: ReadonlyArray<{ readonly name: string; readonly owner: string }>;
  readonly from: ReadonlyArray<string>;
}

const walkForm = (catalog: string, objects: ReadonlyArray<TestObject>): AcroFormWalk => {
  const document = internals('', objects, '', catalog);
  const visits: Array<readonly [number | undefined, ReadonlyArray<ResourceOrigin>]> = [];
  const fonts: Array<{ readonly name: string; readonly owner: string }> = [];
  const unreadable = walkAcroFormResources(document, {
    resources: undefined,
    visit: ({ reference: own, origins }) => {
      visits.push([own?.objectNumber, origins]);
    },
    font: ({ owner, name }) => {
      fonts.push({ name: latin1Text(name), owner });
    },
  });
  return { visits, fonts, from: unreadable.map(({ from }) => from) };
};

describe('resource walks', () => {
  it('reports a form reached from page content and from an annotation once, with both origins', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R>>>>/Annots[11 0 R]', [
      form(10, '20 0 R'),
      { number: 11, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/F 4/AP<</N 10 0 R>>>>' },
      { number: 20, body: '<<>>' },
    ]);
    expect(unordered(originsOf(walk(document), 20))).toStrictEqual(
      unordered([
        { kind: 'annotation', index: 0, state: 'N', printable: true },
        { kind: 'form', reference: reference(10) },
      ]),
    );
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
    expect([walked.visits.length, unordered(originsOf(walked, 20))]).toStrictEqual([
      2,
      unordered([
        { kind: 'form', reference: reference(10) },
        { kind: 'form', reference: reference(12) },
      ]),
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
    expect([unordered(originsOf(walked, 30)), unordered(originsOf(walked, 31))]).toStrictEqual([
      unordered([
        { kind: 'annotation', index: 0, state: 'N', printable: true },
        { kind: 'annotation', index: 1, state: 'N', printable: false },
      ]),
      unordered([
        { kind: 'annotation', index: 0, state: 'N', printable: false },
        { kind: 'annotation', index: 1, state: 'N', printable: false },
      ]),
    ]);
  });

  it('adds a Type 3 font without Resources, or whose Resources is a missing object, as an origin of the page resources', () => {
    const type3 =
      '/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<<>>/Encoding<</Differences[]>>/FirstChar 0/LastChar 0/Widths[0]';
    const document = internals('/Resources 20 0 R', [
      { number: 20, body: '<</Font<</T1 10 0 R/T2 12 0 R/T3 13 0 R>>>>' },
      { number: 10, body: `<<${type3}>>` },
      { number: 13, body: `<<${type3}/Resources 99 0 R>>` },
      { number: 12, body: `<<${type3}/Resources 21 0 R>>` },
      { number: 21, body: '<<>>' },
    ]);
    const walked = walk(document);
    expect([unordered(originsOf(walked, 20)), originsOf(walked, 21), unordered(walked.fonts)]).toStrictEqual([
      unordered([
        { kind: 'page' },
        { kind: 'type3', font: reference(10), inheritsPageResources: true },
        { kind: 'type3', font: reference(13), inheritsPageResources: true },
      ]),
      [{ kind: 'type3', font: reference(12), inheritsPageResources: false }],
      unordered([reference(10), reference(12), reference(13)]),
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

  it('names each font as content interpretation keys it: by reference, or by resource name and the owner of its resource dictionary', () => {
    const helvetica = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';
    const type3 = `/Type/Font/Subtype/Type3/FontBBox[0 0 1 1]/FontMatrix[1 0 0 1 0 0]/CharProcs<<>>/Encoding<</Differences[]>>/FirstChar 0/LastChar 0/Widths[0]`;
    const document = internals(
      `/Resources<</Font<</F1 ${helvetica}/F2 30 0 R/T3 31 0 R>>/ExtGState<</GS1<</Font[${helvetica} 12]>>>>/XObject<</X1 10 0 R/X2 12 0 R>>>>`,
      [
        form(10, `<</Font<</F3 ${helvetica}>>>>`),
        form(12, '20 0 R'),
        { number: 20, body: `<</Font<</F4 ${helvetica}>>>>` },
        { number: 30, body: helvetica },
        { number: 31, body: `<<${type3}/Resources<</Font<</F5 ${helvetica}>>>>>>` },
      ],
    );
    expect(walk(document).keys.toSorted()).toStrictEqual([
      '30.0',
      '31.0',
      'direct:10.0:4633',
      'direct:20.0:4634',
      'direct:3.0:4631',
      'direct:3.0:ExtGState:475331',
      'direct:31.0:4635',
    ]);
  });

  it('names a direct font in inherited direct resources by the page tree node holding them', () => {
    const document = internals('', [], '/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Courier>>>>>>');
    expect(walk(document).keys).toStrictEqual(['direct:2.0:4631']);
  });

  it('returns objects it cannot parse with the page entry they were reached from', () => {
    const document = internals('/Resources<</XObject<</X1 10 0 R>>>>/Annots[11 0 R]', [
      { number: 10, body: '<</Type/XObject/Subtype/Form (unterminated' },
      { number: 11, body: '<</Type/Annot/AP<</N [1 2>>>>' },
    ]);
    expect(
      walk(document)
        .unreadable.map(({ from }) => from)
        .toSorted(),
    ).toStrictEqual(['Annots', 'Resources']);
  });
  it('ends a cycle through a form that draws itself, with the form as the one origin of its resources', () => {
    const document = internals('/Resources 20 0 R', [{ number: 20, body: '<</XObject<</X1 10 0 R>>>>' }, form(10, '<</XObject<</X 10 0 R>>>>')]);
    const walked = walk(document);
    expect([walked.visits.length, originsOf(walked, 20), originsOf(walked)]).toStrictEqual([
      2,
      [{ kind: 'page' }],
      [{ kind: 'form', reference: reference(10) }],
    ]);
  });

  it('adds a Type 3 font that an appearance reaches before the page resources are read as an origin of the page resources', () => {
    // The annotation's appearance is walked first, so the font names the page resources before the walk has read them.
    const document = internals('/Resources 20 0 R/Annots[11 0 R]', [
      { number: 20, body: '<<>>' },
      { number: 11, body: '<</Type/Annot/Subtype/Square/Rect[0 0 1 1]/F 4/AP<</N 10 0 R>>>>' },
      form(10, '<</Font<</T1 12 0 R>>>>'),
      { number: 12, body: `<<${TYPE3}>>` },
    ]);
    expect(unordered(originsOf(walk(document), 20))).toStrictEqual(
      unordered([{ kind: 'page' }, { kind: 'type3', font: reference(12), inheritsPageResources: true }]),
    );
  });

  it('names a font in an indirect graphics state parameter dictionary by that dictionary alone, with an empty name', () => {
    const document = internals('/Resources<</ExtGState<</GS1 40 0 R>>>>', [{ number: 40, body: `<</Font[${HELVETICA} 12]>>` }]);
    const fonts: Array<{ readonly name: string; readonly owner: string }> = [];
    walkResources(document, firstPage(document), {
      resources: inherited(document.objects, firstPage(document), { key: pdfName('Resources').bytes })?.value,
      font: ({ name, owner }) => {
        fonts.push({ name: latin1Text(name), owner });
      },
    });
    expect(fonts).toStrictEqual([{ name: '', owner: '40.0:ExtGState' }]);
  });

  it('reads the resource dictionaries in the order it reports them', () => {
    const document = internals('/Resources 20 0 R', [
      { number: 20, body: '<</XObject<</X1 10 0 R/X2 12 0 R>>>>' },
      form(10, '21 0 R'),
      form(12, '22 0 R'),
      { number: 21, body: '<<>>' },
      { number: 22, body: '<<>>' },
    ]);
    const page = firstPage(document);
    const resources = inherited(document.objects, page, { key: pdfName('Resources').bytes })?.value;
    const deref = vi.spyOn(document.objects, 'deref');
    const visited: Array<number | undefined> = [];
    walkResources(document, page, {
      resources,
      visit: ({ reference: own }) => {
        visited.push(own?.objectNumber);
      },
    });
    // The reads of the dictionaries it reported, whatever their numbers, in the order the walk made them.
    const reported = new Set(visited);
    const read = deref.mock.calls.flatMap(([value]) => (value?.kind === 'reference' && reported.has(value.objectNumber) ? [value.objectNumber] : []));
    expect([new Set(visited), visited]).toStrictEqual([new Set([20, 21, 22]), read]);
  });

  describe('a font handler', () => {
    const document = internals('/Resources<</Font<</F1 30 0 R/F2 31 0 R>>>>', [
      { number: 30, body: HELVETICA },
      { number: 31, body: HELVETICA },
    ]);
    const resources = inherited(document.objects, firstPage(document), { key: pdfName('Resources').bytes })?.value;

    it('that throws ParseError reports the font as unreadable and the walk goes on to the other fonts', () => {
      // Every font fails, so whichever the walk reaches first, the other is reached only if the walk goes on.
      const fonts: Array<PdfDirectObject> = [];
      const unreadable = walkResources(document, firstPage(document), {
        resources,
        font: ({ value }) => {
          fonts.push(value);
          throw new ParseError(`font ${value.kind === 'reference' ? String(value.objectNumber) : 'direct'} is broken`, 0);
        },
      });
      expect([unordered(unreadable), unordered(fonts)]).toStrictEqual([
        unordered([
          { from: 'Resources', reason: 'font 30 is broken' },
          { from: 'Resources', reason: 'font 31 is broken' },
        ]),
        unordered([reference(30), reference(31)]),
      ]);
    });

    it('that throws any other error stops the walk with that error', () => {
      expect(() =>
        walkResources(document, firstPage(document), {
          resources,
          font: () => {
            throw new TypeError('not a parse failure');
          },
        }),
      ).toThrow(TypeError);
    });
  });

  describe('AcroForm default resources', () => {
    // ISO 32000-1:2008, 12.7.2, Table 218: DR is the AcroForm's default resource dictionary.
    it.each([
      {
        name: 'a direct DR, whose direct fonts it names after AcroForm/DR',
        catalog: `/AcroForm<</Fields[]/DR<</Font<</F1 ${HELVETICA}>>>>>>`,
        objects: [],
        expected: { visits: [[undefined, [{ kind: 'acroform' }]]], fonts: [{ name: 'F1', owner: 'AcroForm/DR' }], from: [] },
      },
      {
        name: 'an indirect DR, whose direct fonts it names after the dictionary',
        catalog: '/AcroForm 15 0 R',
        objects: [
          { number: 15, body: '<</Fields[]/DR 20 0 R>>' },
          { number: 20, body: `<</Font<</F1 ${HELVETICA}>>>>` },
        ],
        expected: { visits: [[20, [{ kind: 'acroform' }]]], fonts: [{ name: 'F1', owner: '20.0' }], from: [] },
      },
      {
        name: 'a DR it cannot parse',
        catalog: '/AcroForm<</Fields[]/DR 20 0 R>>',
        objects: [{ number: 20, body: '<</Font (unterminated' }],
        expected: { visits: [], fonts: [], from: ['AcroForm'] },
      },
      {
        name: 'an AcroForm it cannot parse',
        catalog: '/AcroForm 15 0 R',
        objects: [{ number: 15, body: '<</Fields (unterminated' }],
        expected: { visits: [], fonts: [], from: ['AcroForm'] },
      },
    ])('walks $name', ({ catalog, objects, expected }) => {
      expect(walkForm(catalog, objects)).toStrictEqual(expected);
    });
  });
});

describe('properties', () => {
  interface Owner {
    readonly kind: 'form' | 'tiling-pattern';
    /** The index of the resource dictionary it names, if any. */
    readonly resources: number | undefined;
  }

  interface Graph {
    readonly owners: ReadonlyArray<Owner>;
    /** The owners each resource dictionary names, by index; dictionary 0 is the page's. */
    readonly dictionaries: ReadonlyArray<ReadonlyArray<number>>;
  }

  const OWNER = 10;
  const DICTIONARY = 30;

  // Forms and tiling patterns that share resource dictionaries, with cycles wherever a dictionary names an owner that leads back to it.
  const graphs = fc.integer({ min: 1, max: 6 }).chain(ownerCount =>
    fc.integer({ min: 1, max: 4 }).chain(dictionaryCount =>
      fc.record({
        owners: fc.array(
          fc.record({
            kind: fc.constantFrom('form', 'tiling-pattern'),
            resources: fc.option(fc.integer({ min: 0, max: dictionaryCount - 1 }), { nil: undefined }),
          }),
          { minLength: ownerCount, maxLength: ownerCount },
        ),
        dictionaries: fc.array(fc.uniqueArray(fc.integer({ min: 0, max: ownerCount - 1 })), { minLength: dictionaryCount, maxLength: dictionaryCount }),
      }),
    ),
  );

  const objectsOf = (graph: Graph): ReadonlyArray<TestObject> => [
    ...graph.owners.map(({ kind, resources }, index) => {
      const named = resources === undefined ? '' : `/Resources ${String(DICTIONARY + resources)} 0 R`;
      const dictionary = kind === 'form' ? '/Type/XObject/Subtype/Form/BBox[0 0 1 1]' : '/PatternType 1/PaintType 1/TilingType 1/BBox[0 0 1 1]/XStep 1/YStep 1';
      return { number: OWNER + index, body: streamBody(`${dictionary}${named}`, '') };
    }),
    ...graph.dictionaries.map((named, index) => {
      const entries = (kind: Owner['kind']): string =>
        named
          .filter(owner => graph.owners[owner]?.kind === kind)
          .map(owner => `/O${String(owner)} ${String(OWNER + owner)} 0 R`)
          .join('');
      return { number: DICTIONARY + index, body: `<</XObject<<${entries('form')}>>/Pattern<<${entries('tiling-pattern')}>>>>` };
    }),
  ];

  interface Expected {
    readonly visits: ReadonlyArray<{ readonly number: number; readonly origins: ReadonlyArray<ResourceOrigin> | undefined }>;
    readonly reads: ReadonlyArray<number>;
  }

  // An independent reachability model: the page's dictionary is reached from the page, and each owner a reached dictionary names is reached once and reaches the dictionary it names.
  const model = (graph: Graph): Expected => {
    const origins = new Map<number, Array<ResourceOrigin>>([[0, [{ kind: 'page' }]]]);
    const reached = new Set<number>();
    const work = [0];
    for (let dictionary = work.pop(); dictionary !== undefined; dictionary = work.pop()) {
      for (const index of graph.dictionaries[dictionary] ?? []) {
        const owner = graph.owners[index];
        if (owner === undefined || reached.has(index)) {
          continue;
        }
        reached.add(index);
        if (owner.resources === undefined) {
          continue;
        }
        const origin: ResourceOrigin = { kind: owner.kind, reference: pdfReference(OWNER + index, 0) };
        const known = origins.get(owner.resources);
        if (known === undefined) {
          origins.set(owner.resources, [origin]);
          work.push(owner.resources);
        } else {
          known.push(origin);
        }
      }
    }
    return {
      visits: [...origins].map(([index, list]) => ({ number: DICTIONARY + index, origins: unordered(list) })),
      reads: [...[...reached].map(index => OWNER + index), ...[...origins.keys()].map(index => DICTIONARY + index)].toSorted((left, right) => left - right),
    };
  };

  it('reports every reachable resource dictionary once, with one origin per owner that names it, and reads each object once', () => {
    fc.assert(
      fc.property(graphs, graph => {
        const document = internals(`/Resources ${String(DICTIONARY)} 0 R`, objectsOf(graph));
        const page = firstPage(document);
        const resources = inherited(document.objects, page, { key: pdfName('Resources').bytes })?.value;
        const deref = vi.spyOn(document.objects, 'deref');
        const visits: Array<ResourceVisit> = [];
        walkResources(document, page, {
          resources,
          visit: visit => {
            visits.push(visit);
          },
        });
        const reads = deref.mock.calls
          .flatMap(([value]) => (value?.kind === 'reference' && value.objectNumber >= OWNER ? [value.objectNumber] : []))
          .toSorted((left, right) => left - right);
        const expected = model(graph);
        expect({
          visits: unordered(visits.map(visit => ({ number: visit.reference?.objectNumber, origins: unordered(visit.origins) }))),
          reads,
        }).toStrictEqual({ visits: unordered(expected.visits), reads: expected.reads });
      }),
    );
  });
});
