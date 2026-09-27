import type { LoadOptions, LoadedDocument } from './loadDocument.ts';

import { describe, expect, it } from 'vitest';

import { EncryptedDocumentError } from '../error/encryptedDocumentError.ts';
import { InvalidArgumentError } from '../error/invalidArgumentError.ts';
import { ParseError } from '../error/parseError.ts';
import { PdfDictionaryEntries, pdfArray, pdfInteger, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Bytes, latin1Text } from '../testing/pdfBuilder.ts';

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

const summary = (document: LoadedDocument): (string | string[])[] => [document.structure.status, document.warnings.map(warning => warning.code)];

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
    expect(() => load(base.text.replace('/Root 1 0 R', '/Root 1 1 R'))).toThrow(ParseError);
    const damaged = buildPdf([{ xref: 'classic', objects: [{ number: 9, body: '<</X <zz>>>' }, catalog, pages], trailer: '/Root 1 0 R' }]);
    expect(summary(loadDocument(damaged.bytes))).toStrictEqual(['intact', []]);
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

  it('detects linearized files', () => {
    const linearized = buildPdf([{ xref: 'classic', objects: [{ number: 3, body: '<</Linearized 1/L 999>>' }, catalog, pages], trailer: '/Root 1 0 R' }]);
    expect([loadDocument(linearized.bytes).structure.linearized]).toStrictEqual([true]);
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
