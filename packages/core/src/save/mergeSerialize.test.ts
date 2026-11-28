import type { Length } from '../length/length.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';
import type { SourceNode } from '../parse/parseObject.ts';
import type { SaveWarning } from './saveWarning.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ByteWriter } from '../bytes/byteWriter.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { mm } from '../length/length.ts';
import { cloneDirect, cloneObject } from '../object/cloneObject.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { PdfDictionaryEntries, pdfArray, pdfInteger, pdfLiteralString, pdfName, pdfReal, pdfReference } from '../object/pdfObject.ts';
import { Lexer } from '../parse/lexer.ts';
import { parseAnnotated } from '../parse/parseObject.ts';
import { buildPdf, latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

import { changedObjectBytes, mergeSerialize } from './mergeSerialize.ts';

interface Parsed {
  node: SourceNode;
  bytes: Uint8Array;
}

const ignore = (): void => {
  // Warnings are not under test here.
};

const parse = (text: string): Parsed => {
  const bytes = latin1Bytes(text);
  return { node: parseAnnotated(new Lexer({ bytes, base: 0, final: true }, 0, { warn: ignore, names: new Map() }), 256), bytes };
};

interface Merged {
  text: string;
  warnings: Array<SaveWarning>;
}

const merge = (value: PdfObject, original?: Parsed): Merged => {
  const writer = new ByteWriter();
  const warnings: Array<SaveWarning> = [];
  const warn = (warning: SaveWarning): void => {
    warnings.push(warning);
  };
  mergeSerialize(writer, value, { original: original?.node, bytes: original?.bytes ?? new Uint8Array(), fractionDigits: 5, warn });
  return { text: latin1Text(writer.toUint8Array()), warnings };
};

const box = (values: ReadonlyArray<Length | number>): PdfDirectObject =>
  pdfArray(values.map(value => (typeof value === 'number' ? pdfInteger(value) : pdfReal(value))));

const entriesOf = (parsed: Parsed): PdfDictionaryEntries => {
  const copy = cloneObject(parsed.node.value);
  return copy.kind === 'dictionary' ? copy.entries : new PdfDictionaryEntries();
};

const edited = (parsed: Parsed, edit: (entries: Extract<PdfDirectObject, { kind: 'dictionary' }>['entries']) => void): PdfObject => {
  const copy = cloneObject(parsed.node.value);
  if (copy.kind === 'dictionary') {
    edit(copy.entries);
  }
  return copy;
};

// The shape of an Illustrator page dictionary: a direct PieceInfo, six-digit reals, a real written as 792.0 and a key spelled with an escape.
const page =
  "<< /Type /Page /ArtBox [0.242187 2.38184 611.611 792.0]  /PieceInfo<</Illustrator 21501 0 R>>/LastModified(D:20070624192720-05'00')/Odd#20Key 1 /MediaBox [ 0 0 612 792 ] >>";

// The catalog and page tree of a file whose object 3 a test changes.
const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };

describe('merge serializer', () => {
  it('copies an unchanged value byte for byte', () => {
    const parsed = parse(page);
    expect(merge(cloneObject(parsed.node.value), parsed).text).toBe(page);
  });

  it('keeps the bytes of every unchanged entry when a sibling changes', () => {
    const parsed = parse(page);
    const value = edited(parsed, entries => {
      entries.set(pdfName('TrimBox').bytes, box([mm(5), mm(5), mm(100), mm(100)]));
      entries.set(pdfName('MediaBox').bytes, box([0, 0, 612, 800]));
    });
    expect(merge(value, parsed).text).toBe(
      "<</Type /Page/ArtBox [0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 21501 0 R>>/LastModified(D:20070624192720-05'00')/Odd#20Key 1/MediaBox [ 0 0 612 800 ]/TrimBox[14.17323 14.17323 283.46457 283.46457]>>",
    );
  });

  it('drops removed entries and keeps one occurrence of a duplicate key with a warning', () => {
    const parsed = parse('<</A 1/K (first) /B 2/K (last)>>');
    const value = edited(parsed, entries => {
      entries.delete(pdfName('A').bytes);
      entries.set(pdfName('C').bytes, pdfInteger(3));
    });
    const { text, warnings } = merge(value, parsed);
    expect([text, warnings.map(warning => warning.code)]).toStrictEqual(['<</K (last)/B 2/C 3>>', ['duplicate-key-resolved']]);
  });

  it('copies the spelling of the last occurrence of a duplicate key, whose value the dictionary holds', () => {
    const parsed = parse('<</K 1/B 2/K  2.50>>');
    const value = edited(parsed, entries => {
      entries.set(pdfName('B').bytes, pdfInteger(3));
    });
    expect(merge(value, parsed).text).toBe('<</K  2.50/B 3>>');
  });

  it('gives the bytes a save writes for a new value, with reals rounded to the fraction digits of that save', () => {
    const document = loadDocument(buildPdf([{ xref: 'classic', objects: [catalog, pages, { number: 3, body: '[1.5 /X]' }], trailer: '/Root 1 0 R' }]).bytes);
    const value = pdfArray([pdfReal(0.123456), pdfName('X')]);
    document.set(pdfReference(3, 0), value);
    const store = internalsOf(document)?.objects.store;
    if (store === undefined) {
      throw new Error('missing document internals');
    }
    const bytes = latin1Text(changedObjectBytes(3, value, { store, maxNesting: 256, fractionDigits: 2 }));
    expect([bytes, latin1Text(document.save({ mode: 'full', fractionDigits: 2 }).toBytes()).includes(`\n3 0 obj\n${bytes}\nendobj\n`)]).toStrictEqual([
      '[0.12 /X]',
      true,
    ]);
  });

  it('keeps a changed value that begins with a regular character apart from the token before it', () => {
    const parsed = parse('<</Foo/Bar/Arr[/A/B]/List[(a)7]>>');
    const value = edited(parsed, entries => {
      entries.set(pdfName('Foo').bytes, pdfInteger(5));
      entries.set(pdfName('Arr').bytes, pdfArray([pdfName('A'), pdfInteger(7)]));
      entries.set(pdfName('List').bytes, pdfArray([pdfInteger(5), pdfInteger(7)]));
    });
    expect(merge(value, parsed).text).toBe('<</Foo 5/Arr[/A 7]/List[5 7]>>');
  });

  it('serializes values without an original with the plain serializer', () => {
    const fresh = pdfArray([pdfReal(0.1234567), pdfName('X')]);
    const longer = pdfArray([pdfInteger(1), pdfReal(2.5), pdfInteger(4), pdfInteger(5)]);
    const parsed = parse('[1 2.50 3]');
    expect(merge(fresh).text).toBe('[0.12346 /X]');
    expect(merge(longer, parsed).text).toBe('[1 2.50 4 5]');
    expect(merge(pdfName('Other'), parsed).text).toBe('/Other');
  });

  it.each([
    ['shrinks to one item', '[1 2 3 ]', pdfArray([pdfInteger(1)]), '[1]'],
    ['shrinks to no items', '[ 1 2 3 ]', pdfArray([]), '[]'],
    ['grows by one item', '[1  2 3 ]', pdfArray([pdfInteger(1), pdfInteger(2), pdfInteger(3), pdfInteger(4)]), '[1  2 3 4]'],
    ['changes its last item', '[1  2 3 ]', pdfArray([pdfInteger(1), pdfInteger(2), pdfInteger(9)]), '[1  2 9 ]'],
  ])('writes an array that %s, copying the gaps between the items it keeps', (_, original, value, expected) => {
    expect(merge(value, parse(original)).text).toBe(expected);
  });

  it('keeps the bytes of the siblings of a dictionary changed inside an array', () => {
    const parsed = parse('[<</A 1 /B  2.50>> (x)  /N]');
    const copy = cloneObject(parsed.node.value);
    const [first] = copy.kind === 'array' ? copy.items : [];
    if (first?.kind !== 'dictionary') {
      throw new Error('missing nested dictionary');
    }
    first.entries.set(pdfName('A').bytes, pdfInteger(5));
    expect(merge(copy, parsed).text).toBe('[<</A 5/B  2.50>> (x)  /N]');
  });

  // ISO 32000-1:2008, 7.2.2: a name begins with the delimiter /, so it needs no white space after a copied regular character.
  it('writes a changed value that begins with a delimiter directly after the key', () => {
    const parsed = parse('<</Foo/Bar/Num 1>>');
    const value = edited(parsed, entries => {
      entries.set(pdfName('Foo').bytes, pdfName('Baz'));
      entries.set(pdfName('Num').bytes, pdfLiteralString('s'));
    });
    expect(merge(value, parsed).text).toBe('<</Foo/Baz/Num (s)>>');
  });

  it('writes a stream with its Length set to the data length and keeps the other dictionary bytes', () => {
    const dictionary = parse('<< /Filter /FlateDecode /Length 9 0 R /DecodeParms <</Columns 4>> >>');
    const indirect = { kind: 'stream', dictionary: entriesOf(dictionary), data: latin1Bytes('abc') } as const;
    expect(merge(indirect, dictionary).text).toBe('<</Filter /FlateDecode/Length 3/DecodeParms <</Columns 4>>>>\nstream\nabc\nendstream');
    const same = parse('<</Length 3>>');
    expect(merge({ kind: 'stream', dictionary: entriesOf(same), data: latin1Bytes('abc') }, same).text).toBe('<</Length 3>>\nstream\nabc\nendstream');
  });
});

// A value with the text that spells it: irregular white space, reals with trailing zeros, and only characters that need no escape.
interface Spelled {
  readonly value: PdfDirectObject;
  readonly text: string;
}

const gap = fc.constantFrom(' ', '  ', '\n', ' \r\n ');
const leadingGap = fc.constantFrom('', ' ', '\n');
const keys = fc.constantFrom('A', 'B', 'Cc', 'Type');

const leaf: fc.Arbitrary<Spelled> = fc.oneof(
  fc.integer({ min: -999, max: 999 }).map(value => ({ value: pdfInteger(value), text: String(value) })),
  // Quarters print exactly in five fraction digits, so a rewritten real reads back as the same number; a whole number would be written as an integer.
  fc
    .integer({ min: -400, max: 400 })
    .filter(quarters => quarters % 4 !== 0)
    .map(quarters => ({ value: pdfReal(quarters / 4), text: (quarters / 4).toFixed(2) })),
  keys.map(name => ({ value: pdfName(name), text: `/${name}` })),
  fc
    .array(fc.constantFrom('a', 'b', ' '), { maxLength: 5 })
    .map(characters => ({ value: pdfLiteralString(characters.join('')), text: `(${characters.join('')})` })),
  fc.boolean().map(value => ({ value: { kind: 'boolean', value }, text: String(value) }) as const),
  fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: 0, max: 3 })).map(([objectNumber, generation]) => ({
    value: pdfReference(objectNumber, generation),
    text: `${String(objectNumber)} ${String(generation)} R`,
  })),
);

const { spelled } = fc.letrec<{ spelled: Spelled; array: Spelled; dictionary: Spelled }>(tie => ({
  spelled: fc.oneof({ depthSize: 'small' }, leaf, tie('array'), tie('dictionary')),
  array: fc.tuple(leadingGap, fc.array(fc.tuple(tie('spelled'), gap), { maxLength: 4 })).map(([lead, items]) => ({
    value: pdfArray(items.map(([item]) => item.value)),
    text: `[${lead}${items.map(([item, after]) => `${item.text}${after}`).join('')}]`,
  })),
  dictionary: fc
    .tuple(leadingGap, fc.uniqueArray(fc.tuple(keys, gap, tie('spelled'), leadingGap), { selector: ([key]) => key, maxLength: 4 }))
    .map(([lead, entries]) => ({
      value: { kind: 'dictionary', entries: new PdfDictionaryEntries(entries.map(([key, , value]) => [pdfName(key).bytes, value.value])) } as const,
      text: `<<${lead}${entries.map(([key, between, value, after]) => `/${key}${between}${value.text}${after}`).join('')}>>`,
    })),
}));

interface Edit {
  readonly path: ReadonlyArray<number>;
  readonly operation: 'replace' | 'delete' | 'insert';
  readonly value: PdfDirectObject;
}

const edits = fc.array(
  fc.record({
    path: fc.array(fc.nat(), { maxLength: 4 }),
    operation: fc.constantFrom('replace', 'delete', 'insert'),
    value: spelled.map(({ value }) => value),
  }),
  { maxLength: 3 },
);

// Follows the path through arrays and dictionaries, then replaces the value there, deletes the child the last step names, or inserts into a container.
const applyEdit = (value: PdfDirectObject, edit: Edit): PdfDirectObject => {
  const count = value.kind === 'array' ? value.items.length : value.kind === 'dictionary' ? value.entries.size : 0;
  const [step = 0, ...rest] = edit.path;
  if (count === 0 || edit.path.length === 0) {
    if (edit.operation === 'insert' && value.kind === 'array') {
      return pdfArray([...value.items, edit.value]);
    }
    if (edit.operation === 'insert' && value.kind === 'dictionary') {
      return { kind: 'dictionary', entries: new PdfDictionaryEntries([...value.entries.entries(), [pdfName('New').bytes, edit.value]]) };
    }
    return edit.value;
  }
  const position = step % count;
  const edited = (child: PdfDirectObject): Array<PdfDirectObject> =>
    edit.operation === 'delete' && rest.length === 0 ? [] : [applyEdit(child, { ...edit, path: rest })];
  if (value.kind === 'array') {
    return pdfArray(value.items.flatMap((item, index) => (index === position ? edited(item) : [item])));
  }
  if (value.kind === 'dictionary') {
    const entries = [...value.entries.entries()].flatMap(([name, item], index) =>
      index === position ? edited(item).map(child => [name, child] as const) : [[name, item] as const],
    );
    return { kind: 'dictionary', entries: new PdfDictionaryEntries(entries) };
  }
  return value;
};

describe('properties', () => {
  it('copies an unchanged value byte for byte, and writes an edited one so that it parses back to the edited value', () => {
    fc.assert(
      fc.property(spelled, edits, (original, changes) => {
        const parsed = parse(original.text);
        const value = changes.reduce((current, change) => applyEdit(current, change), cloneDirect(parsed.node.value));
        const output = merge(value, parsed).text;
        expect([deepEqual(parsed.node.value, original.value, 'strict'), merge(cloneObject(parsed.node.value), parsed).text]).toStrictEqual([
          true,
          original.text,
        ]);
        expect({ output, equal: deepEqual(parse(output).node.value, value, 'strict') }).toStrictEqual({ output, equal: true });
      }),
    );
  });

  it('gives the bytes each save mode writes for a changed object', () => {
    fc.assert(
      fc.property(spelled, edits, fc.constantFrom('incremental', 'full'), (original, changes, mode) => {
        const source = buildPdf([{ xref: 'classic', objects: [catalog, pages, { number: 3, body: original.text }], trailer: '/Root 1 0 R' }]);
        const document = loadDocument(source.bytes);
        const value = changes.reduce((current, change) => applyEdit(current, change), cloneDirect(parse(original.text).node.value));
        document.set(pdfReference(3, 0), value);
        const store = internalsOf(document)?.objects.store;
        if (store === undefined) {
          throw new Error('missing document internals');
        }
        const bytes = latin1Text(changedObjectBytes(3, value, { store, maxNesting: 256, fractionDigits: 5 }));
        const output = latin1Text(document.save({ mode }).toBytes());
        // The source ends in an end-of-line, which is the one before the appended object.
        const written = mode === 'incremental' ? output.slice(source.bytes.length - 1) : output;
        expect(written).toContain(`\n3 0 obj\n${bytes}\nendobj\n`);
      }),
    );
  });
});
