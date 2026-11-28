import type { TestObject } from '../../testing/pdfBuilder.ts';
import type { SpaceColorants } from './colorSpaceColorants.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { pdfReference } from '../../object/pdfObject.ts';
import { latin1Text, streamBody } from '../../testing/pdfBuilder.ts';
import { textPdf } from '../../testing/textPdf.ts';

import { colorSpaceColorants } from './colorSpaceColorants.ts';

const TINT = '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>';

const REFERENCED: ReadonlyArray<TestObject> = [
  { number: 101, body: '/Referenced' },
  { number: 102, body: '[/ICCBased 104 0 R]' },
  { number: 103, body: TINT },
  { number: 104, body: streamBody('/N 4', '') },
];

// The colorants of the colour space written as object 100, with the other objects it refers to.
const colorants = (space: string, objects: ReadonlyArray<TestObject> = []): SpaceColorants => {
  const document = textPdf({ pages: [{}], objects: [{ number: 100, body: space }, ...objects] });
  return colorSpaceColorants(document.objects, document.objects.deref(pdfReference(100, 0)));
};

const summary = (result: SpaceColorants): Array<string> =>
  result.colorants.map(
    colorant =>
      `${latin1Text(colorant.name)}:${colorant.kind}${colorant.component ? '' : ':listed'}${colorant.alternate === undefined ? '' : `:${colorant.alternate.family}`}`,
  );

const definition = (space: string, objects: ReadonlyArray<TestObject> = []): string | undefined =>
  colorants(space, objects).colorants[0]?.alternate?.definition;

// A PostScript calculator tint transform (ISO 32000-1:2008, 7.10.5) as object 101.
const postScript = (program: string): ReadonlyArray<TestObject> => [
  { number: 101, body: streamBody('/FunctionType 4/Domain[0 1]/Range[0 1 0 1 0 1 0 1]', program) },
];

// A stitching function (ISO 32000-1:2008, 7.10.4) as object 101 whose only function is itself.
const selfStitching = (domain: string): ReadonlyArray<TestObject> => [
  { number: 101, body: `<</FunctionType 3/Domain${domain}/Functions[101 0 R]/Bounds[]/Encode[0 1]>>` },
];

// A Separation space of Gold inside the given number of Pattern spaces.
const nested = (levels: number): string => '[/Pattern '.repeat(levels) + `[/Separation/Gold/DeviceCMYK ${TINT}]` + ']'.repeat(levels);

describe('colorants of colour spaces', () => {
  it('reads a Separation colorant with its kind and alternate space', () => {
    const cases = ['Spot', 'All', 'None', 'Cyan', 'Magenta', 'Yellow', 'Black'].map(name => summary(colorants(`[/Separation/${name}/DeviceCMYK ${TINT}]`)));
    expect(cases).toStrictEqual([
      ['Spot:spot:DeviceCMYK'],
      ['All:all:DeviceCMYK'],
      ['None:none:DeviceCMYK'],
      ['Cyan:process:DeviceCMYK'],
      ['Magenta:process:DeviceCMYK'],
      ['Yellow:process:DeviceCMYK'],
      ['Black:process:DeviceCMYK'],
    ]);
  });

  it('keeps a colorant name as the bytes its escapes decode to', () => {
    const [colorant] = colorants(`[/Separation/#E7#89#B9#E8#89#B2/DeviceCMYK ${TINT}]`).colorants;
    expect(colorant?.name).toStrictEqual(Uint8Array.of(0xe7, 0x89, 0xb9, 0xe8, 0x89, 0xb2));
  });

  it('resolves references in the space, its name and its alternate', () => {
    expect(summary(colorants('[/Separation 101 0 R 102 0 R 103 0 R]', REFERENCED))).toStrictEqual(['Referenced:spot:ICCBased']);
  });

  it('reads DeviceN components, with None components and the reserved process names', () => {
    const result = colorants(`[/DeviceN[/Cyan/Gold/None]/DeviceCMYK ${TINT}]`);
    expect([summary(result), result.warnings]).toStrictEqual([['Cyan:process', 'Gold:spot', 'None:none'], []]);
  });

  it('reports All in a DeviceN space, where 8.6.6.5 forbids it', () => {
    const result = colorants(`[/DeviceN[/All/Gold]/DeviceCMYK ${TINT}]`);
    expect([summary(result), result.warnings.map(warning => warning.code)]).toStrictEqual([['All:all', 'Gold:spot'], ['devicen-all']]);
  });

  it('reads an NChannel space: process components, spot components with their Separation alternates, and listed extra colorants', () => {
    const attributes = `<</Subtype/NChannel/Process<</ColorSpace/DeviceRGB/Components[/R/G/B]>>/Colorants<</Gold[/Separation/Gold/DeviceCMYK ${TINT}]/Silver[/Separation/Silver/DeviceGray ${TINT}]>>>>`;
    expect(summary(colorants(`[/DeviceN[/R/Gold/Magenta]/DeviceRGB ${TINT} ${attributes}]`))).toStrictEqual([
      'R:process',
      'Gold:spot:DeviceCMYK',
      'Magenta:process',
      'Silver:spot:listed:DeviceGray',
    ]);
  });

  it('reads the base of an Indexed space and of a Pattern space', () => {
    const separation = `[/Separation/Gold/DeviceCMYK ${TINT}]`;
    expect([summary(colorants(`[/Indexed ${separation} 1 <00FF>]`)), summary(colorants(`[/Pattern ${separation}]`))]).toStrictEqual([
      ['Gold:spot:DeviceCMYK'],
      ['Gold:spot:DeviceCMYK'],
    ]);
  });

  it('finds no colorants in device, CIE-based and Pattern family spaces', () => {
    expect(
      ['/DeviceCMYK', '/Pattern', '[/CalGray<</WhitePoint[1 1 1]>>]', '[/Lab<</WhitePoint[1 1 1]>>]'].map(space => colorants(space).colorants),
    ).toStrictEqual([[], [], [], []]);
  });

  it('reports a Separation space whose colorant is not a name as unreadable', () => {
    const result = colorants(`[/Separation 42/DeviceCMYK ${TINT}]`);
    expect([result.colorants, result.warnings.map(warning => warning.code)]).toStrictEqual([[], ['colorspace-unreadable']]);
  });

  it('gives equal definitions to equal alternates and tint transforms, whatever objects hold them', () => {
    const direct = definition(`[/Separation/Gold/DeviceCMYK ${TINT}]`);
    const referenced = definition('[/Separation/Gold/DeviceCMYK 101 0 R]', [{ number: 101, body: TINT }]);
    const other = definition(`[/Separation/Gold/DeviceCMYK ${TINT.replace('0 1 0 0', '0 0 1 0')}]`);
    expect([direct === referenced, direct === other]).toStrictEqual([true, false]);
  });

  it.each([
    ['dictionary keys in another order', '<</N 1/FunctionType 2/C1[0 1 0 0]/C0[0 0 0 0]/Domain[0 1]>>', true],
    ['an integer written as an equal real', '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1.0>>', true],
    ['another exponent', '<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 2>>', false],
  ])('compares tint transforms by value: %s', (_, tint, equal) => {
    expect(definition(`[/Separation/Gold/DeviceCMYK ${tint}]`) === definition(`[/Separation/Gold/DeviceCMYK ${TINT}]`)).toBe(equal);
  });

  it('tells apart PostScript tint transforms whose dictionaries are equal and whose code differs', () => {
    const space = '[/Separation/Gold/DeviceCMYK 101 0 R]';
    const first = definition(space, postScript('{ 0 exch 0 0 }'));
    expect([first === definition(space, postScript('{ 0 exch 0 0 }')), first === definition(space, postScript('{ 0 0 exch 0 }'))]).toStrictEqual([true, false]);
  });

  it('gives a definition to a stitching tint transform whose Functions refer to itself', () => {
    const space = '[/Separation/Gold/DeviceCMYK 101 0 R]';
    const [first, second] = [definition(space, selfStitching('[0 1]')), definition(space, selfStitching('[0 2]'))];
    expect([first, first === second]).toStrictEqual([expect.stringMatching(/^[0-9a-f]{32}$/u), false]);
  });

  it('reads a space given as a reference as the space it refers to', () => {
    const document = textPdf({ pages: [{}], objects: [{ number: 100, body: `[/Separation/Gold/DeviceCMYK ${TINT}]` }] });
    expect(summary(colorSpaceColorants(document.objects, pdfReference(100, 0)))).toStrictEqual(['Gold:spot:DeviceCMYK']);
  });

  it('reports the family of an alternate that is neither a name nor an array as unknown', () => {
    expect(summary(colorants(`[/Separation/Gold 42 ${TINT}]`))).toStrictEqual(['Gold:spot:unknown']);
  });

  // ISO 32000-1:2008, 8.6.6.5: the names of a DeviceN space are "an array of name objects specifying the individual colour components".
  it.each([
    ['names that are not an array', `[/DeviceN/Gold/DeviceCMYK ${TINT}]`, [], 1],
    ['a component that is not a name', `[/DeviceN[/Gold 5/Silver]/DeviceCMYK ${TINT}]`, ['Gold:spot', 'Silver:spot'], 1],
    ['components that are all names', `[/DeviceN[/Gold/Silver]/DeviceCMYK ${TINT}]`, ['Gold:spot', 'Silver:spot'], 0],
  ])('reads a DeviceN space with %s', (_, space, expected, warnings) => {
    const result = colorants(space);
    expect([summary(result), result.warnings.map(warning => warning.code)]).toStrictEqual([
      expected,
      Array.from({ length: warnings }, () => 'colorspace-unreadable'),
    ]);
  });

  it('reads NChannel Colorants entries that are not Separation arrays as colorants without an alternate', () => {
    const attributes = `<</Subtype/NChannel/Colorants<</Gold 42/Extra 43/Cyan [/Separation/Cyan/DeviceCMYK ${TINT}]/All [/Separation/All/DeviceGray ${TINT}]>>>>`;
    const result = colorants(`[/DeviceN[/Gold]/DeviceCMYK ${TINT} ${attributes}]`);
    expect(result.colorants.map(colorant => [latin1Text(colorant.name), colorant.kind, colorant.component, colorant.alternate?.family])).toStrictEqual([
      ['Gold', 'spot', true, undefined],
      ['Extra', 'spot', false, 'unknown'],
      ['Cyan', 'process', false, 'DeviceCMYK'],
      ['All', 'all', false, 'DeviceGray'],
    ]);
  });

  // 8.6.6.3 and 8.7.3.3 nest one space in another; nesting is followed eight levels deep, which ends a cycle through references.
  it('follows nested bases eight levels deep, and a cycle through references ends without colorants', () => {
    const cycle = colorants('[/Indexed 100 0 R 1 <00FF>]');
    expect([summary(colorants(nested(8))), summary(colorants(nested(9))), cycle]).toStrictEqual([
      ['Gold:spot:DeviceCMYK'],
      [],
      { colorants: [], warnings: [] },
    ]);
  });
});

// One entry of a generated tint transform dictionary: a number or an array of numbers, written as integers or as equal reals, directly or as an indirect object.
interface Entry {
  readonly key: string;
  readonly value: number | ReadonlyArray<number>;
  readonly real: boolean;
  readonly indirect: boolean;
}

const numberText = (value: number, real: boolean): string => (real ? `${String(value)}.0` : String(value));

const valueText = ({ value, real }: Entry): string =>
  typeof value === 'number' ? numberText(value, real) : `[${value.map(item => numberText(item, real)).join(' ')}]`;

interface WrittenSpace {
  readonly space: string;
  readonly objects: ReadonlyArray<TestObject>;
}

// A Separation space whose tint transform holds the entries in the order given, and the objects that hold the indirect ones.
const tintSpace = (entries: ReadonlyArray<Entry>): WrittenSpace => {
  const objects: Array<TestObject> = [];
  const pairs = entries.map(entry => {
    if (!entry.indirect) {
      return `/${entry.key} ${valueText(entry)}`;
    }
    const number = 101 + objects.length;
    objects.push({ number, body: valueText(entry) });
    return `/${entry.key} ${String(number)} 0 R`;
  });
  return { space: `[/Separation/Gold/DeviceCMYK <<${pairs.join('')}>>]`, objects };
};

const entryDefinition = (entries: ReadonlyArray<Entry>): string | undefined => {
  const { space, objects } = tintSpace(entries);
  return definition(space, objects);
};

describe('properties', () => {
  const plain = fc.uniqueArray(
    fc.record({
      key: fc.constantFrom('C0', 'C1', 'Domain', 'N', 'Range', 'Size'),
      value: fc.oneof(fc.integer({ min: -50, max: 50 }), fc.array(fc.integer({ min: -9, max: 9 }), { maxLength: 4 })),
    }),
    { selector: entry => entry.key, minLength: 1, maxLength: 6 },
  );
  // The same entries written plainly, and permuted with some values indirect or written as reals.
  const written = plain.chain(entries =>
    fc.tuple(
      fc.constant(entries.map(entry => ({ ...entry, real: false, indirect: false }))),
      fc
        .shuffledSubarray(entries, { minLength: entries.length })
        .chain(shuffled =>
          fc.tuple(
            ...shuffled.map(entry => fc.record({ key: fc.constant(entry.key), value: fc.constant(entry.value), real: fc.boolean(), indirect: fc.boolean() })),
          ),
        ),
    ),
  );

  it('gives one definition to a tint transform whatever its key order, indirection and number form', () => {
    fc.assert(
      fc.property(written, ([original, rewritten]) => {
        expect(entryDefinition(rewritten)).toBe(entryDefinition(original));
      }),
    );
  });

  it('gives another definition when a number of the tint transform changes', () => {
    fc.assert(
      fc.property(written, ([original]) => {
        const [first, ...rest] = original;
        if (first === undefined) {
          throw new Error('the generator gives at least one entry');
        }
        const { value } = first;
        const changed = typeof value === 'number' ? value + 1 : [(value[0] ?? 0) + 1, ...value.slice(1)];
        expect(entryDefinition([{ ...first, value: changed }, ...rest])).not.toBe(entryDefinition(original));
      }),
    );
  });
});
