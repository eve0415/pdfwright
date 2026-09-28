import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stdout } from 'node:process';
import { text as streamText } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { decodedData } from '../font/fontValues.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
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
const lab = (channels: readonly number[] | Float64Array): readonly number[] => {
  const pcs = toPcs([...channels]);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};

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

const meshPdf = (colorSpace: 'DeviceRGB' | 'DeviceCMYK', data: Uint8Array, bits?: { coordinate: number; flag: number }) =>
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
            `/ShadingType 4/ColorSpace/${colorSpace}/BitsPerCoordinate ${String(bits?.coordinate ?? 8)}/BitsPerComponent 8/BitsPerFlag ${String(bits?.flag ?? 2)}/Decode[0 100 0 100 0 1 0 1 0 1${colorSpace === 'DeviceCMYK' ? ' 0 1' : ''}]`,
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

const transiccVertices = async (vertices: readonly (readonly number[])[]): Promise<readonly number[][]> => {
  const child = spawn('transicc', ['-n', `-i${sourcePath}`, `-o${destinationPath}`, '-t1', '-b', '-c0']);
  child.stdin.end(`${vertices.map(vertex => vertex.join(' ')).join('\n')}\n`);
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

interface MeshBytes {
  readonly data: Uint8Array;
  readonly compressedBytes: number;
}

const convertedMeshBytes = (pdf: Uint8Array): MeshBytes => {
  const document = loadDocument(pdf);
  const shading = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) throw new Error('mesh is missing');
  const type = shading.dictionary.get(pdfName('ShadingType').bytes);
  if (type?.kind !== 'integer' || type.value !== 4) throw new Error('converted mesh is not Type 4');
  const data = decodedData(internals, shading);
  if (typeof data === 'string') throw new Error(data);
  return { data, compressedBytes: shading.data.length };
};

interface MeshVertex {
  readonly x: number;
  readonly y: number;
  readonly color: readonly number[];
}

const verticesOf = (data: Uint8Array): readonly MeshVertex[] => {
  if (data.length % 9 !== 0) throw new Error('converted mesh record size is invalid');
  const vertices: MeshVertex[] = [];
  for (let offset = 0; offset < data.length; offset += 9) {
    const x = (((data[offset + 1] ?? 0) * 256 + (data[offset + 2] ?? 0)) / 65535) * 100;
    const y = (((data[offset + 3] ?? 0) * 256 + (data[offset + 4] ?? 0)) / 65535) * 100;
    const color = [...data.subarray(offset + 5, offset + 9)].map(value => value / 255);
    vertices.push({ x, y, color });
  }
  return vertices;
};

const rgbAt = (x: number, y: number): readonly number[] => {
  const extent = (100 * 100) / 255;
  return [Math.max(0, 1 - x / extent - y / extent), Math.min(1, x / extent), Math.min(1, y / extent)];
};

const transiccReference = async (data: Uint8Array): Promise<Uint8Array> => {
  const vertices = verticesOf(data);
  const colors = await transiccVertices(vertices.map(vertex => rgbAt(vertex.x, vertex.y).map(value => value * 255)));
  expect(colors).toHaveLength(vertices.length);
  const reference = Uint8Array.from(data);
  for (let index = 0; index < vertices.length; index++) {
    reference.set(colors[index] ?? [], index * 9 + 5);
  }
  return reference;
};

const interpolationError = (data: Uint8Array, width: number, height: number): number => {
  const vertices = verticesOf(data);
  const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
  let maximum = 0;
  for (let row = 0; row < height; row++) {
    const y = (height - row - 0.5) * (100 / height);
    if (y <= 1.5) continue;
    for (let column = 0; column < width; column++) {
      const x = (column + 0.5) * (100 / width);
      if (x <= 1.5 || x + y >= (100 * 100) / 255 - 1.5 * Math.SQRT2) continue;
      const exact = new Float64Array(4);
      transform.convert(Float64Array.from(rgbAt(x, y)), exact);
      for (let index = 0; index < vertices.length; index += 3) {
        const a = vertices[index];
        const b = vertices[index + 1];
        const c = vertices[index + 2];
        if (a === undefined || b === undefined || c === undefined) throw new Error('triangle is incomplete');
        const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        if (Math.abs(determinant) < 1e-9) continue;
        const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / determinant;
        const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / determinant;
        const wc = 1 - wa - wb;
        if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) continue;
        const interpolated = Array.from(
          { length: 4 },
          (_, channel) => wa * (a.color[channel] ?? 0) + wb * (b.color[channel] ?? 0) + wc * (c.color[channel] ?? 0),
        );
        maximum = Math.max(maximum, deltaE2000(lab(exact), lab(interpolated)));
        break;
      }
    }
  }
  return maximum;
};

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly samples: Uint8Array;
}

const render = async (directory: string, config: { name: string; bytes: Uint8Array; dpi?: number }): Promise<Raster> => {
  const { name, bytes, dpi = 100 } = config;
  const input = path.join(directory, `${name}.pdf`);
  const output = path.join(directory, `${name}.pam`);
  await writeFile(input, bytes);
  const child = spawn('gs', [
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pamcmyk32',
    `-r${String(dpi)}`,
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

const measure = (before: Raster, after: Raster, interior = false) => {
  expect([before.width, before.height]).toStrictEqual([after.width, after.height]);
  expect(before.samples).toHaveLength(before.width * before.height * 4);
  expect(after.samples).toHaveLength(after.width * after.height * 4);
  const differences: number[] = [];
  let sourcePixels = 0;
  let convertedPixels = 0;
  for (let offset = 0; offset < before.samples.length; offset += 4) {
    if (interior) {
      const pixel = offset / 4;
      const x = ((pixel % before.width) + 0.5) * (100 / before.width);
      const y = (before.height - Math.floor(pixel / before.width) - 0.5) * (100 / before.height);
      if (x <= 1.5 || y <= 1.5 || x + y >= (100 * 100) / 255 - 1.5 * Math.SQRT2) continue;
    }
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
      const appearance = await render(directory, { name: 'transparency-rgb', bytes: original });
      const reference = await render(directory, { name: 'transparency-cmyk-group', bytes: transparency('/CS/DeviceCMYK').bytes });
      const converted = await render(directory, { name: 'transparency-converted', bytes: convertTransparency(original) });
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
      const before = await render(directory, { name: 'implicit-group-before', bytes: original });
      const after = await render(directory, { name: 'implicit-group-after', bytes: convertTransparency(original) });
      expect(measure(before, after).max).toBeLessThanOrEqual(0.5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the converted mesh close to the RGB render at 400 dpi', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-render-'));
    try {
      const original = meshPdf('DeviceRGB', mesh(rgbVertices)).bytes;
      const before = await render(directory, { name: 'mesh-rgb', bytes: original, dpi: 400 });
      const converted = convertMesh(original);
      const meshData = convertedMeshBytes(converted);
      const { data } = meshData;
      const reference = meshPdf('DeviceCMYK', await transiccReference(data), { coordinate: 16, flag: 8 }).bytes;
      const oracle = await render(directory, { name: 'mesh-cmyk-reference', bytes: reference, dpi: 400 });
      const after = await render(directory, { name: 'mesh-converted', bytes: converted, dpi: 400 });
      const correctness = measure(oracle, after, true);
      const appearance = measure(before, after, true);
      const fidelity = interpolationError(data, after.width, after.height);
      stdout.write(`mesh triangles: ${String(data.length / 27)}, raw bytes: ${String(data.length)}, compressed bytes: ${String(meshData.compressedBytes)}\n`);
      stdout.write(`mesh output bytes: ${String(converted.length)}\n`);
      stdout.write(`mesh correctness: ${JSON.stringify(correctness)}\n`);
      stdout.write(`mesh appearance: ${JSON.stringify(appearance)}\n`);
      stdout.write(`mesh renderer-free fidelity: ${String(fidelity)}\n`);
      expect(correctness.max).toBeLessThanOrEqual(0.5);
      expect(appearance.max).toBeLessThanOrEqual(2);
      expect(appearance.p99).toBeLessThanOrEqual(1.2);
      expect(fidelity).toBeLessThanOrEqual(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
