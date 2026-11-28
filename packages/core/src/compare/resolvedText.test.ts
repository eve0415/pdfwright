import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { ResolvedTexts } from './resolvedText.ts';

const FIRST = 20;

// Objects that each refer only to objects numbered above them, so that no reference leads back into a cycle.
const acyclicObjects = fc.integer({ min: 1, max: 8 }).chain(count =>
  fc.tuple(
    ...Array.from({ length: count }, (_, index) => {
      const later = Array.from({ length: count - index - 1 }, (__, offset) => `${String(FIRST + index + 1 + offset)} 0 R`);
      const item =
        later.length === 0 ? fc.integer({ min: 0, max: 9 }).map(String) : fc.oneof(fc.integer({ min: 0, max: 9 }).map(String), fc.constantFrom(...later));
      return fc.oneof(
        fc.array(item, { maxLength: 6 }).map(items => `[${items.join(' ')}]`),
        fc.array(item, { maxLength: 4 }).map(items => `<<${items.map((value, position) => `/K${String(position)} ${value}`).join('')}>>`),
      );
    }),
  ),
);

const internalsFor = (bodies: ReadonlyArray<string>): DocumentInternals | undefined => {
  const objects: Array<TestObject> = [
    { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
    { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1/MediaBox[0 0 10 10]>>' },
    { number: 3, body: '<</Type/Page/Parent 2 0 R/Resources<<>>>>' },
    ...bodies.map((body, index): TestObject => ({ number: FIRST + index, body })),
  ];
  return internalsOf(loadDocument(buildPdf([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }]).bytes));
};

describe('properties', () => {
  it('gives an object the same text whichever objects had their texts worked out before it', () => {
    const graphs = acyclicObjects.chain(bodies =>
      fc.record({ bodies: fc.constant(bodies), order: fc.shuffledSubarray([...bodies.keys()], { minLength: bodies.length, maxLength: bodies.length }) }),
    );
    fc.assert(
      fc.property(graphs, ({ bodies, order }) => {
        const internals = internalsFor(bodies);
        if (internals === undefined) {
          throw new Error('the document has no internals');
        }
        const shared = new ResolvedTexts(internals);
        const inOrder = order.map(index => shared.text(pdfReference(FIRST + index, 0)));
        const alone = order.map(index => new ResolvedTexts(internals).text(pdfReference(FIRST + index, 0)));
        expect(inOrder).toStrictEqual(alone);
      }),
    );
  });
});
