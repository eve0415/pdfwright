import type { DocumentInternals } from '../document/documentInternals.ts';
import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfReference } from '../object/pdfObject.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { deleteDiscarded, discardedFunctionObjects } from './discardedObjects.ts';

interface Loaded {
  readonly document: LoadedDocument;
  readonly internals: DocumentInternals;
}

const loaded = (pageEntries: string, objects: ReadonlyArray<TestObject>): Loaded => {
  const document = loadDocument(
    buildPdf([
      {
        xref: 'classic',
        trailer: '/Root 1 0 R',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]${pageEntries}>>` },
          ...objects,
        ],
      },
    ]).bytes,
  );
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are unavailable');
  }
  return { document, internals };
};

describe('deleting discarded objects', () => {
  it.each([
    ['an object nothing reaches', pdfReference(11, 0), ['array', 'null']],
    ['an object the page still reaches', pdfReference(10, 0), ['array', 'array']],
    ['a reference whose generation is not the object’s', pdfReference(11, 1), ['array', 'array']],
  ])('handles %s', (_, discarded, expected) => {
    const { document, internals } = loaded('/PieceInfo<</Test<</Private 10 0 R>>>>', [
      { number: 10, body: '[0.5]' },
      { number: 11, body: '[1]' },
    ]);
    deleteDiscarded(document, internals, [discarded]);
    expect([document.get(pdfReference(10, 0)).kind, document.get(pdfReference(11, 0)).kind]).toStrictEqual(expected);
  });
});

type FunctionNode =
  | { readonly kind: 'exponential'; readonly indirectExponent: boolean }
  | { readonly kind: 'stitching'; readonly children: ReadonlyArray<number>; readonly indirectArray: boolean };

const exponential: fc.Arbitrary<FunctionNode> = fc.record({ kind: fc.constant('exponential' as const), indirectExponent: fc.boolean() });

const nodeAt = (index: number): fc.Arbitrary<FunctionNode> =>
  index === 0
    ? exponential
    : fc.oneof(
        exponential,
        fc.record({
          kind: fc.constant('stitching' as const),
          children: fc.array(fc.integer({ min: 0, max: index - 1 }), { minLength: 1, maxLength: 4 }),
          indirectArray: fc.boolean(),
        }),
      );

// Function k is object 10 + 3k, its indirect Functions array 11 + 3k and its indirect exponent 12 + 3k.
const functionNumber = (index: number): number => 10 + index * 3;

const graphObjects = (nodes: ReadonlyArray<FunctionNode>): Array<TestObject> =>
  nodes.flatMap((node, index): Array<TestObject> => {
    const number = functionNumber(index);
    if (node.kind === 'exponential') {
      const exponent = node.indirectExponent ? `${String(number + 2)} 0 R` : '1';
      return [
        { number, body: `<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N ${exponent}>>` },
        { number: number + 2, body: '1' },
      ];
    }
    const children = `[${node.children.map(child => `${String(functionNumber(child))} 0 R`).join(' ')}]`;
    const bounds = node.children.slice(1).map((_, position) => String((position + 1) / node.children.length));
    const encode = node.children.map(() => '0 1').join(' ');
    return [
      {
        number,
        body: `<</FunctionType 3/Domain[0 1]/Functions ${node.indirectArray ? `${String(number + 1)} 0 R` : children}/Bounds[${bounds.join(' ')}]/Encode[${encode}]>>`,
      },
      { number: number + 1, body: children },
    ];
  });

// The objects the generated graph reaches from its last function, from the model rather than from the PDF.
const modelObjects = (nodes: ReadonlyArray<FunctionNode>): Array<number> => {
  const reached = new Set<number>();
  const pending = [nodes.length - 1];
  for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
    const node = nodes[index];
    const number = functionNumber(index);
    if (node === undefined || reached.has(number)) {
      continue;
    }
    reached.add(number);
    if (node.kind === 'exponential') {
      if (node.indirectExponent) {
        reached.add(number + 2);
      }
    } else {
      if (node.indirectArray) {
        reached.add(number + 1);
      }
      pending.push(...node.children);
    }
  }
  return [...reached].toSorted((left, right) => left - right);
};

const graphArbitrary = fc.integer({ min: 1, max: 8 }).chain(count => fc.tuple(...Array.from({ length: count }, (_, index) => nodeAt(index))));

describe('properties', () => {
  it('lists each object a function graph reaches exactly once', () => {
    fc.assert(
      fc.property(graphArbitrary, nodes => {
        const { internals } = loaded('', graphObjects(nodes));
        const root: PdfReference = pdfReference(functionNumber(nodes.length - 1), 0);
        const listed = discardedFunctionObjects(internals, root).map(reference => reference.objectNumber);
        expect(listed.toSorted((left, right) => left - right)).toStrictEqual(modelObjects(nodes));
      }),
    );
  });
});
