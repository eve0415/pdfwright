import type { TestSection } from '../testing/pdfBuilder.ts';
import type { LoadOptions, LoadedDocument, SaveOptions } from './loadDocument.ts';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareDocuments } from '../compare/compareDocuments.ts';
import { EncryptedDocumentError } from '../error/encryptedDocumentError.ts';
import { GenerationMismatchError } from '../error/generationMismatchError.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { PdfDictionaryEntries, pdfArray, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { internalsOf } from './documentInternals.ts';
import { loadDocument } from './loadDocument.ts';

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[]/Count 0>>' };
const base = buildPdf([{ xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' }]);

const load = (text: string, options?: LoadOptions): LoadedDocument => loadDocument(latin1Bytes(text), options);

const edited = (text: string, pattern: RegExp | string, replacement: string): string => text.replace(pattern, replacement);

const entryLine = (offset: number | undefined): string => `${String(offset ?? 0).padStart(10, '0')} 00000 n`;

const withStartxref = (text: string, offset: number): string => text.replace(/startxref\n\d+/u, `startxref\n${String(offset)}`);

const shiftStartxref = (text: string, delta: number): string =>
  text.replace(/startxref\n(\d+)/u, (_, offset: string) => `startxref\n${String(Number(offset) + delta)}`);

const offsetOf = (objectNumber: number): number => base.offsets.get(objectNumber) ?? 0;

const summary = (document: LoadedDocument): Array<string | Array<string>> => [document.structure.status, document.warnings.map(warning => warning.code)];

describe('loading documents', () => {
  it('reads an intact file lazily and returns fresh values', () => {
    const document = loadDocument(base.bytes);
    expect(summary(document)).toStrictEqual(['intact', []]);
    expect(document.structure).toMatchObject({
      headerOffset: 0,
      headerVersion: '1.7',
      lastSectionKind: 'classic',
      linearized: false,
      sections: [{ kind: 'classic', offset: base.sections[0] }],
    });
    const first = document.get(pdfReference(2, 0));
    expect([first, first === document.get(pdfReference(2, 0))]).toStrictEqual([document.get(pdfReference(2, 0)), false]);
    expect([document.catalog().get(pdfName('Pages').bytes), document.get(pdfReference(9, 0))]).toStrictEqual([pdfReference(2, 0), { kind: 'null' }]);
  });

  it('parses an object only when it is read, reporting its warnings then', () => {
    const document = loadDocument(
      buildPdf([{ xref: 'classic', objects: [catalog, pages, { number: 3, body: '<</A 1/A 2>>' }], trailer: '/Root 1 0 R' }]).bytes,
    );
    const before = summary(document);
    document.get(pdfReference(3, 0));
    expect([before, summary(document)]).toStrictEqual([
      ['intact', []],
      ['intact', ['duplicate-key']],
    ]);
  });

  it('reports a generated file cut to 90 percent and names bytes lost by a full save', () => {
    const clean = buildPdf([
      { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' },
      {
        xref: 'classic',
        objects: [{ number: 3, body: `(${'.'.repeat(1000)})` }],
        trailer: '/Root 1 0 R',
      },
    ]);
    const truncated = clean.bytes.slice(0, Math.floor(clean.bytes.length * 0.9));
    const document = loadDocument(truncated);
    const { warnings } = document.save({ mode: 'full' });
    expect([summary(document), warnings.map(warning => warning.code)]).toStrictEqual([['tolerated', ['trailing-data-after-eof']], ['junk-dropped']]);
    expect(warnings[0]?.detail).toContain('after the located %%EOF');
  });

  it('keeps 19-byte entries intact and tolerates entries of other lengths', () => {
    const short = base.text.replaceAll(' \n', '\n');
    const long = base.text.replaceAll(' f \n', ' f \r\n');
    expect(summary(load(short))).toStrictEqual(['intact', ['xref-entry-length']]);
    expect(summary(load(long))).toStrictEqual(['tolerated', ['xref-entry-length']]);
  });

  it('tolerates a startxref a few bytes off, a small trailer Size and header-relative offsets after junk', () => {
    const shifted = shiftStartxref(base.text, -3);
    const small = edited(base.text, '/Size 3', '/Size 2');
    expect(summary(load(shifted))).toStrictEqual(['tolerated', ['startxref-corrected']]);
    expect(summary(load(small))).toStrictEqual(['tolerated', ['trailer-size-too-small']]);
    const junk = load(`JUNK${base.text}`);
    expect([summary(junk), junk.structure.headerOffset, junk.catalog().size]).toStrictEqual([['tolerated', ['junk-before-header']], 4, 2]);
  });

  it('reads absolute offsets after leading bytes when header-relative ones do not describe the file', () => {
    const absolute = buildPdf([{ xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' }], { prefix: 'JUNKJUNKJUNKJUN' });
    const document = loadDocument(absolute.bytes);
    expect(summary(document)).toStrictEqual(['tolerated', ['junk-before-header']]);
  });

  it('keeps a generation mismatch on Root an error and ignores a damaged first object', () => {
    expect(() => load(base.text.replace('/Root 1 0 R', '/Root 1 1 R'))).toThrow(GenerationMismatchError);
    const damaged = buildPdf([{ xref: 'classic', objects: [{ number: 9, body: '<</X <zz>>>' }, catalog, pages], trailer: '/Root 1 0 R' }]);
    expect(summary(loadDocument(damaged.bytes))).toStrictEqual(['intact', []]);
  });

  it.each(['/Filter 4 0 R', '/Filter[4 0 R]', '/DecodeParms 4 0 R', '/DecodeParms[4 0 R]'])(
    'rejects an object stream whose %s refers to its own member',
    dictionary => {
      const pdf = buildPdf([
        {
          xref: 'stream',
          objects: [pages],
          objectStreams: [{ number: 3, members: [catalog, { number: 4, body: 'null' }], dictionary }],
          trailer: '/Root 1 0 R',
        },
      ]);
      expect(() => loadDocument(pdf.bytes)).toThrow(ParseError);
    },
  );

  it.each(['Filter', 'DecodeParms'])('rejects object streams whose %s entries refer to each other’s members', entry => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [pages],
        objectStreams: [
          { number: 3, members: [catalog, { number: 4, body: 'null' }], dictionary: `/${entry} 6 0 R` },
          { number: 5, members: [{ number: 6, body: 'null' }], dictionary: `/${entry} 4 0 R` },
        ],
        trailer: '/Root 1 0 R',
      },
    ]);
    expect(() => loadDocument(pdf.bytes)).toThrow(ParseError);
  });

  it('frees in-use entries at offset 0 and reports mixed chains', () => {
    const zero = buildPdf([{ xref: 'classic', objects: [catalog, pages, { number: 3, body: '(x)' }], trailer: '/Root 1 0 R' }]);
    const text = edited(zero.text, entryLine(zero.offsets.get(3)), entryLine(0));
    const document = load(text);
    expect([summary(document), document.get(pdfReference(3, 0))]).toStrictEqual([['tolerated', ['xref-entry-offset-zero']], { kind: 'null' }]);
    const mixed = buildPdf([
      { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R' },
      { xref: 'stream', objects: [{ number: 3, body: '1' }], trailer: '/Root 1 0 R' },
    ]);
    expect(summary(loadDocument(mixed.bytes))).toStrictEqual(['tolerated', ['mixed-xref-chain']]);
  });

  it('reconstructs files whose cross-reference data does not describe them', () => {
    const offset = offsetOf(2);
    const damaged = [
      edited(base.text, entryLine(offset), entryLine(offset + 1)),
      withStartxref(base.text, 5),
      edited(base.text, 'xref\n0 3', 'xref\n1 3'),
      base.text.slice(0, base.sections[0]),
      base.text.slice(9),
    ];
    for (const text of damaged) {
      const document = load(text);
      expect([document.structure.status, document.warnings.at(-1)?.code, document.catalog().size]).toStrictEqual(['reconstructed', 'xref-reconstructed', 2]);
    }
    expect(() => load('%PDF-1.4\nnothing here\n')).toThrow(new ParseError('not a PDF file: no objects found', 0));
    expect(() => load('%PDF-1.4\n1 0 obj (x) endobj\n')).toThrow(new ParseError('no document catalog found', 0));
  });

  it('refuses ambiguous reconstructions unless the latest copies are accepted', () => {
    const updated = buildPdf([
      { xref: 'classic', objects: [catalog, pages, { number: 3, body: '(old)' }], trailer: '/Root 1 0 R' },
      { xref: 'classic', objects: [{ number: 3, body: '(new)' }], trailer: '/Root 1 0 R' },
    ]);
    const broken = edited(updated.text, /startxref\n\d+\n%%EOF\n$/u, 'startxref\n1\n%%EOF\n');
    expect(() => load(broken)).toThrow(ParseError);
    const latest = load(broken, { recovery: 'latest' });
    expect([latest.structure.status, latest.get(pdfReference(3, 0)), latest.warnings.map(warning => warning.code)]).toStrictEqual([
      'reconstructed',
      { kind: 'string', bytes: latin1Bytes('new'), encoding: 'literal' },
      ['recovery-ambiguous-object', 'xref-reconstructed'],
    ]);
  });

  it.each([
    ['/N 1/First 4/Filter/UnknownDecode', '9 0 null'],
    ['/N 1/First 4/Filter/FlateDecode', 'invalid'],
    ['/First 4', '9 0 null'],
  ])('recovers past an unreadable object stream with dictionary %s', (dictionary, data) => {
    const pdf = buildPdf([
      {
        xref: 'stream',
        objects: [catalog, pages, { number: 3, body: streamBody(`/Type/ObjStm${dictionary}`, data) }],
        objectStreams: [{ number: 4, members: [{ number: 10, body: '(readable)' }] }],
      },
    ]);
    const damaged = pdf.text.slice(0, pdf.sections[0]);
    for (const recovery of ['refuse-ambiguous', 'latest'] as const) {
      const document = load(damaged, { recovery });
      expect([document.structure.status, document.pageCount, document.catalog().size]).toStrictEqual(['reconstructed', 0, 2]);
      expect(document.warnings).toContainEqual(expect.objectContaining({ code: 'recovery-unreadable-object', objectNumber: 3 }));
      expect([document.get(pdfReference(3, 0)), document.get(pdfReference(9, 0)), document.get(pdfReference(10, 0))]).toStrictEqual([
        { kind: 'null' },
        { kind: 'null' },
        { kind: 'string', bytes: latin1Bytes('readable'), encoding: 'literal' },
      ]);
    }
  });

  it('refuses encrypted documents found through the chain or by reconstruction', () => {
    const encrypted = buildPdf([{ xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 0 R/Encrypt<</Filter/Standard>>' }]);
    expect(() => loadDocument(encrypted.bytes)).toThrow(EncryptedDocumentError);
    const broken = withStartxref(encrypted.text, 5);
    expect(() => load(broken)).toThrow(EncryptedDocumentError);
    const packed = buildPdf([
      {
        xref: 'stream',
        objects: [catalog],
        objectStreams: [{ number: 4, members: [pages], dictionary: '/Filter/FlateDecode' }],
        trailer: '/Root 1 0 R/Encrypt<</Filter/Standard>>',
      },
    ]);
    expect(() => load(withStartxref(packed.text, 5))).toThrow(EncryptedDocumentError);
  });

  it('reads segments only from Uint8Arrays, so a Uint16Array holding the same values is not a PDF', () => {
    // @ts-expect-error A Uint16Array is not one of the byte inputs loadDocument accepts.
    expect(() => loadDocument(Uint16Array.from(base.bytes))).toThrow(new ParseError('not a PDF file: no objects found', 0));
  });

  // ISO 32000-1:2008, 7.3.8.2, Table 5: Length counts the stream's data bytes. When it is wrong, the loader finds the data's end at an endstream keyword, here the last one in the file, so the split may fall inside the keyword.
  it('recovers a stream with a wrong Length from input split at any byte as from the contiguous bytes', () => {
    const { bytes } = buildPdf([
      { xref: 'classic', objects: [catalog, pages, { number: 3, body: '<</Length 2>>\nstream\nabcdefgh\nendstream' }], trailer: '/Root 1 0 R' },
    ]);
    const read = (input: Uint8Array | ReadonlyArray<Uint8Array>): Array<unknown> => {
      const document = loadDocument(input);
      return [document.get(pdfReference(3, 0)), document.warnings];
    };
    const contiguous = read(bytes);
    const cuts = Array.from({ length: bytes.length - 1 }, (_, index) => index + 1);
    expect([contiguous[0], cuts.map(cut => read([bytes.subarray(0, cut), bytes.subarray(cut)]))]).toStrictEqual([
      expect.objectContaining({ kind: 'stream', data: latin1Bytes('abcdefgh') }),
      cuts.map(() => contiguous),
    ]);
  });

  // ISO 32000-1:2008, Annex F.2: a linearized file's first object is its linearization dictionary, so the same dictionary later in the file does not make it linearized.
  it('detects linearized files by their first object only', () => {
    const linearization = { number: 3, body: '<</Linearized 1/L 999>>' };
    const first = buildPdf([{ xref: 'classic', objects: [linearization, catalog, pages], trailer: '/Root 1 0 R' }]);
    const later = buildPdf([{ xref: 'classic', objects: [catalog, linearization, pages], trailer: '/Root 1 0 R' }]);
    expect([loadDocument(first.bytes).structure.linearized, loadDocument(later.bytes).structure.linearized]).toStrictEqual([true, false]);
  });
});

describe('loading large cross-reference stream dictionaries', () => {
  const original = {
    xref: 'stream',
    objects: [catalog, pages, { number: 3, body: '(old)' }, ...Array.from({ length: 2400 }, (_, index) => ({ number: 10 + 3 * index, body: 'null' }))],
    trailer: '/Root 1 0 R',
  } as const;
  const update = { objects: [{ number: 3, body: '(new)' }], trailer: '/Root 1 0 R' };

  it.each([
    { target: 'startxref', sections: [original], expected: ['intact', []], value: 'old' },
    { target: 'Prev in a stream section', sections: [original, { ...update, xref: 'stream' }], expected: ['intact', []], value: 'new' },
    {
      target: 'Prev in a classic section',
      sections: [original, { ...update, xref: 'classic' }],
      expected: ['tolerated', ['mixed-xref-chain']],
      value: 'new',
    },
  ] as const)('reads the dictionary through $target', ({ sections, expected, value }) => {
    const pdf = buildPdf(sections);
    const document = loadDocument(pdf.bytes);
    expect(summary(document)).toStrictEqual(expected);
    expect(document.structure.sections.map(section => section.kind)).toStrictEqual(sections.map(section => section.xref).toReversed());
    expect(document.get(pdfReference(3, 0))).toStrictEqual({ kind: 'string', bytes: latin1Bytes(value), encoding: 'literal' });
  });
});

describe('documents that require a full rewrite', () => {
  it('rewrites in auto mode and refuses an incremental save once an edit requires a full rewrite', () => {
    const document = loadDocument(base.bytes);
    internalsOf(document)?.objects.requireFullRewrite('metadata-history');
    expect([document.save().mode, document.save({ mode: 'full' }).mode]).toStrictEqual(['full', 'full']);
    expect(() => document.save({ mode: 'incremental' })).toThrow(expect.objectContaining({ constructor: InvalidArgumentError, reason: 'metadata-history' }));
  });

  it('saves incrementally in auto mode while no edit requires a full rewrite', () => {
    expect(loadDocument(base.bytes).save().mode).toBe('incremental');
  });
});

const pagesEntries = new PdfDictionaryEntries([
  [pdfName('Type').bytes, pdfName('Pages')],
  [pdfName('Kids').bytes, pdfArray([])],
  [pdfName('Count').bytes, pdfInteger(0)],
]);

describe('objects produced when a document is saved', () => {
  it('writes what the save hook sets in the changes, leaving the document and later saves unchanged', () => {
    const document = loadDocument(base.bytes);
    const reference = pdfReference(2, 0);
    internalsOf(document)?.objects.setSaveHook(changes => {
      const entries = new PdfDictionaryEntries([...pagesEntries.entries(), [pdfName('Changes').bytes, pdfInteger(changes.size)]]);
      changes.set(2, { generation: 0, value: { kind: 'dictionary', entries } });
    });
    const first = document.save({ mode: 'full' }).toBytes();
    const second = document.save({ mode: 'full' }).toBytes();
    expect([loadDocument(first).get(reference), document.get(reference), latin1Text(first) === latin1Text(second)]).toStrictEqual([
      { kind: 'dictionary', entries: new PdfDictionaryEntries([...pagesEntries.entries(), [pdfName('Changes').bytes, pdfInteger(0)]]) },
      { kind: 'dictionary', entries: pagesEntries },
      true,
    ]);
  });
});

// 'accepted', or the class of the error the call throws.
const attempt = (call: () => void): string => {
  try {
    call();
  } catch (error: unknown) {
    return error instanceof Error ? error.constructor.name : String(error);
  }
  return 'accepted';
};

const onePageTree = [
  { number: 2, body: '<</Type/Pages/Kids[20 0 R]/Count 1>>' },
  { number: 20, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Resources<<>>>>' },
] as const;

const onePage = buildPdf([{ xref: 'classic', objects: [catalog, ...onePageTree], trailer: '/Root 1 0 R' }]);

// 'loaded or documented' when the load succeeds or throws an error loadDocument documents, or the class of any other error.
const loadOutcome = (bytes: Uint8Array): string => {
  try {
    loadDocument(bytes);
  } catch (error: unknown) {
    if (error instanceof ParseError || error instanceof EncryptedDocumentError || error instanceof ResourceLimitError) {
      return 'loaded or documented';
    }
    return error instanceof Error ? error.constructor.name : String(error);
  }
  return 'loaded or documented';
};

describe('options and arguments', () => {
  it.each(['maxDecodedBytes', 'maxNesting', 'maxObjectStreamMembers', 'parsedObjectCacheBytes', 'maxPageTreeDepth'] as const)(
    'refuses a %s that is not a non-negative safe integer',
    option => {
      expect(
        [-1, 1.5, Number.NaN, 2 ** 53, Number.MAX_SAFE_INTEGER].map(value =>
          attempt(() => {
            loadDocument(base.bytes, { [option]: value });
          }),
        ),
      ).toStrictEqual(['InvalidArgumentError', 'InvalidArgumentError', 'InvalidArgumentError', 'InvalidArgumentError', 'accepted']);
    },
  );

  it.each(['maxTableGapEntries', 'maxGeneratedXrefEntries'] as const)('refuses a negative %s when saving', option => {
    const document = loadDocument(base.bytes);
    const save = (value: number) => (): void => {
      const options: SaveOptions = { mode: 'full', [option]: value };
      document.save(options);
    };
    expect([attempt(save(-1)), attempt(save(0))]).toStrictEqual(['InvalidArgumentError', 'accepted']);
  });

  it('refuses a page index that is not an integer from 0 below the page count', () => {
    const document = loadDocument(onePage.bytes);
    expect(
      [0, 1, 0.5, Number.NaN].map(index =>
        attempt(() => {
          document.page(index);
        }),
      ),
    ).toStrictEqual(['accepted', 'InvalidArgumentError', 'InvalidArgumentError', 'InvalidArgumentError']);
  });
});

describe('save modes', () => {
  it('refuses an incremental save of a reconstructed document', () => {
    const document = load(withStartxref(base.text, 5));
    expect(document.structure.status).toBe('reconstructed');
    expect(() => document.save({ mode: 'incremental' })).toThrow(InvalidArgumentError);
  });

  // The auto mode appends an update only to an intact file, so a tolerated one is rewritten.
  it('rewrites a tolerated document in auto mode', () => {
    const document = load(edited(base.text, '/Size 3', '/Size 2'));
    expect([document.structure.status, document.save().mode]).toStrictEqual(['tolerated', 'full']);
  });

  // ISO 32000-1:2008, 7.5.2: the catalog Version, when later than the header's, is the file's version.
  it('keeps a catalog Version of 1.5 in a PDF 1.3 file that gains transparency', () => {
    const pdf = buildPdf(
      [
        {
          xref: 'classic',
          objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R/Version/1.5>>' }, ...onePageTree],
          trailer: '/Root 1 0 R',
        },
      ],
      { header: '%PDF-1.3' },
    );
    const document = loadDocument(pdf.bytes);
    document.page(0).appendContent(builder => {
      builder.graphicsState({ fillAlpha: 0.5 });
    });
    const saved = document.save();
    expect([saved.warnings, loadDocument(saved.chunks).catalog().get(pdfName('Version').bytes)]).toStrictEqual([[], pdfName('1.5')]);
  });
});

describe('copies handed out', () => {
  it('returns a fresh catalog on every call and refuses a catalog replaced by a non-dictionary', () => {
    const document = loadDocument(base.bytes);
    document.catalog().delete(pdfName('Pages').bytes);
    const kept = document.catalog().get(pdfName('Pages').bytes);
    document.set(pdfReference(1, 0), pdfInteger(1));
    expect([kept, attempt(() => document.catalog())]).toStrictEqual([pdfReference(2, 0), 'ParseError']);
  });

  it('returns a copy of the section list', () => {
    const document = loadDocument(base.bytes);
    const [section] = document.structure.sections;
    Reflect.set(section ?? {}, 'offset', 1);
    expect(document.structure.sections).toStrictEqual([{ kind: 'classic', offset: base.sections[0] }]);
  });
});

describe('generation mismatches', () => {
  // A newer revision with a valid Root would let a reconstruction load the file; the mismatch in the revision the chain reads must still be reported as such.
  it('reports a generation mismatch met through the cross-reference chain rather than reconstructing', () => {
    const revisions = buildPdf([
      { xref: 'classic', objects: [catalog, pages], trailer: '/Root 1 1 R' },
      { xref: 'classic', objects: [{ number: 3, body: '(x)' }], trailer: '/Root 1 0 R' },
    ]);
    const older = edited(revisions.text, /startxref\n\d+\n%%EOF\n$/u, `startxref\n${String(revisions.sections[0])}\n%%EOF\n`);
    expect(() => load(older)).toThrow(GenerationMismatchError);
  });

  it('reads a mismatched reference as null with a warning when asked, and throws by default', () => {
    const pdf = buildPdf([
      {
        xref: 'classic',
        objects: [{ number: 1, body: '<</Type/Catalog/Pages 2 0 R/Extra 3 1 R>>' }, pages, { number: 3, body: '(x)' }],
        trailer: '/Root 1 0 R',
      },
    ]);
    const lenient = loadDocument(pdf.bytes, { generationMismatch: 'null' });
    expect([lenient.get(pdfReference(3, 1)), summary(lenient)]).toStrictEqual([{ kind: 'null' }, ['intact', ['generation-mismatch']]]);
    expect(() => loadDocument(pdf.bytes).get(pdfReference(3, 1))).toThrow(GenerationMismatchError);
  });
});

// One revision of a generated file: its cross-reference form and the bodies of objects 3 onwards.
interface Revision {
  readonly xref: 'classic' | 'stream';
  readonly bodies: ReadonlyArray<string>;
}

// A file whose catalog refers to objects 3 onwards, so that comparing documents compares them; later revisions replace the first objects.
const generated = (revisions: ReadonlyArray<Revision>): Uint8Array => {
  const count = Math.max(...revisions.map(revision => revision.bodies.length));
  const references = Array.from({ length: count }, (_, index) => `${String(index + 3)} 0 R`).join(' ');
  const sections = revisions.map((revision, position): TestSection => {
    const bodies = position === 0 ? Array.from({ length: count }, (_, index) => revision.bodies[index % revision.bodies.length] ?? 'null') : revision.bodies;
    const objects = bodies.map((body, index) => ({ number: index + 3, body }));
    return {
      xref: revision.xref,
      objects: position === 0 ? [{ number: 1, body: `<</Type/Catalog/Pages 2 0 R/Extra[${references}]>>` }, ...onePageTree, ...objects] : objects,
      trailer: '/Root 1 0 R',
    };
  });
  return buildPdf(sections).bytes;
};

// What a reader sees of a document: its structure, warnings, pages and every object a generated file can number.
const observed = (document: LoadedDocument): Array<unknown> => [
  document.structure,
  document.warnings,
  document.pageCount,
  Array.from({ length: 24 }, (_, index) => document.get(pdfReference(index + 1, 0))),
];

const revision = fc.record({
  xref: fc.constantFrom('classic', 'stream'),
  bodies: fc.array(fc.constantFrom('(text)', '42', '[1 2]', '<</A 1>>', '/Name', '3.5', 'true'), { minLength: 1, maxLength: 4 }),
});

const files = fc.array(revision, { minLength: 1, maxLength: 2 }).map(generated);

describe('properties', () => {
  it('saves a document so that it loads back the same in every mode', () => {
    fc.assert(
      fc.property(files, fc.constantFrom('auto', 'incremental', 'full'), (bytes, mode) => {
        const document = loadDocument(bytes);
        expect(compareDocuments(document, loadDocument(document.save({ mode }).chunks)).differences).toStrictEqual([]);
      }),
    );
  });

  it('loads input split into segments at any bytes as it loads the contiguous bytes', () => {
    fc.assert(
      fc.property(
        files.chain(bytes => fc.tuple(fc.constant(bytes), fc.uniqueArray(fc.integer({ min: 1, max: bytes.length - 1 }), { maxLength: 6 }))),
        ([bytes, cuts]) => {
          const ends = [...cuts.toSorted((left, right) => left - right), bytes.length];
          const segments = ends.map((end, index) => bytes.subarray(index === 0 ? 0 : (ends[index - 1] ?? 0), end));
          expect(observed(loadDocument(segments))).toStrictEqual(observed(loadDocument(bytes)));
        },
      ),
    );
  });

  it('loads a file cut at any byte or throws one of the documented errors', () => {
    fc.assert(
      fc.property(
        files.chain(bytes => fc.tuple(fc.constant(bytes), fc.integer({ min: 0, max: bytes.length }))),
        ([bytes, cut]) => {
          // Either loaded or refused with a documented error, never a TypeError or RangeError from inside the parser.
          expect(loadOutcome(bytes.slice(0, cut))).toBe('loaded or documented');
        },
      ),
    );
  });
});
