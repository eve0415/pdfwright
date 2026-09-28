import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createDeflate } from 'node:zlib';

import { convertImages } from '../packages/core/src/colorConvert/convertImages.ts';
import { loadDocument } from '../packages/core/src/document/loadDocument.ts';
import { parseIccProfile } from '../packages/core/src/icc/iccProfile.ts';
import { buildPdf, latin1Text, streamBody } from '../packages/core/src/testing/pdfBuilder.ts';

const width = 10_000;
const height = 10_000;
const row = new Uint8Array(width * 3);
const compressed: Uint8Array[] = [];
const rows = Readable.from(
  (function* (): Generator<Uint8Array> {
    for (let index = 0; index < height; index++) yield row;
  })(),
);
for await (const value of rows.pipe(createDeflate())) {
  const chunk: unknown = value;
  if (!(chunk instanceof Uint8Array)) throw new Error('deflate returned non-byte data');
  compressed.push(Uint8Array.from(chunk));
}
const sourceBytes = new Uint8Array(compressed.reduce((sum, chunk) => sum + chunk.length, 0));
let position = 0;
for (const chunk of compressed) {
  sourceBytes.set(chunk, position);
  position += chunk.length;
}

const source = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</XObject<</Im 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Im Do') },
      {
        number: 5,
        body: streamBody(
          `/Type/XObject/Subtype/Image/Width ${String(width)}/Height ${String(height)}/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/FlateDecode`,
          latin1Text(sourceBytes),
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]).bytes;

const fixtureDirectory = path.join(process.cwd(), 'tests/fixtures/icc');
const rgbBytes = await readFile(path.join(fixtureDirectory, 'sRGB.icm'));
const cmykBytes = await readFile(path.join(fixtureDirectory, 'fogra28l.icc'));
const rgb = parseIccProfile(Uint8Array.from(rgbBytes));
const cmyk = parseIccProfile(Uint8Array.from(cmykBytes));
const start = performance.now();
const document = loadDocument(source);
convertImages(document, { sourceRgbProfile: rgb, outputProfile: cmyk });
const saved = document.save();
let outputBytes = 0;
for await (const chunk of saved.toStream()) outputBytes += chunk.length;
const seconds = (performance.now() - start) / 1000;
console.log(JSON.stringify({ pixels: width * height, seconds, peakRssMiB: process.resourceUsage().maxRSS / 1024, outputBytes, kind: saved.kind }));
