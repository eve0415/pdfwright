import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runTool } from '../../../../scripts/readerOracle.ts';
import { pdfDate } from '../date/pdfDate.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { preparePrintPdf } from './printConversionExample.ts';

const generatedJpeg = async (): Promise<Uint8Array> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-print-example-'));
  try {
    const input = path.join(directory, 'image.ppm');
    const output = path.join(directory, 'image.jpg');
    await writeFile(input, Uint8Array.of(...new TextEncoder().encode('P6\n2 1\n255\n'), 255, 0, 0, 0, 0, 255));
    const encoded = await runTool('magick', [input, '-sampling-factor', '1x1,1x1,1x1', '-quality', '90', output]);
    if (encoded.code !== 0) throw new Error(encoded.output);
    return Uint8Array.from(await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const printPdf = (jpeg: Uint8Array): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
        { number: 4, body: streamBody('', '/Im Do') },
        {
          number: 5,
          body: streamBody('/Type/XObject/Subtype/Image/Width 2/Height 1/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/DCTDecode', latin1Text(jpeg)),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

describe('print conversion example', () => {
  it('transcodes a JPEG and streams a PDF/X-marked save', async () => {
    const jpeg = await generatedJpeg();
    const sourceRgbProfile = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/sRGB.icm', import.meta.url)));
    const outputProfile = Uint8Array.from(await readFile(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url)));
    const result = preparePrintPdf({
      input: printPdf(jpeg),
      sourceRgbProfile,
      outputProfile,
      outputConditionIdentifier: 'FOGRA28',
      documentId: 'uuid:02ebf2a5-f4c4-45be-a637-f05208af344e',
      metadataDate: pdfDate({ year: 2024, month: 3, day: 1, hour: 12, minute: 0, second: 0, offset: 'Z' }),
    });
    expect([result.conversion.images.converted, result.saved.kind]).toStrictEqual([1, 'streamed']);
    let bytes = 0;
    for await (const chunk of result.saved.toStream()) bytes += chunk.length;
    expect(bytes).toBeGreaterThan(0);
    expect(result.structure.findings.map(finding => [finding.rule, finding.status])).toContainEqual(['X4-OI-PRESENT', 'passed']);
  });
});
