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

// The fewest steps that describing reference cycles may take for `describe` to finish on a fresh ResolvedTexts.
const fewestSteps = (internals: DocumentInternals, describe: (texts: ResolvedTexts) => ReadonlyArray<string>): number => {
  const finishes = (steps: number): boolean => {
    try {
      describe(new ResolvedTexts(internals, steps));
      return true;
    } catch (error: unknown) {
      if (error instanceof ResourceLimitError) {
        return false;
      }
      throw error;
    }
  };
  let high = 1;
  while (!finishes(high)) {
    high *= 2;
  }
  let low = 0;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (finishes(middle)) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
};

// The steps that describing a second value takes after a first, when the two lead into a cycle of `size` objects at different objects.
const extraSteps = (size: number): number => {
  const ring = Array.from({ length: size }, (_, index) => `[${String(22 + ((index + 1) % size))} 0 R ${String(index)}]`);
  const internals = internalsOrThrow(['<</X 22 0 R>>', '<</Y 23 0 R>>', ...ring]);
  const [first, second] = [FIRST, 21].map(number => internals.objects.deref(pdfReference(number, 0)));
  return fewestSteps(internals, texts => [texts.text(first), texts.text(second)]) - fewestSteps(internals, texts => [texts.text(first)]);
};

// The fewest steps for describing an array of `count` like cycles of two objects, which differ only in a number and each lead out into one self-referring array.
const likeCyclesSteps = (count: number): number => {
  const cycles = Array.from({ length: count }, (_, index) => [`[${String(23 + 2 * index)} 0 R 20 0 R]`, `[${String(22 + 2 * index)} 0 R ${String(index)}]`]);
  const internals = internalsOrThrow(['[20 0 R]', `[${cycles.map((_, index) => `${String(22 + 2 * index)} 0 R`).join(' ')}]`, ...cycles.flat()]);
  return fewestSteps(internals, texts => [texts.text(pdfReference(21, 0))]);
};

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

  // A two-object cycle is described in seventeen steps: entering each of its two objects, its array and the array's link; following each of the two links while the arrays are sorted into strongly connected components; each array and the link into it while the two are merged into one class, and that class and its link while it is numbered; writing that class; and keeping its text with its link. The second object keeps its text from the first description, so asking for it takes no more steps.
  it('describes reference cycles within the number of steps it may take in all, and refuses to go past it', () => {
    const internals = internalsOrThrow(['[21 0 R]', '[20 0 R]']);
    const unlimited = new ResolvedTexts(internals);
    const atLimit = new ResolvedTexts(internals, 17);
    expect([atLimit.text(pdfReference(20, 0)), atLimit.text(pdfReference(21, 0))]).toStrictEqual([
      unlimited.text(pdfReference(20, 0)),
      unlimited.text(pdfReference(21, 0)),
    ]);
    expect(() => new ResolvedTexts(internals, 16).text(pdfReference(20, 0))).toThrow(ResourceLimitError);
    expect(() => new ResolvedTexts(internals, 16).text(pdfReference(20, 0))).toThrow(/reference cycles/);
  });

  // The value asked for is described in nineteen steps: entering each of the three objects, its array and the array's link; following the three links while the arrays are sorted into strongly connected components; for the self-referring array, the array and its link while it is put into a class, the class and its link while it is numbered, writing the class and keeping its text with its link. Each of the other two arrays then has the same label and leads to the same text, so it reads as that text, already kept.
  it('describes only the value asked for, not each object it passes on the way into a cycle', () => {
    const internals = internalsOrThrow(['[21 0 R]', '[22 0 R]', '[22 0 R]']);
    expect(new ResolvedTexts(internals, 19).text(pdfReference(20, 0))).toBe(new ResolvedTexts(internals).text(pdfReference(22, 0)));
    expect(() => new ResolvedTexts(internals, 18).text(pdfReference(20, 0))).toThrow(ResourceLimitError);
  });

  // 20 is matched to 21, which it leads into and unfolds like, in twenty-six steps: entering each of the two objects, its array and the array's two links; following the four links while the arrays are sorted into strongly connected components; for 21, its array and the links into it while it is put into a class, the class and its links while it is numbered, writing the class and keeping its text with its two links; and for 20, trying 21 and matching its array and two links.
  it('matches a cycle to one it leads into within the number of steps it may take, and refuses to go past it', () => {
    const internals = internalsOrThrow(['[20 0 R 21 0 R]', '[21 0 R 21 0 R]']);
    expect(new ResolvedTexts(internals, 26).text(pdfReference(20, 0))).toBe(new ResolvedTexts(internals).text(pdfReference(21, 0)));
    expect(() => new ResolvedTexts(internals, 25).text(pdfReference(20, 0))).toThrow(ResourceLimitError);
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
    const LONG = '<</A 1/B 2/C 3/D 4/E 5/F 6/G 7/H 8/I 9/J 10/K 11/L 12>>';
    expect([
      textOf(['[<</A 1>> 20 0 R]']) === textOf(['[21 0 R 20 0 R]', '<</A 1>>']),
      textOf([`[${LONG} 20 0 R]`]) === textOf(['[21 0 R 20 0 R]', LONG]),
      textOf([`[[${LONG}] 20 0 R]`]) === textOf(['[21 0 R 20 0 R]', `[${LONG}]`]),
      textOf([`[(${'x'.repeat(40)}) 20 0 R]`]) === textOf(['[21 0 R 20 0 R]', `(${'x'.repeat(40)})`]),
      textOf(['[<</A 1>> 20 0 R]']) === textOf(['[21 0 R 20 0 R]', '<</A 2>>']),
    ]).toStrictEqual([true, true, true, true, false]);
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

  it('describes a value asked for again without taking more steps', () => {
    const internals = internalsOrThrow(['<</Type/Encoding/X 21 0 R>>', '[21 0 R]']);
    const value = internals.objects.deref(pdfReference(FIRST, 0));
    const texts = new ResolvedTexts(
      internals,
      fewestSteps(internals, once => [once.text(value)]),
    );
    expect(texts.text(value)).toBe(texts.text(value));
  });

  // A cycle that many values lead into, such as a page tree that encoding dictionaries reach through their pages, is described once, so each further value costs only what it holds itself.
  it('describes a second value that leads into a cycle in steps that do not grow with the cycle', () => {
    expect(extraSteps(40)).toBe(extraSteps(2));
  });

  it('describes each of many like cycles that lead into one cycle in steps that do not grow with how many came before', () => {
    expect(likeCyclesSteps(41) - likeCyclesSteps(40)).toBe(likeCyclesSteps(11) - likeCyclesSteps(10));
  });

  // The cycle of 21 unfolds like that of 20; its first link that leaves it leads where 20's first link leaves 20's cycle, and only its last leads into 20's cycle.
  it('describes a cycle that leads into one it unfolds like the same as that one, whichever of its links leads into it', () => {
    const bodies = ['[22 0 R 20 0 R 20 0 R]', '[22 0 R 21 0 R 20 0 R]', '[22 0 R 1]', '[22 0 R 23 0 R 22 0 R]'];
    const shared = new ResolvedTexts(internalsOrThrow(bodies));
    expect([
      shared.text(pdfReference(20, 0)) === shared.text(pdfReference(21, 0)),
      textOf(bodies, 1) === textOf(bodies, 0),
      textOf(bodies, 3) === textOf(bodies, 0),
    ]).toStrictEqual([true, true, false]);
  });

  // A chain of references that comes back to where it started reaches no object, so it reads as null like a reference to an object that is not defined.
  it('reads a cycle of references alone as null', () => {
    expect([textOf(['21 0 R', '20 0 R']), textOf(['[21 0 R]', '22 0 R', '21 0 R']), textOf(['<</A 21 0 R/B 1>>', '22 0 R', '21 0 R'])]).toStrictEqual([
      'null',
      textOf(['[null]']),
      textOf(['<</B 1>>']),
    ]);
  });

  // Wider than the arguments a call can take on some engines, so that an array whose items are passed to one call cannot be read.
  const WIDE = 70_000;

  it('describes an array of many items that leads into a cycle', { timeout: 30_000 }, () => {
    const internals = internalsOrThrow(['<</X 21 0 R>>', `[${'22 0 R '.repeat(WIDE)}]`, '[22 0 R]', '<</X 24 0 R>>', '[22 0 R 22 0 R]']);
    const texts = new ResolvedTexts(internals);
    const direct = texts.text(internals.objects.deref(pdfReference(FIRST, 0)));
    expect([direct === new ResolvedTexts(internals).text(pdfReference(FIRST, 0)), direct === texts.text(pdfReference(23, 0))]).toStrictEqual([true, false]);
  });

  it('describes a dictionary of many entries that leads into a cycle', { timeout: 30_000 }, () => {
    const entries = Array.from({ length: WIDE }, (_, index) => `/K${String(index)} 22 0 R`).join('');
    const internals = internalsOrThrow(['<</X 21 0 R>>', `<<${entries}>>`, '[22 0 R]', '<</X 24 0 R>>', '<</K0 22 0 R/K1 22 0 R>>']);
    const texts = new ResolvedTexts(internals);
    const direct = texts.text(internals.objects.deref(pdfReference(FIRST, 0)));
    expect([direct === new ResolvedTexts(internals).text(pdfReference(FIRST, 0)), direct === texts.text(pdfReference(23, 0))]).toStrictEqual([true, false]);
  });
});

describe('wide values', { timeout: 30_000 }, () => {
  // Wider than the arguments a call can take on any engine the library runs on.
  const WIDEST = 150_000;

  it('reads an array of many items', () => {
    const internals = internalsOrThrow([`[${'1 '.repeat(WIDEST)}2]`]);
    expect(new ResolvedTexts(internals).text(internals.objects.deref(pdfReference(FIRST, 0)))).toBe(`[${'n1 '.repeat(WIDEST)}n2]`);
  });

  it('reads a dictionary of many entries', () => {
    const entries = Array.from({ length: WIDEST }, (_, index) => `/K${String(index)} ${String(index % 2)}`);
    const internals = internalsOrThrow([
      `<<${entries.join('')}>>`,
      `<<${entries.toReversed().join('')}>>`,
      `<<${entries.with(-1, `/K${String(WIDEST - 1)} 2`).join('')}>>`,
    ]);
    const texts = [FIRST, 21, 22].map(number => new ResolvedTexts(internals).text(internals.objects.deref(pdfReference(number, 0))));
    expect([texts[0] === texts[1], texts[0] === texts[2]]).toStrictEqual([true, false]);
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
  // Each object gets two copies whose links lead to copies or to the objects themselves, as chosen: the copies unfold like the objects, though the graph holds a different number of each. The objects are described first, so that the copies' cycles lead into cycles already described.
  it('gives an object and a copy of it that leads to other copies the same text', () => {
    const copied = anyBodies.chain(bodies =>
      fc.record({
        bodies: fc.constant(bodies),
        copies: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: bodies.length * 6, maxLength: bodies.length * 6 }),
      }),
    );
    fc.assert(
      fc.property(copied, ({ bodies, copies }) => {
        const count = bodies.length;
        // Copy `round` of object `index` is object `index + count * round`; round 0 is the object itself, whose links stay among the objects.
        const copy = (round: number, index: number, place: number, to: number): number =>
          round === 0 ? to : to + count * (copies[((round - 1) * count + index) * 3 + place] ?? 0);
        const all = [0, 1, 2].flatMap(round =>
          bodies.map((body, index): Body =>
            body.kind === 'reference'
              ? { kind: 'reference', to: copy(round, index, 0, body.to) }
              : { kind: body.kind, items: body.items.map((item, place) => (typeof item === 'number' ? item : { to: copy(round, index, place, item.to) })) },
          ),
        );
        const internals = internalsOrThrow(all.map(written));
        const shared = new ResolvedTexts(internals);
        const texts = all.map((_, index) => shared.text(pdfReference(FIRST + index, 0)));
        expect(texts).toStrictEqual([0, 1, 2].flatMap(() => texts.slice(0, count)));
        expect(texts).toStrictEqual(all.map((_, index) => new ResolvedTexts(internals).text(pdfReference(FIRST + index, 0))));
      }),
    );
  });

  // Arrays of references, some with a number among them, and three rounds of copies whose links lead to copies of any round, as chosen: each copy unfolds like its object, though the copies hold a different number of each, so the numbering of a cycle's classes cannot follow how many objects each holds.
  it('gives an object the same text as its copies in a graph of copies apart from it', () => {
    const graphs = fc.integer({ min: 3, max: 7 }).chain(count =>
      fc.record({
        shapes: fc.array(
          fc.record({ first: fc.integer({ min: 0, max: count - 1 }), second: fc.integer({ min: 0, max: count - 1 }), form: fc.integer({ min: 0, max: 3 }) }),
          { minLength: count, maxLength: count },
        ),
        copies: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: count * 6, maxLength: count * 6 }),
      }),
    );
    fc.assert(
      fc.property(graphs, ({ shapes, copies }) => {
        const count = shapes.length;
        const all = [0, 1, 2, 3].flatMap(round =>
          shapes.map(({ first, second, form }, index): Body => {
            const to = (target: number, place: number): Item => ({
              to: round === 0 ? target : target + count * (copies[((round - 1) * count + index) * 2 + place] ?? 1),
            });
            const forms: Array<Array<Item>> = [
              [to(first, 0), to(second, 1)],
              [to(first, 0), 1, to(second, 1)],
              [to(first, 0)],
              [to(first, 0), to(second, 1), 1],
            ];
            return { kind: 'array', items: forms[form] ?? [] };
          }),
        );
        const internals = internalsOrThrow(all.map(written));
        const textAt = (index: number): string => new ResolvedTexts(internals).text(pdfReference(FIRST + index, 0));
        const originals = shapes.map((_, index) => textAt(index));
        expect([1, 2, 3].flatMap(round => shapes.map((_, index) => textAt(index + count * round)))).toStrictEqual([1, 2, 3].flatMap(() => originals));
      }),
      // Two graphs where numbering a cycle's classes by how many objects each holds, or by the order its objects were met, gives the copies other texts.
      {
        examples: [
          [
            {
              shapes: [
                [5, 0, 0],
                [0, 0, 1],
                [0, 0, 0],
                [2, 0, 0],
                [0, 0, 0],
                [0, 3, 1],
              ].map(([first = 0, second = 0, form = 0]) => ({ first, second, form })),
              copies: Array.from({ length: 36 }, (_, index) => (index === 11 || index === 19 ? 2 : 1)),
            },
          ],
          [
            {
              shapes: [
                [0, 1, 3],
                [2, 0, 0],
                [0, 3, 1],
                [3, 4, 0],
                [3, 0, 1],
              ].map(([first = 0, second = 0, form = 0]) => ({ first, second, form })),
              copies: Array.from({ length: 30 }, () => 1),
            },
          ],
        ],
      },
    );
  });

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

  // Each object is asked for by its reference or as the value it holds, in any order, so that what one ResolvedTexts kept from earlier values is reused across both forms.
  it('gives two objects the same text exactly when they unfold to the same value, in any order and whether asked for directly or by reference', () => {
    const graphs = anyBodies.chain(bodies =>
      fc.record({
        bodies: fc.constant(bodies),
        order: fc.shuffledSubarray([...bodies.keys()], { minLength: bodies.length, maxLength: bodies.length }),
        direct: fc.array(fc.boolean(), { minLength: bodies.length, maxLength: bodies.length }),
      }),
    );
    fc.assert(
      fc.property(graphs, ({ bodies, order, direct }) => {
        const internals = internalsOrThrow(bodies.map(written));
        const asked = (index: number) => (direct[index] === true ? internals.objects.deref(pdfReference(FIRST + index, 0)) : pdfReference(FIRST + index, 0));
        const shared = new ResolvedTexts(internals);
        const texts = order.map(index => shared.text(asked(index)));
        expect(texts).toStrictEqual(order.map(index => new ResolvedTexts(internals).text(asked(index))));
        const leadingIntoCycles = order.flatMap((index, at) => {
          const text = texts[at];
          return text?.startsWith('~') === true ? [{ text, unfolds: unfolded(bodies, index, bodies.length + 1) }] : [];
        });
        expect(sameness(leadingIntoCycles.map(({ text }) => text))).toStrictEqual(sameness(leadingIntoCycles.map(({ unfolds }) => unfolds)));
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
