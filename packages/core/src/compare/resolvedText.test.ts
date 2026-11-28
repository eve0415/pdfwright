import type { DocumentInternals } from '../document/documentInternals.ts';
import type { TestObject } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
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

const permutations = (items: ReadonlyArray<number>): Array<Array<number>> =>
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
    const threeCycle = textOf(['[21 0 R 1]', '[22 0 R 2]', '[20 0 R 3]', '[20 0 R 22 0 R]'], 3);
    const twoCycleAndSelfReference = textOf(['[21 0 R 1]', '[20 0 R 2]', '[22 0 R 3]', '[20 0 R 22 0 R]'], 3);
    const renumbered = textOf(['[21 0 R 2]', '[20 0 R 1]', '[22 0 R 3]', '[21 0 R 22 0 R]'], 3);
    expect([twoCycleAndSelfReference === renumbered, threeCycle === twoCycleAndSelfReference]).toStrictEqual([true, false]);
  });

  // Each object of a two-object cycle is described in thirteen steps: entering each of the two objects, its array and the array's one link; each array and the link into it while the two are sorted into one class; and writing the array, the link back to it and the array's end.
  it('describes reference cycles within the number of steps it may take in all, and refuses to go past it', () => {
    const internals = internalsOrThrow(['[21 0 R]', '[20 0 R]']);
    const unlimited = new ResolvedTexts(internals);
    const [atLimit, pastLimit] = [new ResolvedTexts(internals, 26), new ResolvedTexts(internals, 25)];
    expect([atLimit.text(pdfReference(20, 0)), atLimit.text(pdfReference(21, 0))]).toStrictEqual([
      unlimited.text(pdfReference(20, 0)),
      unlimited.text(pdfReference(21, 0)),
    ]);
    pastLimit.text(pdfReference(20, 0));
    expect(() => pastLimit.text(pdfReference(21, 0))).toThrow(ResourceLimitError);
    expect(() => pastLimit.text(pdfReference(21, 0))).toThrow(/reference cycles/);
  });

  it('describes a cycle the same whether a dictionary in it is direct or indirect', () => {
    const direct = textOf(['<</D<</Y 20 0 R/V 1>>/W 2>>']);
    const indirect = textOf(['<</D 21 0 R/W 2>>', '<</Y 20 0 R/V 1>>']);
    const otherValue = textOf(['<</D 21 0 R/W 2>>', '<</Y 20 0 R/V 3>>']);
    expect([direct === indirect, direct === otherValue]).toStrictEqual([true, false]);
  });

  it('describes a cycle the same whether a value in it is held by one object, by several or written inline', () => {
    const shared = textOf(['[21 0 R 21 0 R]', '<</Y 20 0 R>>']);
    const inline = textOf(['[<</Y 20 0 R>> <</Y 20 0 R>>]']);
    const twoObjects = textOf(['[21 0 R 22 0 R]', '<</Y 20 0 R>>', '<</Y 20 0 R>>']);
    const referringToItself = textOf(['[21 0 R 21 0 R]', '<</Y 21 0 R>>']);
    expect([shared === inline, shared === twoObjects, shared === referringToItself]).toStrictEqual([true, true, false]);
  });

  it('describes a value of a cycle that leads nowhere back the same whether it is direct or indirect', () => {
    const LONG = '<</A 1/B 2/C 3/D 4/E 5/F 6/G 7/H 8>>';
    expect([
      textOf(['[<</A 1>> 20 0 R]']) === textOf(['[21 0 R 20 0 R]', '<</A 1>>']),
      textOf([`[${LONG} 20 0 R]`]) === textOf(['[21 0 R 20 0 R]', LONG]),
      textOf(['[<</A 1>> 20 0 R]']) === textOf(['[21 0 R 20 0 R]', '<</A 2>>']),
    ]).toStrictEqual([true, true, false]);
  });

  it('describes objects that unfold to the same value the same, in a cycle or leading into one', () => {
    const tail = ['[21 0 R]', '[21 0 R]'];
    const twoCycles = ['[20 0 R 21 0 R]', '[21 0 R 21 0 R]'];
    const otherItem = ['[20 0 R 21 0 R]', '[21 0 R 1]'];
    expect([
      textOf(tail, 0) === textOf(tail, 1),
      textOf(twoCycles, 0) === textOf(twoCycles, 1),
      textOf(otherItem, 0) === textOf(otherItem, 1),
      textOf(['[21 0 R 22 0 R]', '[21 0 R]', '[23 0 R]', '[23 0 R 1]']) === textOf(['[21 0 R 21 0 R]', '[21 0 R]']),
    ]).toStrictEqual([true, true, false, false]);
  });

  // A chain of references that comes back to where it started reaches no object, so it reads as null like a reference to an object that is not defined.
  it('reads a cycle of references alone as null', () => {
    expect([textOf(['21 0 R', '20 0 R']), textOf(['[21 0 R]', '22 0 R', '21 0 R']), textOf(['<</A 21 0 R/B 1>>', '22 0 R', '21 0 R'])]).toStrictEqual([
      'null',
      textOf(['[null]']),
      textOf(['<</B 1>>']),
    ]);
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

type Item = number | { readonly to: number };

type Body = { readonly kind: 'array' | 'dictionary'; readonly items: ReadonlyArray<Item> } | { readonly kind: 'reference'; readonly to: number };

// Objects that are arrays, dictionaries or a bare reference, whose references may lead anywhere among them.
const anyBodies = fc.integer({ min: 1, max: 4 }).chain(count => {
  const to = fc.integer({ min: 0, max: count - 1 });
  const item = fc.oneof(
    fc.integer({ min: 0, max: 2 }),
    to.map((index): Item => ({ to: index })),
  );
  return fc.array(
    fc.oneof(
      fc.record({ kind: fc.constantFrom('array' as const, 'dictionary' as const), items: fc.array(item, { maxLength: 3 }) }),
      to.map((index): Body => ({ kind: 'reference', to: index })),
    ),
    { minLength: count, maxLength: count },
  );
});

const reference = (index: number): string => `${String(FIRST + index)} 0 R`;

const written = (body: Body): string => {
  if (body.kind === 'reference') {
    return reference(body.to);
  }
  const items = body.items.map(item => (typeof item === 'number' ? String(item) : reference(item.to)));
  return body.kind === 'array' ? `[${items.join(' ')}]` : `<<${items.map((value, position) => `/K${String(position)} ${value}`).join('')}>>`;
};

// The value an object unfolds to, cut off at `depth` arrays and dictionaries; a chain of bare references that comes back to where it started is null, and a dictionary entry whose value is null is left out.
const unfolded = (bodies: ReadonlyArray<Body>, index: number, depth: number): string => {
  const passed = new Set<number>();
  let body = bodies[index];
  for (let at = index; body?.kind === 'reference'; body = bodies[at]) {
    if (passed.has(at)) {
      return 'null';
    }
    passed.add(at);
    at = body.to;
  }
  if (body === undefined) {
    return 'null';
  }
  if (depth === 0) {
    return '*';
  }
  const items = body.items.map(item => (typeof item === 'number' ? String(item) : unfolded(bodies, item.to, depth - 1)));
  return body.kind === 'array'
    ? `[${items.join(' ')}]`
    : `<<${items
        .map((value, position) => `K${String(position)} ${value}`)
        .filter(entry => !entry.endsWith(' null'))
        .join(' ')}>>`;
};

// For each pair of objects, whether the two read the same.
const sameness = (values: ReadonlyArray<string>): Array<Array<boolean>> => values.map(left => values.map(right => left === right));

describe('properties', () => {
  // Values in a graph of n objects that differ, differ within n arrays and dictionaries of their start, so unfolding one more than that tells them apart.
  it('gives two objects the same text exactly when they unfold to the same value', () => {
    fc.assert(
      fc.property(anyBodies, bodies => {
        const internals = internalsOrThrow(bodies.map(written));
        const texts = new ResolvedTexts(internals);
        expect(sameness(bodies.map((_, index) => texts.text(pdfReference(FIRST + index, 0))))).toStrictEqual(
          sameness(bodies.map((_, index) => unfolded(bodies, index, bodies.length + 1))),
        );
      }),
    );
  });

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
