import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';
import { text as streamText } from 'node:stream/consumers';
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

const transparency = (groupColor: string) =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        {
          number: 3,
          body: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Group<</S/Transparency${groupColor}>>/Contents 4 0 R/Resources<</ExtGState<</A<</ca 1>>/B<</ca 0.65/BM/Multiply>>>>>>>>`,
        },
        { number: 4, body: streamBody('', '/A gs 0.8 0.2 0.1 rg 10 10 60 60 re f /B gs 0.1 0.5 0.9 rg 30 30 60 60 re f') },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const mesh = (colors: readonly (readonly number[])[]): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const [index, [x, y]] of [
    [0, 0],
    [100, 0],
    [0, 100],
  ].entries()) {
    writer.write(2, 0);
    writer.write(8, x ?? 0);
    writer.write(8, y ?? 0);
    for (const value of colors[index] ?? []) writer.write(8, value);
    writer.alignByte();
  }
  return writer.finish(1024);
};

const meshPdf = (colorSpace: 'DeviceRGB' | 'DeviceCMYK', data: Uint8Array) =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
        { number: 4, body: streamBody('', '/Sh1 sh') },
        {
          number: 5,
          body: streamBody(
            `/ShadingType 4/ColorSpace/${colorSpace}/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1 0 1 0 1${colorSpace === 'DeviceCMYK' ? ' 0 1' : ''}]`,
            latin1Text(data),
          ),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]);

const rgbVertices = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

const transiccVertices = async (): Promise<readonly number[][]> => {
  const child = spawn('transicc', ['-n', `-i${sourcePath}`, `-o${destinationPath}`, '-t1', '-b', '-c0']);
  child.stdin.end(`${rgbVertices.map(vertex => vertex.join(' ')).join('\n')}\n`);
  const [output, closed] = await Promise.all([streamText(child.stdout), once(child, 'close')]);
  expect(closed[0]).toBe(0);
  return output
    .trim()
    .split(/\r?\n/u)
    .map(line =>
      line
        .trim()
        .split(/\s+/u)
        .map(value => Math.round((Number(value) / 100) * 255)),
    );
};

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

const convertTransparency = (bytes: Uint8Array): Uint8Array => {
  const document = loadDocument(bytes);
  rewritePageColors(document, { sourceRgbProfile: source, outputProfile: destination });
  convertTransparencyGroups(document, { sourceRgbProfile: source, outputProfile: destination });
  return document.save().toBytes();
};

const convertMesh = (bytes: Uint8Array): Uint8Array => {
  const document = loadDocument(bytes);
  convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
  return document.save().toBytes();
};

describe('converted rendering', () => {
  it('separates transparency correctness from the D7 appearance change', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-render-'));
    try {
      const original = transparency('/CS/DeviceRGB').bytes;
      const appearance = await render(directory, 'transparency-rgb', original);
      const reference = await render(directory, 'transparency-cmyk-group', transparency('/CS/DeviceCMYK').bytes);
      const converted = await render(directory, 'transparency-converted', convertTransparency(original));
      const correctness = measure(reference, converted);
      const policyAppearance = measure(appearance, converted);
      stdout.write(`transparency correctness: ${JSON.stringify(correctness)}\n`);
      stdout.write(`transparency D7 appearance: ${JSON.stringify(policyAppearance)}\n`);
      expect(correctness.max).toBeLessThanOrEqual(0.5);
      expect(policyAppearance.max).toBeLessThanOrEqual(9.8);
      expect(policyAppearance.p99).toBeLessThanOrEqual(9.8);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a transparency group without an explicit colour space close to its input', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-render-'));
    try {
      const original = transparency('').bytes;
      const before = await render(directory, 'implicit-group-before', original);
      const after = await render(directory, 'implicit-group-after', convertTransparency(original));
      expect(measure(before, after).max).toBeLessThanOrEqual(0.5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('compares mesh correctness with independent CMYK vertices and records appearance', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-render-'));
    try {
      const original = meshPdf('DeviceRGB', mesh(rgbVertices)).bytes;
      const reference = meshPdf('DeviceCMYK', mesh(await transiccVertices())).bytes;
      const before = await render(directory, 'mesh-rgb', original);
      const oracle = await render(directory, 'mesh-cmyk-reference', reference);
      const after = await render(directory, 'mesh-converted', convertMesh(original));
      const correctness = measure(oracle, after);
      const appearance = measure(before, after);
      stdout.write(`mesh correctness: ${JSON.stringify(correctness)}\n`);
      stdout.write(`mesh appearance: ${JSON.stringify(appearance)}\n`);
      expect(correctness.max).toBeLessThanOrEqual(0.5);
      expect(appearance.max).toBeLessThanOrEqual(22);
      expect(appearance.p99).toBeLessThanOrEqual(21);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
