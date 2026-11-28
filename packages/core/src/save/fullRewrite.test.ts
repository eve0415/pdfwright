import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfDictionaryEntries } from '../object/pdfDictionaryEntries.ts';
import type { PdfObject } from '../object/pdfObject.ts';
import type { TestObject, TestSection } from '../testing/pdfBuilder.ts';

import { describe, expect, inject, it } from 'vitest';

import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { rect } from '../document/rect.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { pt } from '../length/length.ts';
import { pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

const hex = (bytes: Uint8Array): string => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

const catalog = { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' };
const pages = { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' };
const page = { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792.0]/Contents 4 0 R/Resources<<>>>>' };
const content = { number: 4, body: streamBody('', '0 0 m 10 10 l S') };

// A PDF 1.4 file with one classic section, which a full rewrite writes with a classic table.
const classic = (objects: ReadonlyArray<TestObject>, trailer = '/Root 1 0 R'): Uint8Array =>
  buildPdf([{ xref: 'classic', objects, trailer }], { header: '%PDF-1.4' }).bytes;

const text = (bytes: Uint8Array): string => latin1Text(bytes);

// The number of rows a cross-reference stream holds, from its decoded length and W.
const streamRows = (xref: PdfObject): number => {
  if (xref.kind !== 'stream') {
    return 0;
  }
  const widths = xref.dictionary.get(pdfName('W').bytes);
  const rowBytes = widths?.kind === 'array' ? widths.items.reduce((sum, item) => sum + (item.kind === 'integer' ? item.value : 0), 0) : 0;
  return inflateZlib(xref.data).data.length / rowBytes;
};

// A file with a cross-reference stream whose last object is numbered far above the others.
const highStream = (high: number): Uint8Array =>
  buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content, { number: high, body: '(high)' }], trailer: '/Root 1 0 R' }]).bytes;

// The header a full rewrite writes and the codes of its warnings.
const headerAndWarnings = (sections: ReadonlyArray<TestSection>, header: string): readonly [string, ReadonlyArray<string>] => {
  const saved = loadDocument(buildPdf(sections, { header }).bytes).save({ mode: 'full' });
  return [text(saved.toBytes()).slice(0, 8), saved.warnings.map(warning => warning.code)];
};

const kind = (sections: ReadonlyArray<TestSection>, header: string, edit?: (document: LoadedDocument) => void): string | undefined => {
  const document = loadDocument(buildPdf(sections, { header }).bytes);
  edit?.(document);
  return loadDocument(document.save({ mode: 'full' }).chunks).structure.lastSectionKind;
};

// The file identifier pair of a saved file as lowercase hex, or undefined when its trailer has none.
const identifierOf = (chunks: ReadonlyArray<Uint8Array>): ReadonlyArray<string> | undefined => {
  const id = loadDocument(chunks).structure.trailer.get(pdfName('ID').bytes);
  return id?.kind === 'array' ? id.items.map(item => (item.kind === 'string' ? hex(item.bytes) : '')) : undefined;
};

const keyNames = (entries: PdfDictionaryEntries): ReadonlyArray<string> => [...entries.entries()].map(([key]) => latin1Text(key));

// Editing member 5 of the hybrid source unpacks object stream 6, so no kept stream forces the cross-reference format.
const editMember = (document: LoadedDocument): void => {
  document.set(pdfReference(5, 0), pdfName('Changed'));
};

// A linearized file whose H entry gives the offset of object 10, its hint stream, in ten digits so that the offsets do not depend on its value.
const linearizedObjects = (hintOffset: number): ReadonlyArray<TestObject> => [
  { number: 9, body: `<</Linearized 1/L 999/H[${String(hintOffset).padStart(10, '0')} 20]>>` },
  catalog,
  pages,
  page,
  content,
  { number: 10, body: streamBody('', 'hints') },
];

// A classic PDF 1.4 file whose update adds one object far above the others, so that no section lists the numbers between.
const sparse = (high: number): Uint8Array =>
  buildPdf(
    [
      { xref: 'classic', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R' },
      { xref: 'classic', objects: [{ number: high, body: '(high)' }], trailer: '/Root 1 0 R' },
    ],
    { header: '%PDF-1.4' },
  ).bytes;

describe('full rewrite', () => {
  it('covers every object number up to a high one with a compressed cross-reference stream', () => {
    const source = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content, { number: 10_000, body: '(high)' }], trailer: '/Root 1 0 R' }]).bytes;
    const saved = loadDocument(source).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    const rows = streamRows(reloaded.get(pdfReference(10_001, 0)));
    expect([
      output.length < 2000,
      output.includes('/Size 10002'),
      output.includes('/Filter/FlateDecode'),
      output.includes('/Index'),
      rows,
      reloaded.get(pdfReference(10_000, 0)),
    ]).toStrictEqual([true, true, true, false, 10_002, { kind: 'string', bytes: latin1Bytes('high'), encoding: 'literal' }]);
  });

  it('covers every object number with a classic table for a classic PDF 1.4 source', () => {
    const saved = loadDocument(sparse(50)).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const unused = output.split('0000000000 65535 f \n').length - 1;
    expect([output.includes('xref\n0 51\n'), unused, loadDocument(saved.chunks).structure.lastSectionKind]).toStrictEqual([true, 46, 'classic']);
  });

  it('writes a cross-reference stream when the source header is 1.5 or later or the source used one', () => {
    const objects = [catalog, pages, page, content];
    const classicSource = [{ xref: 'classic', objects, trailer: '/Root 1 0 R' }] as const;
    const streamSource = [{ xref: 'stream', objects, trailer: '/Root 1 0 R' }] as const;
    const hybridSource = [
      ...classicSource,
      { xref: 'hybrid', objects: [], objectStreams: [{ number: 6, members: [{ number: 5, body: '(hidden)' }] }], trailer: '/Root 1 0 R' },
    ] as const;
    // An older stream section under a newer classic one still makes the source a cross-reference stream user.
    const olderStreamSource = [streamSource[0], { xref: 'classic', objects: [{ number: 5, body: '(added)' }], trailer: '/Root 1 0 R' }] as const;
    expect([
      kind(classicSource, '%PDF-1.4'),
      kind(classicSource, '%PDF-1.5'),
      kind(classicSource, '%PDF-1.7'),
      kind(streamSource, '%PDF-1.4'),
      kind(hybridSource, '%PDF-1.4'),
      kind(hybridSource, '%PDF-1.4', editMember),
      kind(olderStreamSource, '%PDF-1.4'),
    ]).toStrictEqual(['classic', 'stream', 'stream', 'stream', 'stream', 'stream', 'stream']);
  });

  it('raises a header below 1.5 when it writes a cross-reference stream, and reports it', () => {
    const objects = [catalog, pages, page, content];
    expect([
      headerAndWarnings([{ xref: 'stream', objects, trailer: '/Root 1 0 R' }], '%PDF-1.4'),
      headerAndWarnings([{ xref: 'stream', objects, trailer: '/Root 1 0 R' }], '%PDF-1.6'),
      headerAndWarnings([{ xref: 'classic', objects, trailer: '/Root 1 0 R' }], '%PDF-1.3'),
    ]).toStrictEqual([
      ['%PDF-1.5', ['version-raised']],
      ['%PDF-1.6', []],
      ['%PDF-1.3', []],
    ]);
  });

  // sparse(high) uses the numbers 0 to 4 and high, so its table holds high - 5 entries for unused numbers.
  it('refuses a classic table that would hold more entries for unused numbers than the limit allows', () => {
    const highString = { kind: 'string', bytes: latin1Bytes('high'), encoding: 'literal' } as const;
    const atLimit = loadDocument(sparse(1000)).save({ mode: 'full', maxTableGapEntries: 995 });
    expect(loadDocument(atLimit.chunks).get(pdfReference(1000, 0))).toStrictEqual(highString);
    const overLimit = (): void => {
      loadDocument(sparse(1000)).save({ mode: 'full', maxTableGapEntries: 994 });
    };
    expect(overLimit).toThrow(ResourceLimitError);
    expect(overLimit).toThrow(/ 995 entries .*maxTableGapEntries \(994\)/u);
    // The documented default is 100,000.
    const atDefault = loadDocument(sparse(100_005)).save({ mode: 'full' });
    expect(loadDocument(atDefault.chunks).get(pdfReference(100_005, 0))).toStrictEqual(highString);
    const overDefault = (): void => {
      loadDocument(sparse(100_006)).save({ mode: 'full' });
    };
    expect(overDefault).toThrow(ResourceLimitError);
    expect(overDefault).toThrow(/ 100001 entries .*maxTableGapEntries \(100000\)/u);
  });

  it('refuses a cross-reference stream that would hold more entries for unused numbers than the limit allows', () => {
    const start = performance.now();
    expect(() => loadDocument(highStream(2_147_483_647)).save({ mode: 'full' })).toThrow(ResourceLimitError);
    expect(performance.now() - start).toBeLessThan(1000);
    // highStream(1000) uses the numbers 0 to 4 and 1000, and the rewrite numbers its cross-reference stream 1001, so 995 numbers are unused.
    const overLimit = (): void => {
      loadDocument(highStream(1000)).save({ mode: 'full', maxGeneratedXrefEntries: 994 });
    };
    expect(overLimit).toThrow(ResourceLimitError);
    expect(overLimit).toThrow(/ 995 entries .*maxGeneratedXrefEntries \(994\)/u);
    const raised = loadDocument(highStream(1000)).save({ mode: 'full', maxGeneratedXrefEntries: 995 });
    expect(loadDocument(raised.chunks).get(pdfReference(1000, 0))).toStrictEqual({ kind: 'string', bytes: latin1Bytes('high'), encoding: 'literal' });
  });

  it.runIf(inject('runtime') === 'node')(
    'covers eight million object numbers in a small cross-reference stream',
    () => {
      const source = buildPdf([
        { xref: 'stream', objects: [catalog, pages, page, content, { number: 8_000_000, body: '(high)' }], trailer: '/Root 1 0 R' },
      ]).bytes;
      const start = performance.now();
      const saved = loadDocument(source).save({ mode: 'full' });
      const elapsed = performance.now() - start;
      const bytes = saved.toBytes();
      expect([bytes.length < 256 * 1024, elapsed < 20_000, loadDocument(saved.chunks).get(pdfReference(8_000_000, 0)).kind]).toStrictEqual([
        true,
        true,
        'string',
      ]);
    },
    30_000,
  );

  it('sets Size from objects retained after dropping a cross-reference stream', () => {
    const source = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R', xrefStreamNumber: 10 }]).bytes;
    const output = text(loadDocument(source).save({ mode: 'full' }).toBytes());
    // Objects 1 to 4, and the rewrite's own cross-reference stream as object 5.
    expect(output).toContain('/Size 6');
  });

  it('copies unchanged objects as one run, keeping their numbers', () => {
    const source = classic([catalog, pages, page, content, { number: 7, body: '(seven)' }]);
    const saved = loadDocument(source).save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    expect([saved.mode, saved.chunks.filter(chunk => chunk.buffer === source.buffer).length, reloaded.structure.status]).toStrictEqual(['full', 1, 'intact']);
    expect(output).toContain('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n');
    expect([reloaded.get(pdfReference(7, 0)), reloaded.structure.lastSectionKind]).toStrictEqual([
      { kind: 'string', bytes: latin1Bytes('seven'), encoding: 'literal' },
      'classic',
    ]);
  });

  it('writes changed and repaired objects after the runs and frees deleted ones', () => {
    const source = classic([catalog, pages, page, { number: 4, body: '<</Length 99>>\nstream\n0 0 m 10 10 l S\nendstream' }, { number: 7, body: '(seven)' }]);
    const document = loadDocument(source);
    document.page(0).setBox('TrimBox', rect(pt(10), pt(10), pt(100), pt(100)));
    document.delete(pdfReference(7, 0));
    const saved = document.save({ mode: 'full' });
    const output = text(saved.toBytes());
    expect(output).toContain(
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792.0]/Contents 4 0 R/Resources<<>>/TrimBox[10 10 100 100]>>\nendobj\n4 0 obj\n<</Length 15>>\nstream\n0 0 m 10 10 l S\nendstream\nendobj\n',
    );
    const reloaded = loadDocument(saved.chunks);
    reloaded.get(pdfReference(4, 0));
    expect([reloaded.warnings, reloaded.get(pdfReference(7, 0)), output]).toStrictEqual([
      [],
      { kind: 'null' },
      expect.stringMatching(/xref\n0 8\n0000000005 65535 f \n(?:.*\n){6}0000000000 00001 f \ntrailer/u),
    ]);
  });

  it('keeps untouched object streams and unpacks touched ones', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [catalog],
        objectStreams: [
          { number: 5, members: [pages, page] },
          {
            number: 6,
            members: [
              { number: 8, body: '(eight)' },
              { number: 9, body: '(nine)' },
            ],
          },
        ],
        trailer: '/Root 1 0 R',
      },
    ]).bytes;
    const document = loadDocument(source);
    document.set(pdfReference(9, 0), pdfName('Changed'));
    const saved = document.save({ mode: 'full' });
    const output = text(saved.toBytes());
    const reloaded = loadDocument(saved.chunks);
    expect([
      output.includes('5 0 obj'),
      output.includes('6 0 obj'),
      output.includes('8 0 obj\n(eight)\nendobj'),
      reloaded.structure.lastSectionKind,
    ]).toStrictEqual([true, false, true, 'stream']);
    expect([reloaded.pageCount, reloaded.get(pdfReference(9, 0)), reloaded.get(pdfReference(6, 0))]).toStrictEqual([1, pdfName('Changed'), { kind: 'null' }]);
  });

  it('keeps an object that reuses the number of an older cross-reference stream', () => {
    const source = buildPdf([
      { xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R', xrefStreamNumber: 9 },
      { xref: 'stream', objects: [{ number: 9, body: '(reused)' }], trailer: '/Root 1 0 R', xrefStreamNumber: 10 },
    ]).bytes;
    const reloaded = loadDocument(loadDocument(source).save({ mode: 'full' }).chunks);
    expect(reloaded.get(pdfReference(9, 0))).toStrictEqual({ kind: 'string', bytes: latin1Bytes('reused'), encoding: 'literal' });
  });

  it('unpacks an object stream whose member was replaced by a later copy', () => {
    const source = buildPdf([
      {
        xref: 'stream',
        objects: [catalog],
        objectStreams: [{ number: 5, members: [pages, { ...page, body: page.body.replace('612', '200') }] }],
        trailer: '/Root 1 0 R',
      },
      { xref: 'stream', objects: [page, content], trailer: '/Root 1 0 R' },
    ]).bytes;
    const output = text(loadDocument(source).save({ mode: 'full' }).toBytes());
    expect([output.includes('/Type/ObjStm'), output.includes('MediaBox[0 0 200'), output.includes('2 0 obj')]).toStrictEqual([false, false, true]);
  });

  it('drops the linearization dictionary and the hint stream its H entry names, with a warning', () => {
    // ISO 32000-1:2008, Annex F, Table F.1: the first element of H is the offset of the primary hint stream.
    const draft = buildPdf([{ xref: 'classic', objects: linearizedObjects(0), trailer: '/Root 1 0 R' }]);
    const linearized = buildPdf([{ xref: 'classic', objects: linearizedObjects(draft.offsets.get(10) ?? 0), trailer: '/Root 1 0 R' }]);
    const document = loadDocument(linearized.bytes);
    const saved = document.save({ mode: 'full' });
    const reloaded = loadDocument(saved.chunks);
    expect([
      document.structure.linearized,
      document.get(pdfReference(10, 0)).kind,
      saved.warnings.map(warning => warning.code),
      reloaded.get(pdfReference(9, 0)),
      reloaded.get(pdfReference(10, 0)),
      reloaded.pageCount,
      reloaded.structure.status,
    ]).toStrictEqual([true, 'stream', ['linearization-removed'], { kind: 'null' }, { kind: 'null' }, 1, 'intact']);
  });

  it.each([
    ['bytes before the header', 'JUNK', '', ['junk-dropped']],
    ['bytes after the last %%EOF', '', 'garbage', ['junk-dropped']],
    ['white space after the last %%EOF', '', '\n\n  ', []],
    ['nothing around the file', '', '', []],
  ] as const)('reports junk around the file only when it is not white space: %s', (_, prefix, suffix, codes) => {
    const source = buildPdf([{ xref: 'classic', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R' }], { prefix });
    const saved = loadDocument(latin1Bytes(`${source.text}${suffix}`)).save({ mode: 'full' });
    expect([
      saved.warnings.map(warning => warning.code),
      text(saved.toBytes()).startsWith('%PDF-1.7\n'),
      loadDocument(saved.chunks).structure.status,
    ]).toStrictEqual([codes, true, 'intact']);
  });

  it('keeps the first file identifier, derives the second from the contents, and adds none to a file without one', () => {
    const withId = classic([catalog, pages, page, content], `/Root 1 0 R/ID[<${'aa'.repeat(16)}><${'bb'.repeat(16)}>]`);
    const unedited = identifierOf(loadDocument(withId).save({ mode: 'full' }).chunks);
    const again = identifierOf(loadDocument(withId).save({ mode: 'full' }).chunks);
    const editedDocument = loadDocument(withId);
    editedDocument.set(pdfReference(4, 0), pdfInteger(4));
    const edited = identifierOf(editedDocument.save({ mode: 'full' }).chunks);
    const withoutId = loadDocument(classic([catalog, pages, page, content])).save({ mode: 'full' });
    expect([unedited?.[0], edited?.[0], again, identifierOf(withoutId.chunks), text(withoutId.toBytes()).includes('/ID')]).toStrictEqual([
      'aa'.repeat(16),
      'aa'.repeat(16),
      unedited,
      undefined,
      false,
    ]);
    // ISO 32000-1:2008, 14.4: the second identifier changes with the contents, so it is neither the source's nor shared by different contents.
    expect(new Set([unedited?.[1], edited?.[1], 'bb'.repeat(16)]).size).toBe(3);
    expect([unedited?.[1], edited?.[1]]).toStrictEqual([expect.stringMatching(/^[0-9a-f]{32}$/u), expect.stringMatching(/^[0-9a-f]{32}$/u)]);
  });

  it('keeps trailer entries that begin with ID', () => {
    const seeded = text(
      loadDocument(classic([catalog, pages, page, content], '/Root 1 0 R/IDSeed(keep)'))
        .save({ mode: 'full' })
        .toBytes(),
    );
    expect(seeded).toMatch(/\ntrailer\n<<\/Size 5\/Root 1 0 R\/IDSeed\(keep\)>>/u);
  });

  it('leaves the stream keys out of a cross-reference stream dictionary that a reconstruction adopted as the trailer', () => {
    const stream = buildPdf([{ xref: 'stream', objects: [catalog, pages, page, content], trailer: '/Root 1 0 R' }]).text.replace(
      /startxref\n\d+/u,
      'startxref\n3',
    );
    const document = loadDocument(latin1Bytes(stream));
    const reloaded = loadDocument(document.save({ mode: 'full' }).chunks);
    // ISO 32000-1:2008, 7.5.8.2, Table 17: the new stream's own Type, W and Length describe it, and Index is left out for its default.
    expect([
      document.structure.status,
      document.structure.lastSectionKind,
      keyNames(reloaded.structure.trailer),
      reloaded.structure.status,
      reloaded.warnings,
    ]).toStrictEqual(['reconstructed', undefined, ['Type', 'Size', 'Root', 'W', 'Filter', 'Length'], 'intact', []]);
  });

  it('rewrites a reconstructed file by default', () => {
    const damaged = text(classic([catalog, pages, page, content])).replace(/startxref\n\d+/u, 'startxref\n3');
    const document = loadDocument(latin1Bytes(damaged));
    const saved = document.save();
    expect([document.structure.status, saved.mode, loadDocument(saved.chunks).structure.status]).toStrictEqual(['reconstructed', 'full', 'intact']);
  });

  it('reports an unreadable object discarded during reconstruction in the save warnings', () => {
    const source = buildPdf([{ xref: 'classic', objects: [catalog, pages, page, content, { number: 5, body: '<zz>' }], trailer: '/Root 1 0 R' }]);
    const damaged = source.text.replace(/startxref\n\d+/u, 'startxref\n3');
    const document = loadDocument(latin1Bytes(damaged));
    expect(document.warnings.map(warning => warning.code)).toContain('recovery-unreadable-object');
    expect(document.save().warnings.map(warning => [warning.code, warning.objectNumber])).toContainEqual(['recovery-object-dropped', 5]);
  });

  it('writes trailer changes into the rewritten trailer', () => {
    const document = loadDocument(classic([catalog, pages, page, content, { number: 5, body: '<</Producer(new)>>' }], '/Root 1 0 R/Info 9 0 R/Private(gone)'));
    const edited = internalsOf(document)?.objects;
    edited?.setTrailerEntry(pdfName('Info').bytes, pdfReference(5, 0));
    edited?.setTrailerEntry(pdfName('Private').bytes, undefined);
    expect(text(document.save({ mode: 'full' }).toBytes())).toMatch(/\ntrailer\n<<\/Size 6\/Root 1 0 R\/Info 5 0 R>>\nstartxref/u);
  });
});
