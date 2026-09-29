import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { loadDocument } from '../document/loadDocument.ts';
import { ValidationError } from '../error/validationError.ts';
import { inflateZlib } from '../flate/inflate.ts';
import { readTextString } from '../metadata/documentInfo.ts';
import { PdfDictionaryEntries, pdfArray, pdfDictionary, pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf } from '../testing/pdfBuilder.ts';

import { writeGtsPdfxOutputIntent } from './writeOutputIntent.ts';

const base = (header = '1.7') =>
  buildPdf(
    [
      {
        xref: 'classic',
        objects: [
          { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
          { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
          { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Resources<<>>>>' },
        ],
        trailer: '/Root 1 0 R',
      },
    ],
    { header: `%PDF-${header}` },
  );

const profile = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url)));
const other = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/synthetic-cmyk.icc', import.meta.url)));

const intentOf = (document: ReturnType<typeof loadDocument>) => {
  const intents = document.catalog().get(pdfName('OutputIntents').bytes);
  if (intents?.kind !== 'array' || intents.items[0]?.kind !== 'reference') throw new Error('missing output intent');
  const intent = document.get(intents.items[0]);
  if (intent.kind !== 'dictionary') throw new Error('output intent is not a dictionary');
  return intent.entries;
};

const textOf = (value: ReturnType<typeof intentOf>, key: string): string | undefined => {
  const entry = value.get(pdfName(key).bytes);
  return entry?.kind === 'string' ? readTextString(entry.bytes).text : undefined;
};

const profileStream = (document: ReturnType<typeof loadDocument>) => {
  const reference = intentOf(document).get(pdfName('DestOutputProfile').bytes);
  if (reference?.kind !== 'reference') throw new Error('missing profile');
  const stream = document.get(reference);
  if (stream.kind !== 'stream') throw new Error('profile is not a stream');
  return stream;
};

const withIntent = (bytes: Uint8Array) => {
  const document = loadDocument(base().bytes);
  const profileReference = document.object({ kind: 'stream', dictionary: new PdfDictionaryEntries(), data: bytes });
  const entries = new PdfDictionaryEntries([
    [pdfName('S').bytes, pdfName('GTS_PDFA1')],
    [pdfName('DestOutputProfile').bytes, profileReference],
  ]);
  const intentReference = document.object(pdfDictionary(entries));
  const catalogReference = pdfReference(1, 0);
  const catalog = document.get(catalogReference);
  if (catalog.kind !== 'dictionary') throw new Error('missing catalog');
  catalog.entries.set(pdfName('OutputIntents').bytes, pdfArray([intentReference]));
  document.set(catalogReference, catalog);
  return { document, profileReference };
};

const setCatalogEntry = (
  document: ReturnType<typeof loadDocument>,
  name: string,
  value: ReturnType<typeof pdfName> | ReturnType<typeof pdfDictionary>,
): void => {
  const catalogReference = pdfReference(1, 0);
  const catalog = document.get(catalogReference);
  if (catalog.kind !== 'dictionary') throw new Error('missing catalog');
  catalog.entries.set(pdfName(name).bytes, value);
  document.set(catalogReference, catalog);
};

describe('gts pdfx output intent', () => {
  it('writes registry defaults', () => {
    const document = loadDocument(base().bytes);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(result.action).toBe('added');
    expect(textOf(intentOf(document), 'RegistryName')).toBe('http://www.color.org');
    expect(textOf(intentOf(document), 'Info')).toBe('FOGRA39');
    expect(textOf(intentOf(document), 'OutputCondition')).toContain('Gloss or matt coated, 115 g/m2');
  });

  it('embeds unchanged profile bytes and lowers a 1.7 header', () => {
    const document = loadDocument(base().bytes);
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    const stream = profileStream(document);
    expect(stream.dictionary.get(pdfName('N').bytes)).toStrictEqual({ kind: 'integer', value: 4 });
    expect(inflateZlib(stream.data).data).toStrictEqual(profile);
    const saved = document.save();
    expect(saved.mode).toBe('full');
    expect(saved.warnings).toStrictEqual(expect.arrayContaining([expect.objectContaining({ code: 'version-lowered' })]));
    expect(new TextDecoder().decode(saved.toBytes().subarray(0, 8))).toBe('%PDF-1.6');
  });

  it('requires Info for an unregistered identifier', () => {
    const document = loadDocument(base().bytes);
    expect(() => writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'Custom' })).toThrow(
      expect.objectContaining({ constructor: ValidationError }),
    );
    expect(document.save().mode).toBe('incremental');
  });

  it('reuses an identical indirect profile and refuses a conflicting one by default', () => {
    const { document, profileReference } = withIntent(profile);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(result.action).toBe('added');
    expect(intentOf(document).get(pdfName('DestOutputProfile').bytes)).toStrictEqual(profileReference);
    expect(() => writeGtsPdfxOutputIntent(document, { outputProfile: other, outputConditionIdentifier: 'FOGRA28' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'output-intent-conflict' }),
    );
  });

  it('replaces conflicting entries of every subtype when asked', () => {
    const { document, profileReference } = withIntent(other);
    const result = writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39', existing: 'replace' });
    expect(result.action).toBe('replaced');
    expect(result.removedSubtypes).toStrictEqual(['GTS_PDFA1']);
    expect(document.get(profileReference)).toStrictEqual({ kind: 'null' });
  });

  it('lowers a later catalog Version and refuses Extensions before editing', () => {
    const document = loadDocument(base('1.4').bytes);
    setCatalogEntry(document, 'Version', pdfName('1.7'));
    writeGtsPdfxOutputIntent(document, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' });
    expect(document.catalog().get(pdfName('Version').bytes)).toStrictEqual(pdfName('1.6'));
    const saved = document.save();
    expect(new TextDecoder().decode(saved.toBytes().subarray(0, 8))).toBe('%PDF-1.4');
    expect(saved.warnings).toStrictEqual(expect.arrayContaining([expect.objectContaining({ code: 'version-lowered' })]));

    const extended = loadDocument(base().bytes);
    setCatalogEntry(extended, 'Extensions', pdfDictionary());
    expect(() => writeGtsPdfxOutputIntent(extended, { outputProfile: profile, outputConditionIdentifier: 'FOGRA39' })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'pdf-extensions' }),
    );
  });
});
