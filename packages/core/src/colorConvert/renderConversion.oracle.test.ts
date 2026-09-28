import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertTransparencyGroups } from './convertGroups.ts';
import { convertMeshShadings } from './convertMeshes.ts';
import { MeshBitWriter } from './meshBitWriter.ts';
import { rewritePageColors } from './rewritePage.ts';

const profilePath = (name: string): string => fileURLToPath(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url));
const sourcePath = profilePath('sRGB.icm');
const destinationPath = profilePath('fogra28l.icc');
const source = parseIccProfile(Uint8Array.from(await readFile(sourcePath)));
const destination = parseIccProfile(Uint8Array.from(await readFile(destinationPath)));
const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');

const transparency = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        number: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Group<</S/Transparency/CS/DeviceRGB>>/Contents 4 0 R/Resources<</ExtGState<</A<</ca 1>>/B<</ca 0.65/BM/Multiply>>>>>>>>',
      },
      { number: 4, body: streamBody('', '/A gs 0.8 0.2 0.1 rg 10 10 60 60 re f /B gs 0.1 0.5 0.9 rg 30 30 60 60 re f') },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const mesh = (): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const vertex of [
    [0, 0, 255, 0, 0],
    [100, 0, 0, 255, 0],
    [0, 100, 0, 0, 255],
  ]) {
    writer.write(2, 0);
    for (const value of vertex) writer.write(8, value);
    writer.alignByte();
  }
  return writer.finish(1024);
};

const meshData = latin1Text(mesh());
const meshPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Sh1 sh') },
      {
        number: 5,
        body: streamBody('/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1 0 1 0 1]', meshData),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly samples: Uint8Array;
}

const render = async (directory: string, name: string, bytes: Uint8Array): Promise<Raster> => {
  const input = path.join(directory, `${name}.pdf`);
  const output = path.join(directory, `${name}.pam`);
  await writeFile(input, bytes);
  const child = spawn('gs', [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pamcmyk32',
    '-r100',
    `-sDefaultRGBProfile=${sourcePath}`,
    `-sDefaultCMYKProfile=${destinationPath}`,
    `-sOutputICCProfile=${destinationPath}`,
    `-sOutputFile=${output}`,
    input,
  ]);
  const result: readonly unknown[] = await once(child, 'close');
  expect(result[0]).toBe(0);
  const data = Uint8Array.from(await readFile(output));
  const header = new TextDecoder('ascii').decode(data.subarray(0, Math.min(data.length, 512)));
  const end = header.indexOf('ENDHDR\n');
  if (end === -1) throw new Error('Ghostscript did not write a PAM header');
  const width = Number(/WIDTH (\d+)/u.exec(header)?.[1]);
  const height = Number(/HEIGHT (\d+)/u.exec(header)?.[1]);
  return { width, height, samples: data.subarray(end + 7) };
};

const lab = (channels: readonly number[]): readonly number[] => {
  const pcs = toPcs(channels);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};

const measure = (before: Raster, after: Raster) => {
  expect([before.width, before.height]).toStrictEqual([after.width, after.height]);
  expect(before.samples).toHaveLength(before.width * before.height * 4);
  expect(after.samples).toHaveLength(after.width * after.height * 4);
  const differences: number[] = [];
  let sourcePixels = 0;
  let convertedPixels = 0;
  for (let offset = 0; offset < before.samples.length; offset += 4) {
    const first = [...before.samples.subarray(offset, offset + 4)].map(value => value / 255);
    const second = [...after.samples.subarray(offset, offset + 4)].map(value => value / 255);
    const firstPainted = first.some(value => value >= 0.01);
    const secondPainted = second.some(value => value >= 0.01);
    if (firstPainted) sourcePixels++;
    if (secondPainted) convertedPixels++;
    if (!firstPainted && !secondPainted) continue;
    differences.push(deltaE2000(lab(first), lab(second)));
  }
  differences.sort((left, right) => left - right);
  const sum = differences.reduce((total, value) => total + value, 0);
  return {
    pixels: differences.length,
    sourcePixels,
    convertedPixels,
    max: differences.at(-1) ?? 0,
    p99: differences[Math.floor(0.99 * (differences.length - 1))] ?? 0,
    mean: sum / differences.length,
  };
};

describe('converted rendering', () => {
  it.each([
    {
      name: 'transparency',
      maxBound: 12,
      p99Bound: 12,
      original: transparency.bytes,
      convert: (bytes: Uint8Array) => {
        const document = loadDocument(bytes);
        rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
        convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
        return document.save().toBytes();
      },
    },
    {
      name: 'mesh',
      maxBound: 25,
      p99Bound: 23,
      original: meshPdf.bytes,
      convert: (bytes: Uint8Array) => {
        const document = loadDocument(bytes);
        convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
        return document.save().toBytes();
      },
    },
  ])('measures $name against Ghostscript CMYK rendering', async ({ name, original, convert, maxBound, p99Bound }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-render-'));
    try {
      const first = await render(directory, `${name}-source`, original);
      const second = await render(directory, `${name}-converted`, convert(original));
      const statistics = measure(first, second);
      stdout.write(`${name}: ${JSON.stringify(statistics)}\n`);
      expect(statistics.pixels).toBeGreaterThan(0);
      expect(statistics.max).toBeLessThan(Infinity);
      expect(statistics.max).toBeLessThanOrEqual(maxBound);
      expect(statistics.p99).toBeLessThanOrEqual(p99Bound);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
