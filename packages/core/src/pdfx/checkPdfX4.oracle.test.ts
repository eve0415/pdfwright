import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { pdfDate } from '../date/pdfDate.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { pt } from '../length/length.ts';
import { PdfDictionaryEntries, pdfArray, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { checkPdfX4, pdfX4Rules } from './checkPdfX4.ts';
import { preparePdfX4Pages } from './preparePages.ts';
import { writePdfX4Metadata } from './writeMetadata.ts';
import { writeGtsPdfxOutputIntent } from './writeOutputIntent.ts';

const profile = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url)));
const date = pdfDate({ year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0, offset: 'Z' });
const source = () =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
      ],
      trailer: `/Root 1 0 R/ID[<${'01'.repeat(16)}><${'02'.repeat(16)}>]`,
    },
  ]);

const prepared = () => {
  const document = loadDocument(source().bytes);
  writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
  writePdfX4Metadata(document, { metadataDate: date, trapped: 'False' });
  preparePdfX4Pages(document);
  return document;
};

const attach = (document: ReturnType<typeof loadDocument>, name: string, reference: ReturnType<typeof pdfReference>): void => {
  const catalogReference = pdfReference(1, 0);
  const catalog = document.get(catalogReference);
  if (catalog.kind !== 'dictionary') throw new Error('catalog is not a dictionary');
  catalog.entries.set(pdfName(name).bytes, reference);
  document.set(catalogReference, catalog);
};

describe('pdfx structural checker', () => {
  it('gives every listed rule one source, authority and non-conformance status', () => {
    const report = checkPdfX4(prepared());
    expect(pdfX4Rules).toHaveLength(26);
    expect(new Set(report.findings.map(finding => finding.rule)).size).toBe(26);
    expect(report.findings.map(finding => finding.source.length)).not.toContain(0);
    expect(report.findings.find(finding => finding.rule === 'X4-VERSION')?.status).toBe('not-checked');
    expect(report.summary).toBe('no-violation-found-by-these-rules');
  });

  it('labels each finding with an authority', () => {
    const report = checkPdfX4(prepared());
    expect(report.findings.map(finding => finding.authority.length)).not.toContain(0);
  });

  it('checks the structures the writer added without asserting certification', () => {
    const report = checkPdfX4(prepared());
    const status = (rule: string) => report.findings.find(finding => finding.rule === rule)?.status;
    expect(status('X4-OI-PRESENT')).toBe('passed');
    expect(status('X4-OI-PROFILE')).toBe('passed');
    expect(status('X4-XMP-VERSION')).toBe('passed');
    expect(status('X4-TRAPPED')).toBe('passed');
    expect(status('X4-BOXES')).toBe('passed');
  });

  it('reports missing structures as violations and keeps uncertain rules unverified', () => {
    const report = checkPdfX4(loadDocument(source().bytes));
    const status = (rule: string) => report.findings.find(finding => finding.rule === rule)?.status;
    expect(report.summary).toBe('violations-found');
    expect(status('X4-OI-PRESENT')).toBe('violation');
    expect(status('X4-XMP-VERSION')).toBe('violation');
    expect(status('X4-BOXES')).toBe('violation');
    expect(status('X4-PDF17-KEYS')).toBe('not-checked');
  });

  it('flags both print-area boxes on one page', () => {
    const document = prepared();
    document.page(0).setBox('ArtBox', [pt(0), pt(0), pt(100), pt(100)]);
    const finding = checkPdfX4(document).findings.find(item => item.rule === 'X4-BOXES');
    expect(finding?.status).toBe('violation');
    expect(finding?.location).toBe('page 0');
  });

  it('finds an LZW filter in reachable objects', () => {
    const document = prepared();
    const dictionary = new PdfDictionaryEntries([[pdfName('Filter').bytes, pdfName('LZWDecode')]]);
    const stream = document.object({ kind: 'stream', dictionary, data: Uint8Array.of(0) });
    attach(document, 'Extra', stream);
    const finding = checkPdfX4(document).findings.find(item => item.rule === 'X4-LZW');
    expect(finding?.status).toBe('violation');
  });

  it('finds an indirect LZW filter inside an indirect filter array', () => {
    const document = prepared();
    const filter = document.object(pdfName('LZWDecode'));
    const filters = document.object(pdfArray([pdfName('ASCII85Decode'), filter]));
    const dictionary = new PdfDictionaryEntries([[pdfName('Filter').bytes, filters]]);
    const stream = document.object({ kind: 'stream', dictionary, data: Uint8Array.of(0) });
    attach(document, 'Extra', stream);
    expect(checkPdfX4(document).findings.find(item => item.rule === 'X4-LZW')?.status).toBe('violation');
  });

  it('finds an embedded file attached through catalog AF', () => {
    const document = prepared();
    const data = document.object({
      kind: 'stream',
      dictionary: new PdfDictionaryEntries([[pdfName('Type').bytes, pdfName('EmbeddedFile')]]),
      data: Uint8Array.of(1),
    });
    const file = document.object({ kind: 'dictionary', entries: new PdfDictionaryEntries([[pdfName('EF').bytes, pdfArray([data])]]) });
    attach(document, 'AF', document.object(pdfArray([file])));
    expect(checkPdfX4(document).findings.find(item => item.rule === 'X4-EMBEDDED')?.status).toBe('violation');
  });

  it('finds a reachable file specification with EF', () => {
    const document = prepared();
    const file = document.object({ kind: 'dictionary', entries: new PdfDictionaryEntries([[pdfName('EF').bytes, pdfName('SomeData')]]) });
    attach(document, 'Extra', file);
    expect(checkPdfX4(document).findings.find(item => item.rule === 'X4-EMBEDDED')?.status).toBe('violation');
  });
});
