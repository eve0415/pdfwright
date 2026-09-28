import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertMeshShadings } from './convertMeshes.ts';
import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');

const lab = (channels: readonly number[]): readonly number[] => {
  const pcs = toPcs(channels);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};

const lowDepthMesh = (bits: 1 | 2 | 4, color: readonly number[]): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const [x, y] of [
    [0, 0],
    [100, 0],
    [0, 100],
  ]) {
    writer.write(2, 0);
    writer.write(8, x ?? 0);
    writer.write(8, y ?? 0);
    for (const value of color) writer.write(bits, value);
    writer.alignByte();
  }
  const meshBytes = latin1Text(writer.finish(1024));
  return buildPdf([
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
            `/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent ${String(bits)}/BitsPerFlag 2/Decode[0 100 0 100 0 1 0 1 0 1]`,
            meshBytes,
          ),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;
};

const transicc = async (rgb: readonly number[]): Promise<number[]> => {
  const sourcePath = fileURLToPath(new URL('../../../../tests/fixtures/icc/sRGB.icm', import.meta.url));
  const destinationPath = fileURLToPath(new URL('../../../../tests/fixtures/icc/fogra28l.icc', import.meta.url));
  const child = spawn('transicc', ['-n', `-i${sourcePath}`, `-o${destinationPath}`, '-t1', '-b', '-c0']);
  child.stdin.end(`${rgb.map(value => value * 255).join(' ')}\n`);
  const [output, closed] = await Promise.all([streamText(child.stdout), once(child, 'close')]);
  expect(closed[0]).toBe(0);
  return output
    .trim()
    .split(/\s+/u)
    .map(value => Number(value) / 100);
};

const triangle = (): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const [x, y, red, green, blue] of [
    [0, 0, 255, 0, 0],
    [100, 0, 0, 255, 0],
    [0, 100, 0, 0, 255],
  ]) {
    writer.write(2, 0);
    for (const value of [x, y, red, green, blue]) writer.write(8, value ?? 0);
    writer.alignByte();
  }
  return writer.finish(1024);
};

const triangleData = latin1Text(triangle());

const pdf = buildPdf([
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
          '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1 0 1 0 1]',
          triangleData,
        ),
      },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const meshPatternPdf = buildPdf([
  {
    xref: 'classic',
    objects: [
      { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Pattern<</P 6 0 R>>>>>>' },
      { number: 4, body: streamBody('', '/Pattern cs /P scn 0 0 100 100 re f') },
      {
        number: 5,
        body: streamBody(
          '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1 0 1 0 1]',
          triangleData,
        ),
      },
      { number: 6, body: '<</Type/Pattern/PatternType 2/Shading 5 0 R>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const lattice = (): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const vertex of [
    [0, 0, 255, 0, 0],
    [100, 0, 0, 255, 0],
    [0, 100, 0, 0, 255],
    [100, 100, 255, 255, 255],
  ]) {
    for (const value of vertex) writer.write(8, value);
  }
  return writer.finish(1024);
};

const writePatch = (writer: MeshBitWriter, type: 6 | 7, flag: 0 | 1): void => {
  writer.write(2, flag);
  let points = type === 6 ? 8 : 12;
  if (flag === 0) points = type === 6 ? 12 : 16;
  for (let point = 0; point < points; point++) {
    writer.write(8, point * 5);
    writer.write(8, point * 3);
  }
  const colors =
    flag === 0
      ? [
          [255, 0, 0],
          [0, 255, 0],
          [0, 0, 255],
          [255, 255, 255],
        ]
      : [
          [0, 0, 255],
          [255, 255, 255],
        ];
  for (const color of colors) for (const value of color) writer.write(8, value);
  writer.alignByte();
};

const patch = (type: 6 | 7, joined = false): Uint8Array => {
  const writer = new MeshBitWriter();
  writePatch(writer, type, 0);
  if (joined) writePatch(writer, type, 1);
  return writer.finish(1024);
};

const secondPatchFlag = (data: Uint8Array, type: 6 | 7): number => {
  const reader = new MeshBitReader(data);
  reader.read(2);
  for (let index = 0; index < (type === 6 ? 12 : 16) * 2 + 16; index++) reader.read(8);
  reader.alignByte();
  return reader.read(2);
};

const meshPdf = (type: 5 | 6 | 7, data: Uint8Array): Uint8Array => {
  const flag = type === 5 ? '/VerticesPerRow 2' : '/BitsPerFlag 2';
  return buildPdf([
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
            `/ShadingType ${String(type)}/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8${flag}/Decode[0 100 0 100 0 1 0 1 0 1]`,
            latin1Text(data),
          ),
        },
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;
};

const functionTriangle = (): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const vertex of [
    [0, 0, 0],
    [100, 0, 128],
    [0, 100, 255],
  ]) {
    writer.write(2, 0);
    for (const value of vertex) writer.write(8, value);
    writer.alignByte();
  }
  return writer.finish(1024);
};

const functionTriangleData = latin1Text(functionTriangle());

const functionMeshPdf = buildPdf([
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
          '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1]/Function 6 0 R',
          functionTriangleData,
        ),
      },
      { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

const stitchedMeshPdf = buildPdf([
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
          '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1]/Function 6 0 R',
          functionTriangleData,
        ),
      },
      { number: 6, body: '<</FunctionType 3/Domain[0 1]/Functions[7 0 R 8 0 R]/Bounds[0.5]/Encode[0 1 0 1]>>' },
      { number: 7, body: '<</FunctionType 2/Domain[0 1]/C0[1 0 0]/C1[1 0 0]/N 1>>' },
      { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0 0 1]/C1[0 0 1]/N 1>>' },
    ],
    trailer: '/Root 1 0 R',
  },
]);

interface MeshInfo {
  readonly data: Uint8Array;
  readonly colorSpace: string;
  readonly decodeLength: number;
  readonly componentBits: number;
}

const mesh = (document: ReturnType<typeof loadDocument>): MeshInfo => {
  const shading = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) throw new Error('mesh shading is missing');
  const data = decodedData(internals, shading);
  const color = shading.dictionary.get(pdfName('ColorSpace').bytes);
  const decode = shading.dictionary.get(pdfName('Decode').bytes);
  const componentBits = shading.dictionary.get(pdfName('BitsPerComponent').bytes);
  if (typeof data === 'string' || color?.kind !== 'name' || decode?.kind !== 'array' || componentBits?.kind !== 'integer') {
    throw new Error('converted mesh is invalid');
  }
  return { data, colorSpace: new TextDecoder('latin1').decode(color.bytes), decodeLength: decode.items.length, componentBits: componentBits.value };
};

const meshFunction = (document: ReturnType<typeof loadDocument>): ((input: readonly number[]) => number[]) => {
  const shading = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) throw new Error('mesh shading is missing');
  const reference = shading.dictionary.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') throw new Error('mesh function is missing');
  const functionStream = document.get(reference);
  if (functionStream.kind !== 'stream') throw new Error('sampled mesh function is missing');
  const data = decodedData(internals, functionStream);
  if (typeof data === 'string') throw new Error(data);
  return createPdfFunction({ kind: 'stream', dictionary: functionStream.dictionary, data });
};

const closeChannels = (actual: readonly number[], expected: Float64Array): boolean[] =>
  actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 0.005);

const meshStop = (document: ReturnType<typeof loadDocument>): number => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'stream') throw new Error('mesh is missing');
  const reference = shading.dictionary.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') throw new Error('mesh Function is missing');
  const functionObject = document.get(reference);
  if (functionObject.kind !== 'dictionary') throw new Error('stitching Function is missing');
  const bounds = functionObject.entries.get(pdfName('Bounds').bytes);
  if (bounds?.kind !== 'array') throw new Error('mesh stop is missing');
  const [stop] = bounds.items;
  if (stop?.kind !== 'real' || typeof stop.value !== 'number') throw new Error('mesh stop is invalid');
  return stop.value;
};

describe('mesh shading conversion', () => {
  it.each([
    { bits: 1, color: [0, 1, 1] },
    { bits: 2, color: [2, 1, 0] },
    { bits: 4, color: [12, 3, 2] },
  ] as const)('promotes $bits-bit converted vertex colours to eight bits', async ({ bits, color }) => {
    const document = loadDocument(lowDepthMesh(bits, color));
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(converted.componentBits).toBe(8);
    const reader = new MeshBitReader(converted.data);
    reader.read(2);
    reader.read(8);
    reader.read(8);
    const actual = Array.from({ length: 4 }, () => reader.read(8) / 255);
    const expected = await transicc(color.map(value => value / (2 ** bits - 1)));
    expect(deltaE2000(lab(actual), lab(expected))).toBeLessThanOrEqual(0.5);
  });

  it('converts a mesh named by a shading pattern', () => {
    const document = loadDocument(meshPatternPdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(mesh(document).colorSpace).toBe('DeviceCMYK');
    expect(report.meshes).toBe(1);
  });

  it('converts Type 4 vertex RGB samples and keeps flags and coordinates', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    const reader = new MeshBitReader(converted.data);
    const first = [reader.read(2), reader.read(8), reader.read(8), reader.read(8), reader.read(8), reader.read(8), reader.read(8)];
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(4);
    transform.convertRow8(Uint8Array.of(255, 0, 0), expected, 1);
    expect(report.meshes).toBe(1);
    expect(converted.colorSpace).toBe('DeviceCMYK');
    expect(converted.decodeLength).toBe(12);
    expect(first).toStrictEqual([0, 0, 0, ...expected]);
  });

  it.each([
    { type: 5, input: lattice(), bytes: 24 },
    { type: 6, input: patch(6), bytes: 41 },
    { type: 7, input: patch(7), bytes: 49 },
  ] as const)('converts Type $type mesh colour fields', ({ type, input, bytes }) => {
    const document = loadDocument(meshPdf(type, input));
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(report.meshes).toBe(1);
    expect(converted.colorSpace).toBe('DeviceCMYK');
    expect(converted.data).toHaveLength(bytes);
  });

  it.each([
    { type: 6, bytes: 66 },
    { type: 7, bytes: 82 },
  ] as const)('keeps a shared-edge flag in Type $type', ({ type, bytes }) => {
    const document = loadDocument(meshPdf(type, patch(type, true)));
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(converted.data).toHaveLength(bytes);
    expect(secondPatchFlag(converted.data, type)).toBe(1);
  });

  it('composes a Type 4 parametric Function and retains vertex data', () => {
    const document = loadDocument(functionMeshPdf.bytes);
    const before = mesh(document);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const after = mesh(document);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Float64Array(4);
    transform.convert(Float64Array.of(0.5, 0, 0.5), expected);
    expect(report.meshes).toBe(1);
    expect(after.data).toStrictEqual(before.data);
    expect(after.decodeLength).toBe(6);
    expect(closeChannels(meshFunction(document)([0.5]), expected)).toStrictEqual([true, true, true, true]);
  });

  it('preserves a Type 3 parametric mesh colour stop', () => {
    const document = loadDocument(stitchedMeshPdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.meshes).toBe(1);
    expect(meshStop(document)).toBe(0.5);
  });

  it.each([
    { name: 'free-form', bytes: pdf.bytes },
    { name: 'lattice', bytes: meshPdf(5, lattice()) },
    { name: 'Coons', bytes: meshPdf(6, patch(6, true)) },
    { name: 'tensor', bytes: meshPdf(7, patch(7, true)) },
    { name: 'parametric', bytes: functionMeshPdf.bytes },
    { name: 'stitched', bytes: stitchedMeshPdf.bytes },
  ])('writes a valid $name mesh file', async ({ bytes }) => {
    const document = loadDocument(bytes);
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const directory = await mkdtemp(path.join(tmpdir(), 'pdfwright-mesh-'));
    try {
      const file = path.join(directory, 'converted.pdf');
      await writeFile(file, document.save().toBytes());
      const child = spawn('qpdf', ['--check', file]);
      const events: readonly unknown[] = await once(child, 'close');
      expect(events.at(0)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
