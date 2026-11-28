import type { LoadedDocument } from '../document/loadDocument.ts';
import type { PdfFunction } from '../function/pdfFunction.ts';
import type { PdfDirectObject, PdfObject } from '../object/pdfObject.ts';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text as streamText } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';
import { ValidationError } from '../error/validationError.ts';
import { decodedData } from '../font/fontValues.ts';
import { createPdfFunction } from '../function/pdfFunction.ts';
import { parseIccProfile } from '../icc/iccProfile.ts';
import { pdfName, pdfReference } from '../object/pdfObject.ts';
import { buildPdf, latin1Text, streamBody } from '../testing/pdfBuilder.ts';

import { convertMeshShadings } from './convertMeshes.ts';
import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';
import { convertMeshSamples } from './meshSamples.ts';
import { subdivideMesh } from './meshSubdivision.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));
const source = parseIccProfile(await fixture('sRGB.icm'));
const destination = parseIccProfile(await fixture('fogra28l.icc'));
const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');

const lab = (channels: ReadonlyArray<number> | Float64Array): ReadonlyArray<number> => {
  const pcs = toPcs([...channels]);
  return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
};

const lowDepthMesh = (bits: 1 | 2 | 4, color: ReadonlyArray<number>): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const [x, y] of [
    [0, 0],
    [100, 0],
    [0, 100],
  ]) {
    writer.write(2, 0);
    writer.write(8, x ?? 0);
    writer.write(8, y ?? 0);
    for (const value of color) {
      writer.write(bits, value);
    }
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

const transicc = async (rgb: ReadonlyArray<number>): Promise<Array<number>> => {
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
    for (const value of [x, y, red, green, blue]) {
      writer.write(8, value ?? 0);
    }
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
    for (const value of vertex) {
      writer.write(8, value);
    }
  }
  return writer.finish(1024);
};

const writePatch = (writer: MeshBitWriter, type: 6 | 7, flag: 0 | 1): void => {
  writer.write(2, flag);
  let points = type === 6 ? 8 : 12;
  if (flag === 0) {
    points = type === 6 ? 12 : 16;
  }
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
  for (const color of colors) {
    for (const value of color) {
      writer.write(8, value);
    }
  }
  writer.alignByte();
};

const patch = (type: 6 | 7, joined = false): Uint8Array => {
  const writer = new MeshBitWriter();
  writePatch(writer, type, 0);
  if (joined) {
    writePatch(writer, type, 1);
  }
  return writer.finish(1024);
};

const rectangularPatch = (type: 6 | 7, saturated = false): Uint8Array => {
  const writer = new MeshBitWriter();
  writer.write(2, 0);
  const boundary = [
    [0, 0],
    [0, 33],
    [0, 67],
    [0, 100],
    [33, 100],
    [67, 100],
    [100, 100],
    [100, 67],
    [100, 33],
    [100, 0],
    [67, 0],
    [33, 0],
  ];
  const interior =
    type === 7
      ? [
          [33, 33],
          [33, 67],
          [67, 67],
          [67, 33],
        ]
      : [];
  for (const coordinates of [...boundary, ...interior]) {
    writer.write(8, coordinates[0] ?? 0);
    writer.write(8, coordinates[1] ?? 0);
  }
  const colors = saturated
    ? [
        [255, 0, 0],
        [0, 255, 0],
        [255, 255, 255],
        [0, 0, 255],
      ]
    : [
        [204, 51, 26],
        [204, 77, 26],
        [230, 102, 26],
        [230, 51, 26],
      ];
  for (const color of colors) {
    for (const component of color) {
      writer.write(8, component);
    }
  }
  writer.alignByte();
  return writer.finish(1024);
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
    for (const value of vertex) {
      writer.write(8, value);
    }
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
  readonly shadingType: number;
}

const mesh = (document: ReturnType<typeof loadDocument>): MeshInfo => {
  const shading = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) {
    throw new Error('mesh shading is missing');
  }
  const data = decodedData(internals, shading);
  const color = shading.dictionary.get(pdfName('ColorSpace').bytes);
  const decode = shading.dictionary.get(pdfName('Decode').bytes);
  const componentBits = shading.dictionary.get(pdfName('BitsPerComponent').bytes);
  const shadingType = shading.dictionary.get(pdfName('ShadingType').bytes);
  if (typeof data === 'string' || color?.kind !== 'name' || decode?.kind !== 'array' || componentBits?.kind !== 'integer' || shadingType?.kind !== 'integer') {
    throw new Error('converted mesh is invalid');
  }
  return {
    data,
    colorSpace: new TextDecoder('latin1').decode(color.bytes),
    decodeLength: decode.items.length,
    componentBits: componentBits.value,
    shadingType: shadingType.value,
  };
};

const triangleVertices = (data: Uint8Array): ReadonlyArray<{ readonly x: number; readonly y: number; readonly color: ReadonlyArray<number> }> => {
  const reader = new MeshBitReader(data);
  const vertices: Array<{ x: number; y: number; color: Array<number> }> = [];
  while (reader.remainingBits > 0) {
    const flag = reader.read(8);
    const x = reader.read(16);
    const y = reader.read(16);
    const color = Array.from({ length: 4 }, () => reader.read(8));
    if (flag !== 0) {
      throw new Error('emitted triangle has an unexpected edge flag');
    }
    vertices.push({ x, y, color });
  }
  return vertices;
};

const sourceCorner = (data: Uint8Array): ReadonlyArray<number> => {
  const corner = triangleVertices(data).find(vertex => vertex.x === 0 && vertex.y === 0);
  if (corner === undefined) {
    throw new Error('source corner is missing');
  }
  return corner.color;
};

const cornerCoordinates = (vertices: ReadonlyArray<{ readonly x: number; readonly y: number }>): ReadonlySet<string> =>
  new Set(
    vertices
      .values()
      .filter(vertex => (vertex.x === 0 || vertex.x === 25_700) && (vertex.y === 0 || vertex.y === 25_700))
      .map(vertex => `${String(vertex.x)},${String(vertex.y)}`),
  );

const decodeCoordinate = (raw: number): number => (raw / 65_535) * 100;

const interpolatedAt = (data: Uint8Array, x: number, y: number): ReadonlyArray<number> => {
  const vertices = triangleVertices(data);
  for (let index = 0; index < vertices.length; index += 3) {
    const a = vertices[index];
    const b = vertices[index + 1];
    const c = vertices[index + 2];
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('triangle is incomplete');
    }
    const ax = decodeCoordinate(a.x);
    const ay = decodeCoordinate(a.y);
    const bx = decodeCoordinate(b.x);
    const by = decodeCoordinate(b.y);
    const cx = decodeCoordinate(c.x);
    const cy = decodeCoordinate(c.y);
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-9) {
      continue;
    }
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
    const wc = 1 - wa - wb;
    if (wa < -1e-5 || wb < -1e-5 || wc < -1e-5) {
      continue;
    }
    return Array.from({ length: 4 }, (_, channel) => (wa * (a.color[channel] ?? 0) + wb * (b.color[channel] ?? 0) + wc * (c.color[channel] ?? 0)) / 255);
  }
  throw new Error('sample point is outside the converted patch');
};

const meshFunction = (document: ReturnType<typeof loadDocument>): ((input: ReadonlyArray<number>) => Array<number>) => {
  const shading = document.get(pdfReference(5, 0));
  const internals = internalsOf(document);
  if (shading.kind !== 'stream' || internals === undefined) {
    throw new Error('mesh shading is missing');
  }
  const reference = shading.dictionary.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('mesh function is missing');
  }
  const functionStream = document.get(reference);
  if (functionStream.kind !== 'stream') {
    throw new Error('sampled mesh function is missing');
  }
  const data = decodedData(internals, functionStream);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return createPdfFunction({ kind: 'stream', dictionary: functionStream.dictionary, data });
};

const closeChannels = (actual: ReadonlyArray<number>, expected: Float64Array): Array<boolean> =>
  actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 0.005);

const meshStop = (document: ReturnType<typeof loadDocument>): number => {
  const shading = document.get(pdfReference(5, 0));
  if (shading.kind !== 'stream') {
    throw new Error('mesh is missing');
  }
  const reference = shading.dictionary.get(pdfName('Function').bytes);
  if (reference?.kind !== 'reference') {
    throw new Error('mesh Function is missing');
  }
  const functionObject = document.get(reference);
  if (functionObject.kind !== 'dictionary') {
    throw new Error('stitching Function is missing');
  }
  const bounds = functionObject.entries.get(pdfName('Bounds').bytes);
  if (bounds?.kind !== 'array') {
    throw new Error('mesh stop is missing');
  }
  const [stop] = bounds.items;
  if (stop?.kind !== 'real' || typeof stop.value !== 'number') {
    throw new Error('mesh stop is invalid');
  }
  return stop.value;
};

const rgbTransform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });

const cmykOf = (...rgb: ReadonlyArray<number>): Float64Array => {
  const output = new Float64Array(4);
  rgbTransform.convert(Float64Array.from(rgb), output);
  return output;
};

const row8 = (rgb: ReadonlyArray<number>): Array<number> => {
  const output = new Uint8Array(4);
  rgbTransform.convertRow8(Uint8Array.from(rgb), output, 1);
  return [...output];
};

const close = (actual: ReadonlyArray<number>, expected: Float64Array): boolean =>
  actual.length === expected.length && actual.every((value, index) => Math.abs(value - (expected[index] ?? Number.NaN)) <= 0.005);

interface PatchRecord {
  readonly flag: 0 | 1 | 2 | 3;
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly colors: ReadonlyArray<readonly [number, number, number]>;
}

const patchData = (records: ReadonlyArray<PatchRecord>): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const record of records) {
    writer.write(2, record.flag);
    for (const [x, y] of record.points) {
      writer.write(8, x);
      writer.write(8, y);
    }
    for (const color of record.colors) {
      for (const value of color) {
        writer.write(8, value);
      }
    }
    writer.alignByte();
  }
  return writer.finish(4096);
};

/** Two patches, the second either joined to the first by an edge flag or written out in full with the points and colours ISO 32000-1:2008, 8.7.4.5.7 Table 85 says the flag implies. */
const sharedPatches = (type: 6 | 7, flag: 1 | 2 | 3, explicit: boolean): Uint8Array => {
  const count = type === 6 ? 12 : 16;
  const first: PatchRecord = {
    flag: 0,
    points: Array.from({ length: count }, (_, index) => [index * 5, index * 3] as const),
    colors: [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ],
  };
  const newPoints = Array.from({ length: count - 4 }, (_, index) => [(100 + index * 7) % 256, (50 + index * 11) % 256] as const);
  const newColors = [
    [255, 255, 0],
    [0, 255, 255],
  ] as const;
  if (!explicit) {
    return patchData([first, { flag, points: newPoints, colors: newColors }]);
  }
  // Flag f shares boundary points 3f to 3f + 3 of the previous patch, counted round its twelve boundary points, and its corner colours f and f + 1.
  const shared = Array.from({ length: 4 }, (_, index) => first.points[(flag * 3 + index) % 12] ?? ([0, 0] as const));
  const sharedColors = [first.colors[flag] ?? ([0, 0, 0] as const), first.colors[(flag + 1) % 4] ?? ([0, 0, 0] as const)];
  return patchData([first, { flag: 0, points: [...shared, ...newPoints], colors: [...sharedColors, ...newColors] }]);
};

const decodedObject = (document: LoadedDocument, object: PdfObject): PdfObject => {
  const internals = internalsOf(document);
  if (internals === undefined) {
    throw new Error('document internals are missing');
  }
  if (object.kind !== 'stream') {
    return object;
  }
  const data = decodedData(internals, object);
  if (typeof data === 'string') {
    throw new TypeError(data);
  }
  return { kind: 'stream', dictionary: object.dictionary, data };
};

/** Reads the written mesh Function, following and decoding the indirect children of a Type 3 function. */
const writtenMeshFunction = (document: LoadedDocument): PdfFunction => {
  const shading = document.get(pdfReference(5, 0));
  const value = shading.kind === 'stream' ? shading.dictionary.get(pdfName('Function').bytes) : undefined;
  if (value === undefined) {
    throw new Error('mesh Function is missing');
  }
  const resolve = (item: PdfDirectObject): PdfObject => decodedObject(document, item.kind === 'reference' ? document.get(item) : item);
  return createPdfFunction(resolve(value), resolve);
};

const shadingPdf = (dictionary: string, data: Uint8Array, objects: ReadonlyArray<{ readonly number: number; readonly body: string }> = []): Uint8Array =>
  buildPdf([
    {
      xref: 'classic',
      objects: [
        { number: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { number: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { number: 3, body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Shading<</Sh1 5 0 R>>>>>>' },
        { number: 4, body: streamBody('', '/Sh1 sh') },
        { number: 5, body: streamBody(dictionary, latin1Text(data)) },
        ...objects,
      ],
      trailer: '/Root 1 0 R',
    },
  ]).bytes;

interface VertexInput {
  readonly flag?: number;
  readonly x: number;
  readonly y: number;
  readonly color: ReadonlyArray<number>;
}

/** Writes free-form or lattice vertex records, with a 2-bit edge flag unless the records are unflagged. */
const vertexData = (vertices: ReadonlyArray<VertexInput>, config: { readonly componentBits?: number; readonly flagged?: boolean } = {}): Uint8Array => {
  const writer = new MeshBitWriter();
  for (const vertex of vertices) {
    if (config.flagged ?? true) {
      writer.write(2, vertex.flag ?? 0);
    }
    writer.write(8, vertex.x);
    writer.write(8, vertex.y);
    for (const value of vertex.color) {
      writer.write(config.componentBits ?? 8, value);
    }
    writer.alignByte();
  }
  return writer.finish(4096);
};

const rgbDictionary = (type: 4 | 5 | 6 | 7, entries = ''): string =>
  `/ShadingType ${String(type)}/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8${type === 5 ? '/VerticesPerRow 2' : '/BitsPerFlag 2'}/Decode[0 100 0 100 0 1 0 1 0 1]${entries}`;

const rgbTriangle: ReadonlyArray<VertexInput> = [
  { x: 0, y: 0, color: [255, 0, 0] },
  { x: 100, y: 0, color: [0, 255, 0] },
  { x: 0, y: 100, color: [0, 0, 255] },
];

interface MeshRecord {
  readonly flag: number;
  readonly x: number;
  readonly y: number;
  readonly color: ReadonlyArray<number>;
}

const meshRecords = (
  data: Uint8Array,
  layout: { readonly flagBits: number; readonly coordinateBits: number; readonly componentBits: number },
): ReadonlyArray<MeshRecord> => {
  const reader = new MeshBitReader(data);
  const records: Array<MeshRecord> = [];
  while (reader.remainingBits > 0) {
    const flag = reader.read(layout.flagBits);
    const x = reader.read(layout.coordinateBits);
    const y = reader.read(layout.coordinateBits);
    const color = Array.from({ length: 4 }, () => reader.read(layout.componentBits));
    reader.alignByte();
    records.push({ flag, x, y, color });
  }
  return records;
};

const calGray = '[/CalGray<</WhitePoint[0.9505 1 1.089]/Gamma 2.2>>]';
const calGrayTransform = createColorTransform({ kind: 'calGray', whitePoint: { x: 0.9505, y: 1, z: 1.089 }, gamma: 2.2 }, destination, {
  intent: 'relativeColorimetric',
  blackPointCompensation: true,
});

const calGray8 = (sample: number): Array<number> => {
  const output = new Float64Array(4);
  calGrayTransform.convert(Float64Array.of(sample / 255), output);
  return [...output].map(value => Math.round(value * 255));
};

const shadingValue = (document: LoadedDocument, key: string): PdfDirectObject | undefined => {
  const shading = document.get(pdfReference(5, 0));
  return shading.kind === 'stream' ? shading.dictionary.get(pdfName(key).bytes) : undefined;
};

/** Converts the document and names the result, so a table can hold both converted and refused rows. */
const outcome = (document: LoadedDocument, summary: (report: ReturnType<typeof convertMeshShadings>) => string): string => {
  try {
    return summary(convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination }));
  } catch (error) {
    if (error instanceof ValidationError) {
      return `ValidationError ${error.reason ?? ''}`;
    }
    if (error instanceof ResourceLimitError) {
      return 'ResourceLimitError';
    }
    throw error;
  }
};

describe('mesh shading conversion', () => {
  it('rejects an over-budget source before converting every vertex', () => {
    const sourceTriangle = triangle();
    const data = new Uint8Array(sourceTriangle.length * 100);
    for (let index = 0; index < 100; index++) {
      data.set(sourceTriangle, index * sourceTriangle.length);
    }
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const convert = vi.spyOn(transform, 'convert');
    expect(() =>
      subdivideMesh(data, {
        type: 4,
        coordinateBits: 8,
        componentBits: 8,
        flagBits: 2,
        decode: [0, 100, 0, 100, 0, 1, 0, 1, 0, 1],
        transform,
        destination,
        maxBytes: 54,
      }),
    ).toThrow(ResourceLimitError);
    expect(convert.mock.calls.length).toBeLessThan(30);
  });

  it.each([
    { bits: 1, color: [0, 1, 1] },
    { bits: 2, color: [2, 1, 0] },
    { bits: 4, color: [12, 3, 2] },
  ] as const)('promotes $bits-bit converted vertex colours to eight bits', async ({ bits, color }) => {
    const document = loadDocument(lowDepthMesh(bits, color));
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(converted.componentBits).toBe(8);
    expect(converted.data).toHaveLength(27);
    const actual = sourceCorner(converted.data).map(value => value / 255);
    const expected = await transicc(color.map(value => value / (2 ** bits - 1)));
    expect(deltaE2000(lab(actual), lab(expected))).toBeLessThanOrEqual(0.5);
  });

  it('converts a mesh named by a shading pattern', () => {
    const document = loadDocument(meshPatternPdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(mesh(document).colorSpace).toBe('DeviceCMYK');
    expect(report.meshes).toBe(1);
  });

  it('converts Type 4 RGB samples into triangles containing the source corners', () => {
    const document = loadDocument(pdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    const corner = sourceCorner(converted.data);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    const expected = new Uint8Array(4);
    transform.convertRow8(Uint8Array.of(255, 0, 0), expected, 1);
    expect(report.meshes).toBe(1);
    expect(converted.colorSpace).toBe('DeviceCMYK');
    expect(converted.decodeLength).toBe(12);
    expect(converted.shadingType).toBe(4);
    expect(corner).toStrictEqual([...expected]);
  });

  it('converts a Type 5 lattice into the two triangles of each cell', () => {
    const document = loadDocument(meshPdf(5, lattice()));
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(report.meshes).toBe(1);
    expect(converted.colorSpace).toBe('DeviceCMYK');
    expect(converted.shadingType).toBe(4);
    const vertices = triangleVertices(converted.data);
    const corners = [
      { x: 0, y: 0, rgb: [255, 0, 0] },
      { x: 25_700, y: 0, rgb: [0, 255, 0] },
      { x: 0, y: 25_700, rgb: [0, 0, 255] },
      { x: 25_700, y: 25_700, rgb: [255, 255, 255] },
    ];
    expect(corners.map(corner => vertices.find(vertex => vertex.x === corner.x && vertex.y === corner.y)?.color)).toStrictEqual(
      corners.map(corner => row8(corner.rgb)),
    );
    // ISO 32000-1:2008, 8.7.4.5.6: the cell with corners a b (bottom) and c d (top) is the triangles a b c and b c d, so the colour is (|1 - u - v|, u, v).
    let maximum = 0;
    for (let column = 0; column < 8; column++) {
      for (let row = 0; row < 8; row++) {
        const u = (column + 0.5) / 8;
        const v = (row + 0.5) / 8;
        if (Math.abs(u + v - 1) < 0.1) {
          continue;
        }
        const extent = (100 * 100) / 255;
        const actual = interpolatedAt(converted.data, u * extent, v * extent);
        maximum = Math.max(maximum, deltaE2000(lab(actual), lab(cmykOf(Math.abs(1 - u - v), u, v))));
      }
    }
    expect(maximum).toBeLessThanOrEqual(1);
  });

  it.each([
    { type: 6, flag: 1 },
    { type: 6, flag: 2 },
    { type: 6, flag: 3 },
    { type: 7, flag: 1 },
    { type: 7, flag: 2 },
    { type: 7, flag: 3 },
  ] as const)('converts a Type $type patch sharing edge $flag like the same patch written out in full', ({ type, flag }) => {
    const joined = loadDocument(meshPdf(type, sharedPatches(type, flag, false)));
    const explicit = loadDocument(meshPdf(type, sharedPatches(type, flag, true)));
    const single = loadDocument(meshPdf(type, patch(type)));
    for (const document of [joined, explicit, single]) {
      convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    }
    expect(mesh(joined).shadingType).toBe(4);
    expect(mesh(joined).data).toStrictEqual(mesh(explicit).data);
    expect(mesh(joined).data.length).toBeGreaterThan(mesh(single).data.length);
  });

  it.each([6, 7] as const)('preserves the corners of a rectangular Type %i patch', type => {
    const document = loadDocument(meshPdf(type, rectangularPatch(type)));
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    const vertices = triangleVertices(converted.data);
    expect([report.meshes, converted.colorSpace, converted.shadingType]).toStrictEqual([1, 'DeviceCMYK', 4]);
    expect(cornerCoordinates(vertices)).toStrictEqual(new Set(['0,0', '0,25700', '25700,0', '25700,25700']));
  });

  it.each([6, 7] as const)('preserves bilinear RGB colour inside a saturated Type %i patch', type => {
    const document = loadDocument(meshPdf(type, rectangularPatch(type, true)));
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const { data, colorSpace, shadingType } = mesh(document);
    expect([colorSpace, shadingType]).toStrictEqual(['DeviceCMYK', 4]);
    const transform = createColorTransform({ kind: 'icc', profile: source }, destination, { intent: 'relativeColorimetric', blackPointCompensation: true });
    let maximum = 0;
    for (let column = 0; column < 8; column++) {
      for (let row = 0; row < 8; row++) {
        const u = (column + 0.5) / 8;
        const v = (row + 0.5) / 8;
        const extent = (100 * 100) / 255;
        const actual = interpolatedAt(data, u * extent, v * extent);
        const expected = new Float64Array(4);
        transform.convert(Float64Array.of(1 - u - v + 2 * u * v, v, u), expected);
        maximum = Math.max(maximum, deltaE2000(lab(actual), lab(expected)));
      }
    }
    expect(maximum).toBeLessThanOrEqual(1);
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
    // ISO 32000-1:2008, 8.7.4.5.5: the parametric value t selects the colour through the Function, red at 0 and blue at 1.
    expect([close(meshFunction(document)([0]), cmykOf(1, 0, 0)), close(meshFunction(document)([1]), cmykOf(0, 0, 1))]).toStrictEqual([true, true]);
    expect(report.approximations).toStrictEqual([]);
  });

  it('preserves a Type 3 parametric mesh colour stop', () => {
    const document = loadDocument(stitchedMeshPdf.bytes);
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.meshes).toBe(1);
    expect(meshStop(document)).toBe(0.5);
    // ISO 32000-1:2008, 7.10.4: below the bound the first child (red) applies, above it the second (blue).
    const evaluate = writtenMeshFunction(document);
    expect([close(evaluate([0.25]), cmykOf(1, 0, 0)), close(evaluate([0.75]), cmykOf(0, 0, 1))]).toStrictEqual([true, true]);
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
      const events: ReadonlyArray<unknown> = await once(child, 'close');
      expect(events.at(0)).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('converts a CalGray free-form mesh by rewriting only its colour fields', () => {
    const vertices = [
      { flag: 0, x: 0, y: 0, color: [0] },
      { flag: 0, x: 100, y: 0, color: [128] },
      { flag: 0, x: 0, y: 100, color: [255] },
      { flag: 1, x: 100, y: 100, color: [64] },
    ];
    const document = loadDocument(
      shadingPdf(`/ShadingType 4/ColorSpace${calGray}/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1]`, vertexData(vertices)),
    );
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    expect(report.meshes).toBe(1);
    expect([converted.colorSpace, converted.shadingType, converted.componentBits, converted.decodeLength]).toStrictEqual(['DeviceCMYK', 4, 8, 12]);
    // ISO 32000-1:2008, 8.7.4.5.5 Table 84: each record keeps its edge flag and coordinates, and only the colour becomes four CMYK components.
    expect(meshRecords(converted.data, { flagBits: 2, coordinateBits: 8, componentBits: 8 })).toStrictEqual(
      vertices.map(vertex => ({ flag: vertex.flag, x: vertex.x, y: vertex.y, color: calGray8(vertex.color[0] ?? 0) })),
    );
  });

  it.each([
    { name: 'converts a CalGray lattice of whole rows', count: 4, result: 'converted 5 2' },
    { name: 'refuses a CalGray lattice with an incomplete row', count: 3, result: 'ValidationError color-space' },
  ])('$name', ({ count, result }) => {
    const vertices = [
      { x: 0, y: 0, color: [0] },
      { x: 100, y: 0, color: [128] },
      { x: 0, y: 100, color: [255] },
      { x: 100, y: 100, color: [64] },
    ].slice(0, count);
    const document = loadDocument(
      shadingPdf(
        `/ShadingType 5/ColorSpace${calGray}/BitsPerCoordinate 8/BitsPerComponent 8/VerticesPerRow 2/Decode[0 100 0 100 0 1]`,
        vertexData(vertices, { flagged: false }),
      ),
    );
    const perRow = (): string => {
      const value = shadingValue(document, 'VerticesPerRow');
      return value?.kind === 'integer' ? String(value.value) : 'missing';
    };
    expect(outcome(document, () => `converted ${String(mesh(document).shadingType)} ${perRow()}`)).toBe(result);
  });

  it.each([
    { name: 'a 3-bit coordinate', dictionary: rgbDictionary(4).replace('/BitsPerCoordinate 8', '/BitsPerCoordinate 3') },
    { name: 'a 32-bit component', dictionary: rgbDictionary(4).replace('/BitsPerComponent 8', '/BitsPerComponent 32') },
    { name: 'a 1-bit flag', dictionary: rgbDictionary(4).replace('/BitsPerFlag 2', '/BitsPerFlag 1') },
    { name: 'a Decode array of the wrong length', dictionary: rgbDictionary(4).replace('0 1 0 1 0 1]', '0 1 0 1]') },
    { name: 'no ColorSpace', dictionary: rgbDictionary(4).replace('/ColorSpace/DeviceRGB', '') },
  ])('refuses a mesh with $name', ({ dictionary }) => {
    const document = loadDocument(shadingPdf(dictionary, vertexData(rgbTriangle)));
    expect(() => convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(
      expect.objectContaining({ constructor: ValidationError, reason: 'color-space' }),
    );
  });

  it('converts a mesh Background with the vertex colours', () => {
    const document = loadDocument(shadingPdf(rgbDictionary(4, '/Background[0.25 0.5 0.75]'), vertexData(rgbTriangle)));
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const background = shadingValue(document, 'Background');
    const values =
      background?.kind === 'array' ? background.items.map(item => (item.kind === 'real' && typeof item.value === 'number' ? item.value : Number.NaN)) : [];
    expect(close(values, cmykOf(0.25, 0.5, 0.75))).toBe(true);
  });

  it.each([
    { name: 'converts a parametric mesh with one Function per RGB component', functions: '[6 0 R 7 0 R 8 0 R]', result: 'converted true true' },
    { name: 'refuses a parametric mesh whose Function array has two entries for RGB', functions: '[6 0 R 8 0 R]', result: 'ValidationError color-space' },
  ])('$name', ({ functions, result }) => {
    const document = loadDocument(
      shadingPdf(
        `/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1]/Function${functions}`,
        functionTriangle(),
        [
          { number: 6, body: '<</FunctionType 2/Domain[0 1]/C0[1]/C1[0]/N 1>>' },
          { number: 7, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[0]/N 1>>' },
          { number: 8, body: '<</FunctionType 2/Domain[0 1]/C0[0]/C1[1]/N 1>>' },
        ],
      ),
    );
    const endPoints = (): string => {
      const evaluate = writtenMeshFunction(document);
      return `converted ${String(close(evaluate([0]), cmykOf(1, 0, 0)))} ${String(close(evaluate([1]), cmykOf(0, 0, 1)))}`;
    };
    expect(outcome(document, endPoints)).toBe(result);
  });

  it.each([
    { name: 'a Type 4 edge flag of 3', dictionary: rgbDictionary(4), data: vertexData([...rgbTriangle, { flag: 3, x: 100, y: 100, color: [0, 0, 0] }]) },
    {
      name: 'an incomplete Type 4 triangle after a complete one',
      dictionary: rgbDictionary(4),
      data: vertexData([...rgbTriangle, { x: 100, y: 100, color: [0, 0, 0] }]),
    },
    {
      name: 'a first Type 6 patch that continues an edge',
      dictionary: rgbDictionary(6),
      data: patchData([
        {
          flag: 1,
          points: Array.from({ length: 12 }, (_, index) => [index * 5, index * 3] as const),
          colors: [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 255],
          ],
        },
      ]),
    },
    { name: 'an empty Type 6 patch mesh', dictionary: rgbDictionary(6), data: new Uint8Array() },
    { name: 'a Type 5 lattice with an incomplete row', dictionary: rgbDictionary(5), data: vertexData(rgbTriangle, { flagged: false }) },
    { name: 'a Type 5 lattice with a single row', dictionary: rgbDictionary(5), data: vertexData(rgbTriangle.slice(0, 2), { flagged: false }) },
  ])('reports $name as a parse error', ({ dictionary, data }) => {
    const document = loadDocument(shadingPdf(dictionary, data));
    expect(() => convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination })).toThrow(ParseError);
  });

  it.each([
    { flag: 1, implied: [1, 2] },
    { flag: 2, implied: [0, 2] },
  ] as const)('converts a Type 4 vertex with edge flag $flag like the triangle it implies written out in full', ({ flag, implied }) => {
    const fourth = { x: 100, y: 100, color: [255, 255, 0] };
    const joined = loadDocument(shadingPdf(rgbDictionary(4), vertexData([...rgbTriangle, { ...fourth, flag }])));
    // ISO 32000-1:2008, 8.7.4.5.5: flag 1 joins the new vertex to vb and vc of the previous triangle, flag 2 to va and vc.
    const explicitVertices = [...rgbTriangle, ...implied.map(index => rgbTriangle[index] ?? fourth), fourth];
    const explicit = loadDocument(shadingPdf(rgbDictionary(4), vertexData(explicitVertices)));
    const single = loadDocument(shadingPdf(rgbDictionary(4), vertexData(rgbTriangle)));
    for (const document of [joined, explicit, single]) {
      convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    }
    expect(mesh(joined).data).toStrictEqual(mesh(explicit).data);
    expect(mesh(joined).data.length).toBeGreaterThan(mesh(single).data.length);
  });

  it.each([
    { name: 'in-range colours', decode: '/Decode[0 100 0 100 0 1 0 1 0 1]', capped: false },
    { name: 'colours its Decode array maps beyond the colour space range', decode: '/Decode[0 100 0 100 -1 2 -1 2 -1 2]', capped: true },
  ])('reports capped subdivision only for a mesh with $name', ({ decode, capped }) => {
    const document = loadDocument(
      shadingPdf(
        rgbDictionary(4).replace('/Decode[0 100 0 100 0 1 0 1 0 1]', decode),
        vertexData([
          { x: 0, y: 0, color: [0, 0, 0] },
          { x: 255, y: 0, color: [255, 255, 255] },
          { x: 0, y: 255, color: [255, 255, 255] },
        ]),
      ),
    );
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.approximations.map(item => ({ shading: item.shading, kind: item.kind, capped: (item.cappedTriangles ?? 0) > 0 }))).toStrictEqual(
      capped ? [{ shading: pdfReference(5, 0), kind: 'mesh-interpolation', capped: true }] : [],
    );
  });

  it.each([
    { triangles: 2, result: 'converted 1' },
    { triangles: 3, result: 'ResourceLimitError' },
  ])('converts $triangles flat triangles under a 54-byte decoded-data budget only while they fit', ({ triangles, result }) => {
    const vertices = Array.from({ length: triangles * 3 }, (_, index) => ({ x: index % 3 === 1 ? 255 : 0, y: index % 3 === 2 ? 255 : 0, color: [0, 128, 64] }));
    const document = loadDocument(shadingPdf(rgbDictionary(4), vertexData(vertices)), { maxDecodedBytes: 54 });
    expect(outcome(document, report => `converted ${String(report.meshes)}`)).toBe(result);
  });

  it('reports a parametric mesh Function that sampling cannot follow within tolerance', () => {
    const document = loadDocument(
      shadingPdf(
        '/ShadingType 4/ColorSpace/DeviceRGB/BitsPerCoordinate 8/BitsPerComponent 8/BitsPerFlag 2/Decode[0 100 0 100 0 1]/Function 6 0 R',
        functionTriangle(),
        [{ number: 6, body: streamBody('/FunctionType 4/Domain[0 1]/Range[0 1 0 1 0 1]', '{ 0.5 lt { 1 0 0 } { 0 0 1 } ifelse }') }],
      ),
    );
    const report = convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    expect(report.approximations).toStrictEqual([{ shading: pdfReference(5, 0), kind: 'function-sampling' }]);
  });

  it('keeps 16-bit mesh colour components at 16 bits', () => {
    const document = loadDocument(
      shadingPdf(
        rgbDictionary(4).replace('/BitsPerComponent 8', '/BitsPerComponent 16'),
        vertexData(
          rgbTriangle.map(vertex => ({ ...vertex, color: vertex.color.map(value => value * 257) })),
          { componentBits: 16 },
        ),
      ),
    );
    convertMeshShadings(document, { sourceRgbProfile: source, outputProfile: destination });
    const converted = mesh(document);
    const corner = meshRecords(converted.data, { flagBits: 8, coordinateBits: 16, componentBits: 16 }).find(record => record.x === 0 && record.y === 0);
    const expected = [...cmykOf(1, 0, 0)].map(value => Math.round(value * 65_535));
    expect(converted.componentBits).toBe(16);
    expect(corner?.color.map((value, channel) => Math.abs(value - (expected[channel] ?? Number.NaN)) <= 1)).toStrictEqual([true, true, true, true]);
  });
});

interface RandomMesh {
  readonly type: 4 | 5 | 6 | 7;
  readonly coordinateBits: number;
  readonly componentBits: number;
  readonly flagBits: number;
  readonly channels: number;
  readonly data: Uint8Array;
  readonly records: number;
}

/** Writes a valid mesh stream of the given layout from a pool of raw values, each reduced to its field width. */
const randomMesh = (layout: Omit<RandomMesh, 'data' | 'records'>, pool: ReadonlyArray<number>, records: number): RandomMesh => {
  const writer = new MeshBitWriter();
  let next = 0;
  const take = (bits: number): number => {
    const value = (pool[next % pool.length] ?? 0) % 2 ** bits;
    next++;
    return value;
  };
  for (let record = 0; record < records; record++) {
    let flag = 0;
    if (layout.type === 4) {
      flag = take(2) % 3;
    } else if (layout.type !== 5 && record > 0) {
      flag = take(2);
    }
    if (layout.type !== 5) {
      writer.write(layout.flagBits, flag);
    }
    // ISO 32000-1:2008, 8.7.4.5.5–8 Tables 84–86: a vertex has one point and one colour, and a patch 12 or 16 points and 4 colours, fewer when it shares an edge.
    let points = 1;
    let colors = 1;
    if (layout.type === 6 || layout.type === 7) {
      points = (layout.type === 6 ? 12 : 16) - (flag === 0 ? 0 : 4);
      colors = flag === 0 ? 4 : 2;
    }
    for (let coordinate = 0; coordinate < points * 2; coordinate++) {
      writer.write(layout.coordinateBits, take(layout.coordinateBits));
    }
    for (let component = 0; component < colors * layout.channels; component++) {
      writer.write(layout.componentBits, take(layout.componentBits));
    }
    writer.alignByte();
  }
  return { ...layout, data: writer.finish(1 << 20), records };
};

const meshLayout = fc.record({
  type: fc.constantFrom(4, 5, 6, 7),
  coordinateBits: fc.constantFrom(1, 2, 4, 8, 12, 16, 24, 32),
  componentBits: fc.constantFrom(1, 2, 4, 8, 12, 16),
  flagBits: fc.constantFrom(2, 4, 8),
  channels: fc.integer({ min: 1, max: 4 }),
});

const barycentric = (
  point: { readonly x: number; readonly y: number },
  corners: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): ReadonlyArray<number> => {
  const [a, b, c] = corners;
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error('triangle is incomplete');
  }
  const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const wa = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denominator;
  const wb = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denominator;
  return [wa, wb, 1 - wa - wb];
};

describe('properties', () => {
  it('rewrites only the colour fields, so an identity conversion returns the mesh unchanged', () => {
    fc.assert(
      fc.property(meshLayout, fc.array(fc.nat(), { minLength: 1, maxLength: 64 }), fc.integer({ min: 1, max: 6 }), (layout, pool, records) => {
        const mesh = randomMesh(layout, pool, records);
        const converted = convertMeshSamples(mesh.data, {
          type: mesh.type,
          coordinateBits: mesh.coordinateBits,
          componentBits: mesh.componentBits,
          outputComponentBits: mesh.componentBits,
          flagBits: mesh.type === 5 ? 0 : mesh.flagBits,
          channels: mesh.channels,
          outputChannels: mesh.channels,
          decode: [0, 1, 0, 1, ...Array.from({ length: mesh.channels }, () => [0, 1]).flat()],
          transform: {
            convert: (input, output) => {
              output.set(input);
            },
          },
          maxBytes: 1 << 20,
        });
        expect(converted).toStrictEqual({ data: mesh.data, records: mesh.records });
      }),
    );
  });

  it('emits subdivided vertices inside the source triangle and within the byte budget', () => {
    const corner = fc.record({
      x: fc.integer({ min: 0, max: 255 }),
      y: fc.integer({ min: 0, max: 255 }),
      color: fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 3, maxLength: 3 }),
    });
    fc.assert(
      fc.property(fc.array(corner, { minLength: 3, maxLength: 3 }), fc.integer({ min: 27, max: 4096 }), (corners, maxBytes) => {
        const [a, b, c] = corners;
        fc.pre(a !== undefined && b !== undefined && c !== undefined && Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) >= 100);
        const run = (): { readonly bytes: number; readonly records: ReadonlyArray<MeshRecord> } | undefined => {
          try {
            const result = subdivideMesh(vertexData(corners), {
              type: 4,
              coordinateBits: 8,
              componentBits: 8,
              flagBits: 2,
              decode: [0, 255, 0, 255, 0, 1, 0, 1, 0, 1],
              transform: rgbTransform,
              destination,
              maxBytes,
            });
            return { bytes: result.data.length, records: meshRecords(result.data, { flagBits: 8, coordinateBits: 16, componentBits: 8 }) };
          } catch (error) {
            if (error instanceof ResourceLimitError) {
              return undefined;
            }
            throw error;
          }
        };
        const result = run();
        // Rounding to the 16-bit output grid can move a vertex by one step, which shifts its barycentric weights by at most one step over the shortest altitude.
        const step = 255 / 65_535;
        const doubledArea = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
        const longestEdge = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - b.x, c.y - b.y), Math.hypot(a.x - c.x, a.y - c.y));
        const tolerance = step / (doubledArea / longestEdge);
        const outside = (result?.records ?? []).filter(record =>
          barycentric({ x: record.x * step, y: record.y * step }, corners).some(weight => weight < -tolerance),
        );
        expect(result === undefined || result.bytes <= maxBytes).toBe(true);
        expect(outside).toStrictEqual([]);
      }),
    );
  }, 120_000);
});
