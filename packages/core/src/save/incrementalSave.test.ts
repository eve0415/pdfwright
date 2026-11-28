import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { TestPdf, TestSection } from '../testing/pdfBuilder.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { pt } from '../length/length.ts';
import { deepEqual } from '../object/deepEqual.ts';
import { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import { pdfArray, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const illustratorPage =
  "<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')/MediaBox[0 0 612 792]/Resources<<>>>>";

const basePdfObjects = [
  { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
  { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
  { number: 3, body: illustratorPage },
  { number: 4, body: '(delete me)' },
  { number: 5, body: '<</Producer(test)>>' },
] as const;

const basePdf = (extra: Partial<TestSection> = {}): TestPdf =>
  buildPdf([
    {
      xref: 'classic',
      objects: basePdfObjects,
      trailer: `/Root 1 0 R/Info 5 0 R/ID[<${'11'.repeat(16)}><${'22'.repeat(16)}>]/Private(kept)`,
      ...extra,
    },
  ]);

const base = (extra: Partial<TestSection> = {}): Uint8Array => basePdf(extra).bytes;

// A file whose first object is a linearization dictionary (ISO 32000-1:2008, Annex F).
const linearized = (): Uint8Array =>
  base({
    objects: [{ number: 9, body: '<</Linearized 1/L 999/H[0 20]>>' }, ...basePdfObjects.slice(0, 3)],
    trailer: '/Root 1 0 R',
  });

const trimBox = (document: LoadedDocument): void => {
  document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
};

const keyNames = (entries: PdfDictionaryEntries): ReadonlyArray<string> => [...entries.entries()].map(([key]) => latin1Text(key));

const editedBytes = (): Uint8Array => {
  const document = loadDocument(base());
  document.set(pdfReference(5, 0), { kind: 'dictionary', entries: document.catalog() });
  return document.save().toBytes();
};

const lastTrailer = (bytes: Uint8Array): string => latin1Text(bytes).split('trailer').at(-1) ?? '';

// The file identifier pair of a saved file as lowercase hex, or undefined when its trailer has none.
const identifierOf = (bytes: Uint8Array): ReadonlyArray<string> | undefined => {
  const id = loadDocument(bytes).structure.trailer.get(pdfName('ID').bytes);
  return id?.kind === 'array' ? id.items.map(item => (item.kind === 'string' ? hex(item.bytes) : '')) : undefined;
};

const producedObject = (value: PdfObject): Extract<PdfObject, { kind: 'stream' }> => {
  if (value.kind !== 'stream') {
    throw new Error('missing produced stream');
  }
  return value;
};

const addProduced = (document: LoadedDocument): void => {
  const edited = internalsOf(document)?.objects;
  if (edited === undefined) {
    throw new Error('missing document internals');
  }
  edited.setProduced(pdfReference(5, 0), new PdfDictionaryEntries([[pdfName('Type').bytes, pdfName('Example')]]), function* () {
    yield latin1Bytes('first');
    yield latin1Bytes('second');
  });
};

describe('incremental save', () => {
  it('returns the source unchanged when nothing changed', () => {
    const source = base();
    const saved = loadDocument(source).save({ mode: 'incremental' });
    expect([saved.mode, saved.chunks.length, saved.chunks[0] === source]).toStrictEqual(['incremental', 1, true]);
  });

  it('writes an update carrying a supplied file identifier even without changes', () => {
    const source = base();
    const pair: [Uint8Array, Uint8Array] = [new Uint8Array(16).fill(0xaa), new Uint8Array(16).fill(0xbb)];
    const saved = loadDocument(source).save({ mode: 'incremental', fileIdentifier: pair });
    const appended = latin1Text(saved.toBytes().subarray(source.length));
    expect(appended).toMatch(/^xref\n0 0\ntrailer\n<<.*\/ID\[<A{32}><B{32}>\]>>/u);
    expect(loadDocument(saved.chunks).structure.sections).toHaveLength(2);
  });

  it('appends changed objects, a classic section and a trailer that copies the previous one', () => {
    const source = base();
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    const saved = document.save();
    const text = latin1Text(saved.toBytes());
    const appended = text.slice(source.length);
    expect([saved.mode, saved.chunks[0] === source, text.startsWith(latin1Text(source))]).toStrictEqual(['incremental', true, true]);
    expect(appended).toContain(
      "3 0 obj\n<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')",
    );
    expect(appended).toMatch(
      /\nxref\n3 1\n\d{10} 00000 n \ntrailer\n<<\/Size 6\/Root 1 0 R\/Info 5 0 R\/Private\(kept\)\/Prev \d+\/ID\[<1{32}><[0-9A-F]{32}>\]>>\nstartxref\n\d+\n%%EOF\n$/u,
    );
    const reloaded = loadDocument(saved.chunks);
    expect([reloaded.structure.status, reloaded.structure.sections.length, reloaded.page(0).boxes().TrimBox.rect]).toStrictEqual([
      'intact',
      2,
      [10, 10, 600, 780],
    ]);
  });

  // ISO 32000-1:2008, 7.5.4: entry 0 heads the linked list of free entries, and the source's list is 0, 6, back to 0.
  it('links deleted objects into the free list ahead of its previous head and numbers new objects above the old Size', () => {
    const source = base({ free: [{ number: 6, generation: 1 }] });
    const document = loadDocument(source);
    document.delete(pdfReference(4, 0));
    document.delete(pdfReference(5, 0));
    const added = document.object(pdfInteger(7));
    const saved = document.save();
    const appended = latin1Text(saved.toBytes().subarray(source.length));
    expect(appended).toMatch(/\nxref\n0 1\n0000000004 65535 f \n4 2\n0000000005 00001 f \n0000000006 00001 f \n7 1\n\d{10} 00000 n \ntrailer\n/u);
    const reloaded = loadDocument(saved.chunks);
    expect([added, reloaded.get(pdfReference(4, 0)), reloaded.get(pdfReference(5, 0)), reloaded.get(added), reloaded.structure.status]).toStrictEqual([
      pdfReference(7, 0),
      { kind: 'null' },
      { kind: 'null' },
      pdfInteger(7),
      'intact',
    ]);
  });

  it('writes identical bytes for identical edits, keeps the first file identifier and derives the second from the update', () => {
    expect(editedBytes()).toStrictEqual(editedBytes());
    const edited = identifierOf(editedBytes());
    const otherDocument = loadDocument(base());
    otherDocument.set(pdfReference(4, 0), pdfInteger(4));
    const other = identifierOf(otherDocument.save().toBytes());
    // ISO 32000-1:2008, 14.4: the first identifier does not change in an incremental update, and the second changes with the contents.
    expect([edited?.[0], other?.[0]]).toStrictEqual(['11'.repeat(16), '11'.repeat(16)]);
    expect(new Set([edited?.[1], other?.[1], '22'.repeat(16)]).size).toBe(3);
    expect([edited?.[1], other?.[1]]).toStrictEqual([expect.stringMatching(/^[0-9a-f]{32}$/u), expect.stringMatching(/^[0-9a-f]{32}$/u)]);
  });

  it('keeps XRefStm out of an update to a hybrid file and refuses to update a reconstructed file', () => {
    const hybrid = buildPdf([
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
        ],
        trailer: '/Root 1 0 R',
      },
      { xref: 'hybrid', objects: [], objectStreams: [{ number: 4, members: [{ number: 3, body: '(hidden)' }] }], trailer: '/Root 1 0 R' },
    ]);
    const document = loadDocument(hybrid.bytes);
    document.set(pdfReference(3, 0), pdfName('Changed'));
    const saved = document.save();
    const trailer = lastTrailer(saved.toBytes());
    expect([trailer.includes('XRefStm'), loadDocument(saved.chunks).get(pdfReference(3, 0))]).toStrictEqual([false, pdfName('Changed')]);
    const damaged = latin1Text(base()).replace(/startxref\n\d+/u, 'startxref\n3');
    const broken = loadDocument(latin1Bytes(damaged));
    expect(() => broken.save({ mode: 'incremental' })).toThrow(InvalidArgumentError);
  });

  it('appends a cross-reference stream after a cross-reference stream, keeping the PieceInfo bytes of a compressed page', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 9, body: '(private data)' },
        ],
        objectStreams: [
          {
            number: 6,
            members: [
              { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
              { number: 3, body: illustratorPage },
              { number: 4, body: '(gone)' },
            ],
          },
        ],
        trailer: `/Root 1 0 R/ID[<${'33'.repeat(16)}><${'44'.repeat(16)}>]/Private(kept)`,
      },
    ]).bytes;
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    document.delete(pdfReference(4, 0));
    const saved = document.save();
    const appended = latin1Text(saved.toBytes().subarray(source.length));
    expect(appended).toContain(
      "3 0 obj\n<</Type/Page/Parent 2 0 R/ArtBox[0.242187 2.38184 611.611 792.0]/PieceInfo<</Illustrator 9 0 R>>/LastModified(D:20070624192720-05'00')",
    );
    expect(appended).toMatch(
      /\n11 0 obj\n<<\/Type\/XRef\/Size 12\/Root 1 0 R\/Private\(kept\)\/Prev \d+\/Index\[0 1 3 2 11 1\]\/W\[1 2 2\]\/ID\[<3{32}><[0-9A-F]{32}>\]\/Length 20>>\nstream\n/u,
    );
    const reloaded = loadDocument(saved.chunks);
    expect([reloaded.structure.sections.map(section => section.kind), reloaded.page(0).boxes().TrimBox.rect, reloaded.get(pdfReference(4, 0))]).toStrictEqual([
      ['stream', 'stream'],
      [10, 10, 600, 780],
      { kind: 'null' },
    ]);
  });

  it.each(['classic', 'stream'] as const)('streams a produced object through a %s update', async xref => {
    const source = base({ xref });
    const document = loadDocument(source);
    addProduced(document);
    const saved = document.save({ mode: 'incremental' });
    const parts: Array<Uint8Array> = [];
    for await (const part of saved.toStream()) {
      parts.push(part);
    }
    const updated = loadDocument(parts);
    const value = producedObject(updated.get(pdfReference(5, 0)));
    // A wrong Length would be recovered from endstream with a warning, so a clean reload is what shows the Length object is right.
    expect([updated.warnings, updated.structure.status]).toStrictEqual([[], 'intact']);
    expect(latin1Text(value.data)).toBe('firstsecond');
    expect(value.dictionary.get(pdfName('Length').bytes)?.kind).toBe('reference');
    expect(updated.structure.sections.map(section => section.kind)).toStrictEqual([xref, xref]);
    expect(updated.structure.trailer.get(pdfName('Prev').bytes)?.kind).toBe('integer');
    expect(updated.structure.trailer.get(pdfName('Private').bytes)?.kind).toBe('string');
  });

  it('writes trailer changes into the added trailer, even with no object changed', () => {
    const document = loadDocument(base());
    const edited = internalsOf(document)?.objects;
    edited?.setTrailerEntry(pdfName('Info').bytes, pdfReference(4, 0));
    edited?.setTrailerEntry(pdfName('Private').bytes, undefined);
    const saved = document.save({ mode: 'incremental' });
    expect(lastTrailer(saved.toBytes())).toMatch(/^\n<<\/Size 6\/Root 1 0 R\/Info 4 0 R\/Prev \d+\/ID\[<1{32}><[0-9A-F]{32}>\]>>/u);
  });

  // ISO 32000-1:2008, 7.5.8.2, Table 17: Filter and DecodeParms describe the stream they belong to; the appended stream is written unfiltered.
  it('leaves the filter of a filtered base cross-reference stream out of the appended one', () => {
    const document = loadDocument(base({ xref: 'stream', xrefStreamEncoding: 'flate-up' }));
    trimBox(document);
    const reloaded = loadDocument(document.save({ mode: 'incremental' }).chunks);
    expect([
      keyNames(reloaded.structure.trailer),
      reloaded.structure.status,
      reloaded.warnings,
      reloaded.structure.sections.map(section => section.kind),
      reloaded.page(0).boxes().TrimBox.rect,
    ]).toStrictEqual([
      ['Type', 'Size', 'Root', 'Info', 'Private', 'Prev', 'Index', 'W', 'ID', 'Length'],
      'intact',
      [],
      ['stream', 'stream'],
      [10, 10, 600, 780],
    ]);
  });

  // Offsets of a file with bytes before its header are read relative to the header, so the update writes its own offsets the same way.
  // The update's cross-reference stream is numbered 7, one above the base's own stream 6. A reload that kept the base's reading shows every new offset is header-relative too.
  it.each([
    ['classic', '\nxref\n'],
    ['stream', '\n7 0 obj\n'],
  ] as const)('writes header-relative offsets in a %s update to a file with bytes before its header', (xref, sectionStart) => {
    const pdf = basePdf({ xref });
    const document = loadDocument(latin1Bytes(`JUNK${pdf.text}`));
    trimBox(document);
    const output = latin1Text(document.save({ mode: 'incremental' }).toBytes());
    const sectionOffset = output.lastIndexOf(sectionStart) + 1 - 4;
    const reloaded = loadDocument(latin1Bytes(output));
    expect([
      output.endsWith(`\nstartxref\n${String(sectionOffset)}\n%%EOF\n`),
      reloaded.structure.trailer.get(pdfName('Prev').bytes),
      reloaded.structure.status,
      reloaded.warnings,
      reloaded.page(0).boxes().TrimBox.rect,
    ]).toStrictEqual([true, pdfInteger(pdf.sections[0] ?? 0), document.structure.status, document.warnings, [10, 10, 600, 780]]);
  });

  // ISO 32000-1:2008, 7.5.8.3: the cross-reference stream's entry for itself is read like any other.
  it('writes the header-relative offset of a cross-reference stream update into its own entry', () => {
    const document = loadDocument(latin1Bytes(`JUNK${basePdf({ xref: 'stream' }).text}`));
    trimBox(document);
    const reloaded = loadDocument(document.save({ mode: 'incremental' }).chunks);
    const updateStream = reloaded.get(pdfReference(7, 0));
    expect([updateStream.kind === 'stream' ? keyNames(updateStream.dictionary) : updateStream.kind, reloaded.warnings]).toStrictEqual([
      ['Type', 'Size', 'Root', 'Info', 'Private', 'Prev', 'Index', 'W', 'ID', 'Length'],
      document.warnings,
    ]);
  });

  it('writes the header-relative offset of a changed object into a classic update', () => {
    const document = loadDocument(latin1Bytes(`JUNK${basePdf().text}`));
    trimBox(document);
    const output = latin1Text(document.save({ mode: 'incremental' }).toBytes());
    const objectOffset = output.lastIndexOf('\n3 0 obj\n') + 1 - 4;
    expect([document.structure.headerOffset, output]).toStrictEqual([
      4,
      expect.stringContaining(`\nxref\n3 1\n${String(objectOffset).padStart(10, '0')} 00000 n \ntrailer\n`),
    ]);
  });

  it.each([
    ['%%EOF without an end-of-line', '', '\n'],
    ['%%EOF and a carriage return', '\r', ''],
    ['%%EOF and a line feed', '\n', ''],
  ])('appends after %s with an end-of-line only where one is missing', (_, ending, inserted) => {
    const source = latin1Bytes(`${basePdf().text.slice(0, -1)}${ending}`);
    const document = loadDocument(source);
    trimBox(document);
    const output = latin1Text(document.save({ mode: 'incremental' }).toBytes());
    const reloaded = loadDocument(latin1Bytes(output));
    expect([
      output.slice(source.length).startsWith(`${inserted}3 0 obj\n`),
      reloaded.structure.status,
      reloaded.warnings,
      reloaded.page(0).boxes().TrimBox.rect,
    ]).toStrictEqual([true, 'intact', [], [10, 10, 600, 780]]);
  });

  // ISO 32000-1:2008, Annex F, Table F.1: an update makes a linearized file an ordinary one.
  it('warns that an edit invalidates linearization, and returns an unedited linearized file as it is', () => {
    const source = linearized();
    const unedited = loadDocument(source).save({ mode: 'incremental' });
    const document = loadDocument(linearized());
    trimBox(document);
    expect([
      document.structure.linearized,
      unedited.chunks[0] === source,
      unedited.warnings,
      document.save({ mode: 'incremental' }).warnings.map(warning => warning.code),
    ]).toStrictEqual([true, true, [], ['linearization-invalidated']]);
  });

  // ISO 32000-1:2008, 7.5.4: a generation that reaches 65,535 is not incremented, and the number is never reused.
  it('keeps generation 65,535 when deleting an object that has it', () => {
    const document = loadDocument(base({ objects: [...basePdfObjects, { number: 6, generation: 65_535, body: '(last use)' }] }));
    document.delete(pdfReference(6, 65_535));
    const output = latin1Text(document.save({ mode: 'incremental' }).toBytes());
    expect(output).toMatch(/\nxref\n0 1\n0000000006 65535 f \n6 1\n0000000000 65535 f \ntrailer\n/u);
  });

  // ISO 32000-1:2008, 7.5.6: the added trailer carries the previous one's entries, so a Size above what the update needs stays.
  it('keeps a previous Size above the highest object number', () => {
    const text = basePdf().text.replace('<</Size 6/Root', '<</Size 60/Root');
    const document = loadDocument(latin1Bytes(text));
    trimBox(document);
    expect(lastTrailer(document.save({ mode: 'incremental' }).toBytes())).toMatch(/^\n<<\/Size 60\/Root/u);
  });

  // ISO 32000-1:2008, 14.4: a source without ID gets none unless the caller supplies one, and a supplied pair is written as given.
  it.each([
    ['derived for a source without ID', 'derive', undefined],
    ['supplied for a source without ID', [new Uint8Array(16).fill(0xaa), new Uint8Array(16).fill(0xbb)], ['aa'.repeat(16), 'bb'.repeat(16)]],
  ] as const)('writes the file identifier %s with an edit', (_, fileIdentifier, expected) => {
    const document = loadDocument(base({ trailer: '/Root 1 0 R' }));
    trimBox(document);
    const saved = document.save({ mode: 'incremental', fileIdentifier: fileIdentifier === 'derive' ? 'derive' : [...fileIdentifier] });
    expect([identifierOf(saved.toBytes()), lastTrailer(saved.toBytes()).includes('/ID')]).toStrictEqual([expected, expected !== undefined]);
  });
});

// Sources in each cross-reference format, objects 4 to 8 being free to edit: top-level, in an object stream, and behind a hybrid section.
const editable = [4, 5, 6, 7, 8] as const;
const plain = (numbers: ReadonlyArray<number>): Array<{ number: number; body: string }> =>
  numbers.map(number => ({ number, body: `(object ${String(number)})` }));
const structure = [
  { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
  { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' },
];
const roundTripSources: ReadonlyArray<ReadonlyArray<TestSection>> = [
  [{ xref: 'classic', objects: [...structure, ...plain(editable)], trailer: '/Root 1 0 R' }],
  [{ xref: 'stream', objects: [...structure, ...plain(editable)], trailer: '/Root 1 0 R', xrefStreamEncoding: 'flate' }],
  [{ xref: 'stream', objects: [...structure, ...plain([7, 8])], objectStreams: [{ number: 9, members: plain([4, 5, 6]) }], trailer: '/Root 1 0 R' }],
  [
    { xref: 'classic', objects: [...structure, ...plain([4, 5, 6])], trailer: '/Root 1 0 R' },
    { xref: 'hybrid', objects: [], objectStreams: [{ number: 10, members: plain([7, 8]) }], trailer: '/Root 1 0 R' },
  ],
];

const values = fc.oneof(
  fc.integer({ min: -9999, max: 9999 }).map(value => pdfInteger(value)),
  fc.constantFrom('A', 'Changed').map(name => pdfName(name)),
  fc
    .array(
      fc.integer({ min: 0, max: 99 }).map(value => pdfInteger(value)),
      { maxLength: 4 },
    )
    .map(items => pdfArray(items)),
);

const objectEdits = fc.array(fc.record({ operation: fc.constantFrom('set', 'delete', 'add'), target: fc.constantFrom(...editable), value: values }), {
  maxLength: 6,
});

describe('properties', () => {
  it('appends any set of edits so that the source bytes stay and a reload reads every edited value', () => {
    fc.assert(
      fc.property(fc.constantFrom(...roundTripSources), objectEdits, (sections, changes) => {
        const pdf = buildPdf(sections);
        const source = pdf.bytes;
        const document = loadDocument(source);
        const live = new Set<number>(editable);
        let highest = pdf.size;
        for (const change of changes) {
          if (change.operation === 'add') {
            highest = Math.max(highest, document.object(change.value).objectNumber + 1);
          } else if (live.has(change.target) && change.operation === 'set') {
            document.set(pdfReference(change.target, 0), change.value);
          } else if (live.has(change.target)) {
            document.delete(pdfReference(change.target, 0));
            live.delete(change.target);
          }
        }
        const saved = document.save({ mode: 'incremental' });
        const reloaded = loadDocument(saved.chunks);
        const numbers = Array.from({ length: highest - 1 }, (_, index) => index + 1);
        expect([
          saved.toBytes().subarray(0, source.length),
          reloaded.structure.status,
          reloaded.warnings,
          numbers.filter(number => !deepEqual(reloaded.get(pdfReference(number, 0)), document.get(pdfReference(number, 0)), 'strict')),
        ]).toStrictEqual([source, 'intact', [], []]);
      }),
    );
  });
});
