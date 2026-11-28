import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pdfReference } from '../object/pdfObject.ts';
import { buildPdf, streamBody } from '../testing/pdfBuilder.ts';

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

const internalsOrThrow = (bodies: ReadonlyArray<string>): DocumentInternals => {
  const internals = internalsFor(bodies);
  if (internals === undefined) {
    throw new Error('the document has no internals');
  }
  return internals;
};

// The texts of the objects numbered FIRST + index in `order`, worked out one after another by one ResolvedTexts and each by a fresh one.
const textsInOrder = (bodies: ReadonlyArray<string>, order: ReadonlyArray<number>) => {
  const internals = internalsOrThrow(bodies);
  const shared = new ResolvedTexts(internals);
  return {
    shared: order.map(index => shared.text(pdfReference(FIRST + index, 0))),
    alone: order.map(index => new ResolvedTexts(internals).text(pdfReference(FIRST + index, 0))),
  };
};

// The text of the object numbered FIRST + index, worked out by a fresh ResolvedTexts.
const textOf = (bodies: ReadonlyArray<string>, index = 0): string => new ResolvedTexts(internalsOrThrow(bodies)).text(pdfReference(FIRST + index, 0));

const permutations =(items: ReadonlyArray<number>): Array<Array<number>> =>
  items.length === 0 ? [[]] : items.flatMap((item, index) => permutations(items.toSpliced(index, 1)).map(rest => [item, ...rest]));

describe('reference cycles', () => {
  // ISO 32000-1:2008, 7.3.7 gives the order of dictionary entries no meaning, so the text of an object cannot depend on which object a walk met first.
  it.each([
    { name: 'a two-object cycle', bodies: ['[21 0 R 1]', '[20 0 R 2]'] },
    { name: 'a three-object cycle', bodies: ['[21 0 R 1]', '[22 0 R 2]', '[20 0 R 3]'] },
    { name: 'a self-reference and an object that refers to it', bodies: ['[20 0 R 1]', '[20 0 R 2]'] },
    { name: 'a cycle and an acyclic object that leads into it', bodies: ['[21 0 R 1]', '[20 0 R 2]', '<</K 20 0 R/L 21 0 R>>'] },
  ])('gives each object the same text in every order, for $name', ({ bodies }) => {
    for (const order of permutations([...bodies.keys()])) {
      const { shared, alone } = textsInOrder(bodies, order);
      expect(shared).toStrictEqual(alone);
    }
  });

  // The encoding of a stream is the resolved text of its Filter and DecodeParms (ISO 32000-1:2008, 7.3.8.2, Table 5).
  it.each(['Filter', 'DecodeParms'])(
    'describes the encoding of a stream whose %s leads into a cycle the same whichever object of the cycle was met first',
    key => {
      const internals = internalsOrThrow([streamBody(`/${key} 21 0 R`, 'x'), '[22 0 R 1]', '[21 0 R 2]']);
      const stream = internals.objects.deref(pdfReference(FIRST, 0));
      if (stream?.kind !== 'stream') {
        throw new Error('object 20 is not a stream');
      }
      const shared = new ResolvedTexts(internals);
      shared.text(pdfReference(22, 0));
      expect(shared.encoding(stream)).toBe(new ResolvedTexts(internals).encoding(stream));
    },
  );

  it('distinguishes cycles whose objects hold different values', () => {
    const [one, two] = [textsInOrder(['[21 0 R 1]', '[20 0 R 2]'], [0, 1]).alone, textsInOrder(['[21 0 R 1]', '[20 0 R 3]'], [0, 1]).alone];
    expect([one[0] === two[0], one[1] === two[1], one[0] === one[1]]).toStrictEqual([false, false, false]);
  });

  it('tells apart cycles that differ only in which object refers to which', () => {
    const forward = textOf(['[21 0 R 22 0 R]', '<</P 1/X 20 0 R>>', '<</P 2/X 20 0 R>>']);
    const renumbered = textOf(['[22 0 R 21 0 R]', '<</P 2/X 20 0 R>>', '<</P 1/X 20 0 R>>']);
    const swapped = textOf(['[22 0 R 21 0 R]', '<</P 1/X 20 0 R>>', '<</P 2/X 20 0 R>>']);
    expect([forward === renumbered, forward === swapped]).toStrictEqual([true, false]);
  });

  it('keeps the description of a cycle apart from the items that follow it', () => {
    const threeCycle = textOf(['[21 0 R]', '[22 0 R]', '[20 0 R]', '[20 0 R]'], 3);
    const twoCycleAndSelfReference = textOf(['[21 0 R]', '[20 0 R]', '[22 0 R]', '[20 0 R 22 0 R]'], 3);
    const renumbered = textOf(['[21 0 R]', '[20 0 R]', '[22 0 R]', '[21 0 R 22 0 R]'], 3);
    expect([twoCycleAndSelfReference === renumbered, threeCycle === twoCycleAndSelfReference]).toStrictEqual([true, false]);
  });

  it('describes a cycle the same whether a dictionary in it is direct or indirect', () => {
    const direct = textOf(['<</D<</Y 20 0 R/V 1>>/W 2>>']);
    const indirect = textOf(['<</D 21 0 R/W 2>>', '<</Y 20 0 R/V 1>>']);
    const otherValue = textOf(['<</D 21 0 R/W 2>>', '<</Y 20 0 R/V 3>>']);
    expect([direct === indirect, direct === otherValue]).toStrictEqual([true, false]);
  });
});

// Objects whose references may lead anywhere among them, so that cycles of any length arise.
const anyObjects = fc.integer({ min: 1, max: 4 }).chain(count => {
  const item = fc.oneof(
    fc.integer({ min: 0, max: 2 }).map(String),
    fc.integer({ min: 0, max: count - 1 }).map(index => `${String(FIRST + index)} 0 R`),
  );
  return fc.array(
    fc.oneof(
      fc.array(item, { maxLength: 3 }).map(items => `[${items.join(' ')}]`),
      fc.array(item, { maxLength: 3 }).map(items => `<<${items.map((value, position) => `/K${String(position)} ${value}`).join('')}>>`),
    ),
    { minLength: count, maxLength: count },
  );
});

describe('properties', () => {
  it('gives an object the same text whichever objects had their texts worked out before it, when references form cycles', () => {
    const graphs = anyObjects.chain(bodies =>
      fc.record({ bodies: fc.constant(bodies), order: fc.shuffledSubarray([...bodies.keys()], { minLength: bodies.length, maxLength: bodies.length }) }),
    );
    fc.assert(
      fc.property(graphs, ({ bodies, order }) => {
        const { shared, alone } = textsInOrder(bodies, order);
        expect(shared).toStrictEqual(alone);
      }),
    );
  });

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
