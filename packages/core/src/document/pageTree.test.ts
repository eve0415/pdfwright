import type { TestObject } from '../testing/pdfBuilder.ts';
import type { LoadOptions, LoadedDocument } from './loadDocument.ts';

import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';

import { compareDocuments } from '../compare/compareDocuments.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { mm, pt } from '../length/length.ts';
import { pdfName, pdfReference, pdfString } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };

const load = (objects: ReadonlyArray<TestObject>, options?: LoadOptions): LoadedDocument =>
  loadDocument(buildPdf([{ xref: 'classic', objects: [catalog, ...objects], trailer: '/Root 1 0 R' }]).bytes, options);

// Root 2 holds MediaBox, Rotate and Resources; intermediate node 3 holds CropBox; pages 4 and 5 sit under 3, page 6 under the root.
const tree = [
  { number: 2, body: '<</Type/Pages/Kids[3 0 R 6 0 R]/Count 3/MediaBox[0 0 600 800]/Rotate 90/Resources<</Font<<>>>>>>' },
  { number: 3, body: '<</Kids[4 0 R 5 0 R]/Count 2/Parent 2 0 R/CropBox[10 10 590 790]>>' },
  { number: 4, body: '<</Type/Page/Parent 3 0 R/TrimBox[40 40 20 20]/UserUnit 2>>' },
  { number: 5, body: '<</Type/Page/Parent 3 0 R/MediaBox[0 0 300 400]/Rotate 0/Resources<</XObject<<>>>>/BleedBox 7 0 R>>' },
  { number: 6, body: '<</Type/Page/Parent 2 0 R>>' },
  { number: 7, body: '[5 5 295 395]' },
];

// Page tree nodes 2 to depth + 1, each the only kid of the one before; the root carries MediaBox and Resources.
const chain = (depth: number): Array<TestObject> =>
  Array.from({ length: depth }, (_, index) => ({
    number: index + 2,
    body: `<</Type/Pages/Kids[${String(index + 3)} 0 R]/Count 1${index === 0 ? '/MediaBox[0 0 7 7]/Resources<<>>' : ''}>>`,
  }));

// One page per level under a chain of page tree nodes; every node carries MediaBox and Resources, or only the root does.
const depthProbe = (depth: number, attributes: 'every-node' | 'root-only' = 'every-node'): Uint8Array => {
  const objects: Array<TestObject> = [catalog];
  for (let level = 1; level <= depth; level++) {
    const node = 2 * level;
    const page = node + 1;
    const next = level < depth ? ` ${String(node + 2)} 0 R` : '';
    const inheritable = attributes === 'every-node' || level === 1 ? '/MediaBox[0 0 10 10]/Resources<<>>' : '';
    objects.push(
      {
        number: node,
        body: `<</Type/Pages/Kids[${String(page)} 0 R${next}]/Count ${String(depth - level + 1)}${inheritable}>>`,
      },
      { number: page, body: `<</Type/Page/Parent ${String(node)} 0 R>>` },
    );
  }
  return buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes;
};

const resourceKeys = (document: LoadedDocument, index: number): Array<string> =>
  [...document.page(index).resources().entries()].map(([key]) => new TextDecoder().decode(key));

describe('page tree', () => {
  it('lists pages in order through intermediate nodes, inferring a missing Type from Kids', () => {
    const document = load(tree);
    expect([document.pageCount, [0, 1, 2].map(index => document.page(index).reference.objectNumber)]).toStrictEqual([3, [4, 5, 6]]);
    expect(() => document.page(3)).toThrow(InvalidArgumentError);
    expect(() => document.page(-1)).toThrow(InvalidArgumentError);
  });

  it('inherits MediaBox, CropBox, Rotate and Resources and applies the Table 30 defaults', () => {
    const document = load(tree);
    expect(document.page(0).boxes()).toStrictEqual({
      MediaBox: { rect: [0, 0, 600, 800], explicit: true, inheritedFrom: pdfReference(2, 0) },
      CropBox: { rect: [10, 10, 590, 790], explicit: true, inheritedFrom: pdfReference(3, 0) },
      BleedBox: { rect: [10, 10, 590, 790], explicit: false },
      TrimBox: { rect: [20, 20, 40, 40], explicit: true },
      ArtBox: { rect: [10, 10, 590, 790], explicit: false },
      rotate: 90,
      userUnit: 2,
    });
    expect(document.page(1).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 300, 400], explicit: true },
      BleedBox: { rect: [5, 5, 295, 395] },
      rotate: 0,
      userUnit: 1,
    });
    expect([resourceKeys(document, 0), resourceKeys(document, 1), resourceKeys(document, 2)]).toStrictEqual([['Font'], ['XObject'], ['Font']]);
  });

  it('returns copies of resources that do not change the document', () => {
    const document = load(tree);
    document.page(0).resources().set(pdfName('Extra').bytes, { kind: 'null' });
    expect(resourceKeys(document, 0)).toStrictEqual(['Font']);
  });

  it('warns about pages without resources and leaves the status intact', () => {
    const bare = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    ]);
    expect([bare.structure.status, bare.warnings.map(warning => warning.code), resourceKeys(bare, 0)]).toStrictEqual(['intact', ['resources-missing'], []]);
    // ISO 32000-1:2008, 7.7.3.3, Table 30, MediaBox: "(Required; inheritable)".
    expect(() => bare.page(0).boxes()).toThrow(ParseError);
    expect(() => bare.page(0).boxes()).toThrow(/no MediaBox/u);
  });

  it('reads inherited attributes that refer to missing objects as absent', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 5 5]/Resources<</Font<<>>>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox 9 0 R/Resources 9 0 R/TrimBox 9 0 R>>' },
    ]);
    expect([document.page(0).boxes().MediaBox.rect, document.page(0).boxes().TrimBox.explicit, resourceKeys(document, 0)]).toStrictEqual([
      [0, 0, 5, 5],
      false,
      ['Font'],
    ]);
  });

  it('keeps a malformed box number as read and throws when the box is used', () => {
    const malformed = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 --300 400]>>' },
    ]);
    expect([malformed.structure.status, malformed.warnings.map(warning => warning.code)]).toStrictEqual(['tolerated', ['invalid-token']]);
    expect(() => malformed.page(0).boxes()).toThrow(ParseError);
    expect(() => malformed.page(0).boxes()).toThrow(/MediaBox.*\[2\].*--300/u);
  });

  it('walks a deep tree and inherits from its root', () => {
    const nodes = chain(5000);
    const document = load([...nodes, { number: 5002, body: '<</Type/Page>>' }], { maxPageTreeDepth: 5001 });
    expect([document.pageCount, document.page(0).boxes().MediaBox]).toStrictEqual([
      1,
      { rect: [0, 0, 7, 7], explicit: true, inheritedFrom: pdfReference(2, 0) },
    ]);
  });

  it('limits page-tree depth at the limit and one past it', () => {
    // The page sits at depth 4, under three page tree nodes.
    const objects = [...chain(3), { number: 5, body: '<</Type/Page>>' }];
    expect(() => load(objects, { maxPageTreeDepth: 3 })).toThrow(ResourceLimitError);
    expect(load(objects, { maxPageTreeDepth: 4 }).pageCount).toBe(1);
  });

  it('limits page-tree depth independently of object nesting', () => {
    const document = load([...chain(10), { number: 12, body: '<</Type/Page>>' }], { maxNesting: 3, maxPageTreeDepth: 11 });
    expect([document.pageCount, document.page(0).reference.objectNumber]).toStrictEqual([1, 12]);
  });

  it.runIf(inject('runtime') === 'node')(
    'compares the depth-2000 input within the depth budget',
    () => {
      const bytes = depthProbe(2000);
      const start = performance.now();
      const options = { maxPageTreeDepth: 2001 };
      const { equal } = compareDocuments(loadDocument(bytes, options), loadDocument(bytes, options));
      expect([equal, performance.now() - start < 20_000]).toStrictEqual([true, true]);
    },
    30_000,
  );

  it.runIf(inject('runtime') === 'node')(
    'loads a depth-8000 tree that inherits from its root alone when the depth limit allows it',
    () => {
      const bytes = depthProbe(8000, 'root-only');
      const start = performance.now();
      const document = loadDocument(bytes, { maxPageTreeDepth: 8001 });
      expect([document.pageCount, document.warnings, performance.now() - start < 20_000]).toStrictEqual([8000, [], true]);
    },
    30_000,
  );

  it.runIf(inject('runtime') === 'node')(
    'rejects the depth-8000 input within the depth budget',
    () => {
      const bytes = depthProbe(8000);
      const start = performance.now();
      expect(() => compareDocuments(loadDocument(bytes), loadDocument(bytes))).toThrow(ResourceLimitError);
      expect([performance.now() - start < 20_000]).toStrictEqual([true]);
    },
    30_000,
  );

  it('throws for missing kids, kids of the wrong type and cycles instead of skipping them', () => {
    const root = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
    expect(() => load([root])).toThrow(ParseError);
    expect(() => load([root])).toThrow(/missing/u);
    expect(() => load([root, { number: 3, body: '<</Type/Font>>' }])).toThrow(ParseError);
    expect(() => load([root, { number: 3, body: '[1]' }])).toThrow(ParseError);
    expect(() => load([root, { number: 3, body: '<</Type/Pages/Kids[2 0 R]/Count 1>>' }])).toThrow(ParseError);
  });

  it('refuses a root Count that differs from the leaves unless the leaves are accepted', () => {
    for (const count of [1, 3]) {
      const objects = [
        { number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]/Count ${String(count)}/MediaBox[0 0 1 1]/Resources<<>>>>` },
        { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
        { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
      ];
      expect(() => load(objects)).toThrow(ParseError);
      const document = load(objects, { pageCountMismatch: 'use-leaves' });
      expect([document.pageCount, document.structure.status, document.warnings.map(warning => warning.code)]).toStrictEqual([
        2,
        'intact',
        ['page-count-mismatch'],
      ]);
    }
  });

  it.each([
    { root: 'a catalog without Pages', catalogBody: '<</Type/Catalog>>', objects: [], message: /catalog/u },
    { root: 'a direct Pages value', catalogBody: '<</Type/Catalog/Pages 5>>', objects: [], message: /no Pages reference/u },
    {
      root: 'a Pages reference to a page',
      catalogBody: '<</Type/Catalog/Pages 2 0 R>>',
      objects: [{ number: 2, body: '<</Type/Page/MediaBox[0 0 1 1]/Resources<<>>>>' }],
      message: /is not a page tree node/u,
    },
  ])('refuses $root', ({ catalogBody, objects, message }) => {
    const bytes = buildPdf([{ xref: 'classic', objects: [{ number: 1, body: catalogBody }, ...objects], trailer: '/Root 1 0 R' }]).bytes;
    expect(() => loadDocument(bytes)).toThrow(ParseError);
    expect(() => loadDocument(bytes)).toThrow(message);
  });

  it.each([
    { kids: 'no Kids', body: '<</Type/Pages/Count 0>>', message: /no Kids array/u },
    { kids: 'a Kids integer', body: '<</Type/Pages/Kids 5/Count 0>>', message: /no Kids array/u },
    { kids: 'a direct page dictionary kid', body: '<</Type/Pages/Kids[<</Type/Page>>]/Count 1>>', message: /not an indirect reference/u },
    { kids: 'an integer kid', body: '<</Type/Pages/Kids[3]/Count 1>>', message: /not an indirect reference/u },
    { kids: 'one page listed twice', body: '<</Type/Pages/Kids[3 0 R 3 0 R]/Count 2>>', message: /twice/u },
  ])('refuses a page tree node with $kids', ({ body, message }) => {
    // ISO 32000-1:2008, 7.7.3.2, Table 29, Kids: "An array of indirect references to the immediate children of this node."
    const objects = [
      { number: 2, body: `${body.slice(0, -2)}/MediaBox[0 0 1 1]/Resources<<>>>>` },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    ];
    expect(() => load(objects)).toThrow(ParseError);
    expect(() => load(objects)).toThrow(message);
  });

  it('accepts an indirect Kids array and an indirect Count', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids 9 0 R/Count 8 0 R/MediaBox[0 0 1 1]/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
      { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
      { number: 8, body: '2' },
      { number: 9, body: '[3 0 R 4 0 R]' },
    ]);
    expect([document.pageCount, [0, 1].map(index => document.page(index).reference.objectNumber), document.warnings]).toStrictEqual([2, [3, 4], []]);
  });

  it.each([
    { count: 'a real', entry: '/Count 2.0' },
    { count: 'a string', entry: '/Count (2)' },
    { count: 'no value', entry: '' },
  ])('treats a root Count that is $count as a mismatch', ({ entry }) => {
    const objects = [
      { number: 2, body: `<</Type/Pages/Kids[3 0 R 4 0 R]${entry}/MediaBox[0 0 1 1]/Resources<<>>>>` },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
      { number: 4, body: '<</Type/Page/Parent 2 0 R>>' },
    ];
    // ISO 32000-1:2008, 7.7.3.2, Table 29, Count: "(Required) The number of leaf nodes (page objects) that are descendants of this node".
    expect(() => load(objects)).toThrow(ParseError);
    expect(() => load(objects)).toThrow(/without a valid value/u);
    const document = load(objects, { pageCountMismatch: 'use-leaves' });
    expect([document.pageCount, document.warnings.map(warning => warning.code)]).toStrictEqual([2, ['page-count-mismatch']]);
  });

  it('does not inherit a TrimBox from a page tree node', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 100 100]/CropBox[5 5 95 95]/TrimBox[10 10 90 90]/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R>>' },
    ]);
    // ISO 32000-1:2008, 7.7.3.3, Table 30: MediaBox and CropBox are inheritable, and TrimBox defaults to the CropBox.
    expect(document.page(0).boxes().TrimBox).toStrictEqual({ rect: [5, 5, 95, 95], explicit: false });
  });
});

describe('page box edits', () => {
  it('sets a box on the page alone, leaving the ancestor it inherits from unchanged', () => {
    const document = load(tree);
    document.page(0).setBox('MediaBox', rect(pt(0), pt(0), pt(500), pt(700)));
    document.page(0).setBox('TrimBox', rect(mm(10), mm(10), mm(5), mm(5)));
    expect(document.page(0).boxes()).toMatchObject({
      MediaBox: { rect: [0, 0, 500, 700], explicit: true },
      TrimBox: { rect: [14.17323, 14.17323, 28.34646, 28.34646] },
    });
    expect([document.page(2).boxes().MediaBox.rect, document.get(pdfReference(2, 0))]).toStrictEqual([[0, 0, 600, 800], load(tree).get(pdfReference(2, 0))]);
  });

  it('removes a box so that the inherited value or the default applies', () => {
    const document = load(tree);
    document.page(1).setBox('MediaBox', undefined);
    document.page(0).setBox('TrimBox', undefined);
    expect([document.page(1).boxes().MediaBox, document.page(0).boxes().TrimBox]).toStrictEqual([
      { rect: [0, 0, 600, 800], explicit: true, inheritedFrom: pdfReference(2, 0) },
      { rect: [10, 10, 590, 790], explicit: false },
    ]);
  });

  it('refuses boxes outside MediaBox or without area at save, and removals that leave no MediaBox', () => {
    const document = load(tree);
    const page = document.page(0);
    page.setBox('TrimBox', rect(pt(0), pt(0), pt(700), pt(10)));
    expect(() => document.save()).toThrow(ValidationError);
    page.setBox('TrimBox', undefined);
    page.setBox('CropBox', rect(pt(5), pt(5), pt(5), pt(10)));
    expect(() => document.save()).toThrow(ValidationError);
    const lone = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/Resources<<>>>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>' },
    ]);
    expect(() => {
      lone.page(0).setBox('MediaBox', undefined);
    }).toThrow(ValidationError);
    expect(lone.page(0).boxes().MediaBox.rect).toStrictEqual([0, 0, 10, 10]);
  });
});

describe('page LastModified', () => {
  it('sets and removes the date on request only', () => {
    const document = load(tree);
    expect(document.page(0).lastModified()).toBeUndefined();
    document.page(0).setLastModified(pdfDate({ year: 2026, month: 9, day: 27, hour: 3, minute: 4, second: 5, offset: 'Z' }));
    expect(document.page(0).lastModified()).toStrictEqual(pdfString(new TextEncoder().encode('D:20260927030405Z')));
    document.page(0).setLastModified(undefined);
    expect(document.page(0).lastModified()).toBeUndefined();
  });

  it('refuses to remove the date from a page with PieceInfo', () => {
    const document = load([
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 1 1]/Resources<<>>>>' },
      { number: 3, body: "<</Type/Page/Parent 2 0 R/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')>>" },
    ]);
    expect(() => {
      document.page(0).setLastModified(undefined);
    }).toThrow(ValidationError);
    expect(document.page(0).pieceInfo()?.kind).toBe('dictionary');
  });
});

type TreeToken = 'open' | 'open-media' | 'close' | 'leaf' | 'leaf-media';

interface BuiltTree {
  readonly objects: Array<TestObject>;
  /** The page object numbers in pre-order, each with the object that supplies its MediaBox. */
  readonly pages: Array<{ readonly page: number; readonly media: number }>;
}

interface PendingTreeNode {
  readonly media: boolean;
  readonly kids: Array<PendingTreeNode | { readonly media: boolean; readonly leaf: true }>;
}

// Reads tokens as a pre-order walk: open starts a page tree node under the current one, close ends it, and leaf adds a page; a "-media" token gives the node or page its own MediaBox, whose size is its object number.
const treeOf = (tokens: ReadonlyArray<TreeToken>): BuiltTree => {
  const root: PendingTreeNode = { media: true, kids: [] };
  const stack = [root];
  for (const token of tokens) {
    const current = stack.at(-1) ?? root;
    if (token === 'open' || token === 'open-media') {
      const node: PendingTreeNode = { media: token === 'open-media', kids: [] };
      current.kids.push(node);
      stack.push(node);
    } else if (token === 'close') {
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      current.kids.push({ media: token === 'leaf-media', leaf: true });
    }
  }
  const objects: Array<TestObject> = [catalog];
  const pages: Array<{ page: number; media: number }> = [];
  let next = 2;
  const visit = (node: PendingTreeNode, parent: number | undefined, inheritedMedia: number): number => {
    const number = next++;
    const media = node.media ? number : inheritedMedia;
    const kids: Array<number> = [];
    let leaves = 0;
    const index = objects.length;
    objects.push(catalog);
    for (const kid of node.kids) {
      if ('leaf' in kid) {
        const page = next++;
        kids.push(page);
        leaves++;
        pages.push({ page, media: kid.media ? page : media });
        objects.push({ number: page, body: `<</Type/Page/Parent ${String(number)} 0 R${kid.media ? `/MediaBox[0 0 ${String(page)} ${String(page)}]` : ''}>>` });
      } else {
        kids.push(next);
        leaves += visit(kid, number, media);
      }
    }
    const parentEntry = parent === undefined ? '/Resources<<>>' : `/Parent ${String(parent)} 0 R`;
    const mediaEntry = node.media ? `/MediaBox[0 0 ${String(number)} ${String(number)}]` : '';
    objects[index] = {
      number,
      body: `<</Type/Pages/Kids[${kids.map(kid => `${String(kid)} 0 R`).join(' ')}]/Count ${String(leaves)}${parentEntry}${mediaEntry}>>`,
    };
    return leaves;
  };
  visit(root, undefined, 0);
  return { objects, pages };
};

describe('properties', () => {
  it('lists the leaves of any page tree in pre-order, each inheriting the MediaBox of its nearest ancestor that has one', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<TreeToken>('open', 'open-media', 'close', 'leaf', 'leaf', 'leaf-media'), { maxLength: 40 }), tokens => {
        const { objects, pages } = treeOf(tokens);
        const document = loadDocument(buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes);
        const actual = Array.from({ length: document.pageCount }, (_, index) => {
          const page = document.page(index);
          return { page: page.reference.objectNumber, media: page.boxes().MediaBox };
        });
        // ISO 32000-1:2008, 7.7.3.4: an omitted inheritable attribute "shall be inherited from an ancestor node in the page tree".
        const expected = pages.map(({ page, media }) => ({
          page,
          media:
            media === page
              ? { rect: [0, 0, page, page], explicit: true }
              : { rect: [0, 0, media, media], explicit: true, inheritedFrom: pdfReference(media, 0) },
        }));
        expect(actual).toStrictEqual(expected);
      }),
    );
  });
});
