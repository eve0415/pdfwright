import type { ColorTransform } from '../color/createColorTransform.ts';
import type { IccProfile } from '../icc/iccProfile.ts';

import { deltaE2000 } from '../color/deltaE2000.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { MeshBitReader } from './meshBits.ts';
import { MeshBitWriter } from './meshBitWriter.ts';

export const MAX_MESH_SUBDIVISION_DEPTH = 6;
export const MAX_MESH_OUTPUT_BYTES = 4 * 1024 * 1024;

interface Vertex {
  readonly x: number;
  readonly y: number;
  readonly rgb: readonly number[];
  readonly cmyk: readonly number[];
  readonly parameter?: { readonly u: number; readonly v: number; readonly surface: (u: number, v: number) => Vertex };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Patch {
  readonly points: readonly Point[];
  readonly colors: readonly (readonly number[])[];
}

interface VertexRecord {
  readonly vertex: Vertex;
  readonly flag: number;
}

type Triangle = readonly [Vertex, Vertex, Vertex];

export interface MeshSubdivisionOptions {
  readonly type: 4 | 5 | 6 | 7;
  readonly coordinateBits: number;
  readonly componentBits: number;
  readonly flagBits: number;
  readonly decode: readonly number[];
  readonly verticesPerRow?: number | undefined;
  readonly transform: ColorTransform;
  readonly destination: IccProfile;
  readonly maxBytes: number;
}

export interface SubdividedMesh {
  readonly data: Uint8Array;
  readonly coordinateBits: number;
  readonly componentBits: number;
  readonly triangles: number;
  readonly cappedTriangles: number;
}

const component = (raw: number, bits: number, range: { low: number; high: number }): number => range.low + (raw / (2 ** bits - 1)) * (range.high - range.low);

const converted = (transform: ColorTransform, rgb: readonly number[]): readonly number[] => {
  const output = new Float64Array(4);
  transform.convert(Float64Array.from(rgb), output);
  return [...output];
};

const readVertex = (reader: MeshBitReader, options: MeshSubdivisionOptions): VertexRecord => {
  const flag = options.type === 4 ? reader.read(options.flagBits) % 4 : 0;
  const x = component(reader.read(options.coordinateBits), options.coordinateBits, { low: options.decode[0] ?? 0, high: options.decode[1] ?? 1 });
  const y = component(reader.read(options.coordinateBits), options.coordinateBits, { low: options.decode[2] ?? 0, high: options.decode[3] ?? 1 });
  const rgb = Array.from({ length: 3 }, (_, channel) =>
    component(reader.read(options.componentBits), options.componentBits, {
      low: options.decode[4 + channel * 2] ?? 0,
      high: options.decode[5 + channel * 2] ?? 1,
    }),
  );
  reader.alignByte();
  return { vertex: { x, y, rgb, cmyk: converted(options.transform, rgb) }, flag };
};

const latticeTriangles = (reader: MeshBitReader, options: MeshSubdivisionOptions): readonly Triangle[] => {
  const triangles: Triangle[] = [];
  const perRow = options.verticesPerRow;
  if (perRow === undefined || perRow < 2) throw new ParseError('mesh VerticesPerRow is invalid', 0);
  const vertices: Vertex[] = [];
  while (reader.remainingBits > 0) vertices.push(readVertex(reader, options).vertex);
  if (vertices.length < perRow * 2 || vertices.length % perRow !== 0) throw new ParseError('lattice mesh rows are incomplete', 0);
  const rows = vertices.length / perRow;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < perRow - 1; column++) {
      const a = vertices[row * perRow + column];
      const b = vertices[row * perRow + column + 1];
      const c = vertices[(row + 1) * perRow + column];
      const d = vertices[(row + 1) * perRow + column + 1];
      if (a === undefined || b === undefined || c === undefined || d === undefined) throw new ParseError('lattice mesh vertex is missing', 0);
      // ISO 32000-1:2008, 8.7.4.5.6: each lattice cell uses these two vertex triplets.
      triangles.push([a, b, c], [b, c, d]);
    }
  }
  return triangles;
};

const freeTriangles = (reader: MeshBitReader, options: MeshSubdivisionOptions): readonly Triangle[] => {
  const triangles: Triangle[] = [];
  let pending: Vertex[] = [];
  let previous: Triangle | undefined = undefined;
  while (reader.remainingBits > 0) {
    const { vertex, flag } = readVertex(reader, options);
    if (flag > 2) throw new ParseError('Type 4 mesh edge flag is invalid', 0);
    if (pending.length > 0 || previous === undefined || flag === 0) {
      pending.push(vertex);
      if (pending.length === 3) {
        previous = [pending[0] ?? vertex, pending[1] ?? vertex, pending[2] ?? vertex];
        triangles.push(previous);
        pending = [];
      }
      continue;
    }
    previous = flag === 1 ? [previous[1], previous[2], vertex] : [previous[0], previous[2], vertex];
    triangles.push(previous);
  }
  if (pending.length > 0 || triangles.length === 0) throw new ParseError('free-form mesh has incomplete triangles', 0);
  return triangles;
};

const point = (reader: MeshBitReader, options: MeshSubdivisionOptions): Point => ({
  x: component(reader.read(options.coordinateBits), options.coordinateBits, { low: options.decode[0] ?? 0, high: options.decode[1] ?? 1 }),
  y: component(reader.read(options.coordinateBits), options.coordinateBits, { low: options.decode[2] ?? 0, high: options.decode[3] ?? 1 }),
});

const patchColor = (reader: MeshBitReader, options: MeshSubdivisionOptions): readonly number[] =>
  Array.from({ length: 3 }, (_, channel) =>
    component(reader.read(options.componentBits), options.componentBits, {
      low: options.decode[4 + channel * 2] ?? 0,
      high: options.decode[5 + channel * 2] ?? 1,
    }),
  );

const sharedEdge = (patch: Patch, flag: number): readonly Point[] => {
  const start = flag * 3;
  return Array.from({ length: 4 }, (_, index) => patch.points[(start + index) % 12] ?? { x: 0, y: 0 });
};

const sharedColors = (patch: Patch, flag: number): readonly (readonly number[])[] => {
  const first = flag;
  return [patch.colors[first] ?? [], patch.colors[(first + 1) % 4] ?? []];
};

const interior = (points: readonly Point[], index: number): Point => {
  const at = (entry: number): Point => points[entry] ?? { x: 0, y: 0 };
  const allTerms = [
    [
      [-4, 0],
      [6, 1],
      [6, 11],
      [-2, 3],
      [-2, 9],
      [3, 8],
      [3, 4],
      [-1, 6],
    ],
    [
      [-4, 3],
      [6, 2],
      [6, 4],
      [-2, 0],
      [-2, 6],
      [3, 7],
      [3, 11],
      [-1, 9],
    ],
    [
      [-4, 9],
      [6, 8],
      [6, 10],
      [-2, 6],
      [-2, 0],
      [3, 1],
      [3, 5],
      [-1, 3],
    ],
    [
      [-4, 6],
      [6, 7],
      [6, 5],
      [-2, 9],
      [-2, 3],
      [3, 2],
      [3, 10],
      [-1, 0],
    ],
  ];
  const terms = allTerms[index] ?? [];
  return {
    x: terms.reduce((sum, [weight, entry]) => sum + (weight ?? 0) * at(entry ?? 0).x, 0) / 9,
    y: terms.reduce((sum, [weight, entry]) => sum + (weight ?? 0) * at(entry ?? 0).y, 0) / 9,
  };
};

const tensorPoints = (patch: Patch, type: 6 | 7): readonly Point[] => {
  const { points } = patch;
  const at = (index: number): Point => points[index] ?? { x: 0, y: 0 };
  // ISO 32000-1:2008, 8.7.4.5.8: Type 6 interior points are fixed by its twelve boundary points.
  return [
    at(0),
    at(1),
    at(2),
    at(3),
    at(11),
    type === 6 ? interior(points, 0) : at(12),
    type === 6 ? interior(points, 1) : at(13),
    at(4),
    at(10),
    type === 6 ? interior(points, 2) : at(15),
    type === 6 ? interior(points, 3) : at(14),
    at(5),
    at(9),
    at(8),
    at(7),
    at(6),
  ];
};

const bernstein = (value: number): readonly number[] => [(1 - value) ** 3, 3 * value * (1 - value) ** 2, 3 * value * value * (1 - value), value ** 3];

const distance = (actual: Point, x: number, y: number): number => Math.hypot(actual.x - x, actual.y - y);

const patchTriangles = (patch: Patch, type: 6 | 7, transform: ColorTransform): readonly Triangle[] => {
  const control = tensorPoints(patch, type);
  const sample = (u: number, v: number): Vertex => {
    const bu = bernstein(u);
    const bv = bernstein(v);
    let x = 0;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const weight = (bu[i] ?? 0) * (bv[j] ?? 0);
        const controlPoint = control[i * 4 + j];
        x += weight * (controlPoint?.x ?? 0);
        y += weight * (controlPoint?.y ?? 0);
      }
    }
    const c00 = patch.colors[0] ?? [];
    const c03 = patch.colors[1] ?? [];
    const c33 = patch.colors[2] ?? [];
    const c30 = patch.colors[3] ?? [];
    const rgb = Array.from(
      { length: 3 },
      (_, channel) =>
        (1 - u) * (1 - v) * (c00[channel] ?? 0) + (1 - u) * v * (c03[channel] ?? 0) + u * v * (c33[channel] ?? 0) + u * (1 - v) * (c30[channel] ?? 0),
    );
    return { x, y, rgb, cmyk: converted(transform, rgb), parameter: { u, v, surface: sample } };
  };
  const triangles: Triangle[] = [];
  const refine = (quad: { u0: number; v0: number; u1: number; v1: number; depth: number }): void => {
    const { u0, v0, u1, v1, depth } = quad;
    const a = sample(u0, v0);
    const b = sample(u1, v0);
    const c = sample(u0, v1);
    const d = sample(u1, v1);
    const um = (u0 + u1) / 2;
    const vm = (v0 + v1) / 2;
    const center = sample(um, vm);
    const geometryError = Math.max(
      distance(center, (a.x + b.x + c.x + d.x) / 4, (a.y + b.y + c.y + d.y) / 4),
      distance(sample(um, v0), (a.x + b.x) / 2, (a.y + b.y) / 2),
      distance(sample(um, v1), (c.x + d.x) / 2, (c.y + d.y) / 2),
      distance(sample(u0, vm), (a.x + c.x) / 2, (a.y + c.y) / 2),
      distance(sample(u1, vm), (b.x + d.x) / 2, (b.y + d.y) / 2),
    );
    if (geometryError > 0.1 && depth < MAX_MESH_SUBDIVISION_DEPTH) {
      refine({ u0, v0, u1: um, v1: vm, depth: depth + 1 });
      refine({ u0: um, v0, u1, v1: vm, depth: depth + 1 });
      refine({ u0, v0: vm, u1: um, v1, depth: depth + 1 });
      refine({ u0: um, v0: vm, u1, v1, depth: depth + 1 });
      return;
    }
    triangles.push([a, b, c], [b, c, d]);
  };
  refine({ u0: 0, v0: 0, u1: 1, v1: 1, depth: 0 });
  return triangles;
};

const patches = (reader: MeshBitReader, options: MeshSubdivisionOptions): readonly Triangle[] => {
  const triangles: Triangle[] = [];
  let previous: Patch | undefined = undefined;
  while (reader.remainingBits > 0) {
    const flag = reader.read(options.flagBits) % 4;
    if (previous === undefined && flag !== 0) throw new ParseError('the first mesh patch must start a new patch', 0);
    const points: Point[] = previous === undefined || flag === 0 ? [] : [...sharedEdge(previous, flag)];
    const count = options.type === 6 ? 12 : 16;
    while (points.length < count) points.push(point(reader, options));
    const colors: (readonly number[])[] = previous === undefined || flag === 0 ? [] : [...sharedColors(previous, flag)];
    while (colors.length < 4) colors.push(patchColor(reader, options));
    reader.alignByte();
    previous = { points, colors };
    triangles.push(...patchTriangles(previous, options.type === 6 ? 6 : 7, options.transform));
  }
  if (previous === undefined) throw new ParseError('patch mesh is empty', 0);
  return triangles;
};

const trianglesOf = (data: Uint8Array, options: MeshSubdivisionOptions): readonly Triangle[] => {
  const reader = new MeshBitReader(data);
  if (options.type === 5) return latticeTriangles(reader, options);
  if (options.type === 4) return freeTriangles(reader, options);
  return patches(reader, options);
};

const midpoint = (a: Vertex, b: Vertex, transform: ColorTransform): Vertex => {
  const pa = a.parameter;
  const pb = b.parameter;
  if (pa !== undefined && pb !== undefined && pa.surface === pb.surface) return pa.surface((pa.u + pb.u) / 2, (pa.v + pb.v) / 2);
  const rgb = a.rgb.map((value, index) => (value + (b.rgb[index] ?? 0)) / 2);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, rgb, cmyk: converted(transform, rgb) };
};

const centroid = (triangle: Triangle, transform: ColorTransform): Vertex => {
  const [a, b, c] = triangle;
  const pa = a.parameter;
  const pb = b.parameter;
  const pc = c.parameter;
  if (pa !== undefined && pb !== undefined && pc !== undefined && pa.surface === pb.surface && pa.surface === pc.surface) {
    return pa.surface((pa.u + pb.u + pc.u) / 3, (pa.v + pb.v + pc.v) / 3);
  }
  const rgb = a.rgb.map((value, index) => (value + (b.rgb[index] ?? 0) + (c.rgb[index] ?? 0)) / 3);
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, rgb, cmyk: converted(transform, rgb) };
};

const edgeError = (a: Vertex, b: Vertex, config: { exact: Vertex; lab: (cmyk: readonly number[]) => readonly number[] }): number => {
  const interpolated = a.cmyk.map((value, index) => (value + (b.cmyk[index] ?? 0)) / 2);
  return deltaE2000(config.lab(config.exact.cmyk), config.lab(interpolated));
};

const encodeCoordinate = (value: number, bits: number, range: { low: number; high: number }): number => {
  if (range.high === range.low) return 0;
  const fraction = (value - range.low) / (range.high - range.low);
  return Math.round(Math.min(1, Math.max(0, fraction)) * (2 ** bits - 1));
};

/** Refines each source triangle until converting its RGB edge midpoints agrees with interpolation of the CMYK vertices. */
export const subdivideMesh = (data: Uint8Array, options: MeshSubdivisionOptions): SubdividedMesh => {
  const coordinateBits = Math.max(options.coordinateBits, 16);
  const componentBits = Math.max(options.componentBits, 8);
  const writer = new MeshBitWriter();
  const toPcs = sourceEvaluator(options.destination, 'relativeColorimetric', 'icc');
  const lab = (cmyk: readonly number[]): readonly number[] => {
    const pcs = toPcs(cmyk);
    return pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values);
  };
  const recordBytes = Math.ceil((8 + 2 * coordinateBits + 4 * componentBits) / 8);
  let outputBytes = 0;
  let triangleCount = 0;
  let cappedTriangles = 0;
  const emit = (triangle: Triangle): void => {
    outputBytes += recordBytes * 3;
    if (outputBytes > options.maxBytes) throw new ResourceLimitError('mesh subdivision exceeds maxMeshOutputBytes');
    for (const vertex of triangle) {
      writer.write(8, 0);
      writer.write(coordinateBits, encodeCoordinate(vertex.x, coordinateBits, { low: options.decode[0] ?? 0, high: options.decode[1] ?? 1 }));
      writer.write(coordinateBits, encodeCoordinate(vertex.y, coordinateBits, { low: options.decode[2] ?? 0, high: options.decode[3] ?? 1 }));
      for (const value of vertex.cmyk) {
        const clipped = Math.min(1, Math.max(0, value));
        writer.write(componentBits, Math.round(clipped * (2 ** componentBits - 1)));
      }
      writer.alignByte();
    }
    triangleCount++;
  };
  const pending = trianglesOf(data, options).map(triangle => ({ triangle, depth: 0 }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { triangle, depth } = current;
    const [a, b, c] = triangle;
    const ab = midpoint(a, b, options.transform);
    const bc = midpoint(b, c, options.transform);
    const ca = midpoint(c, a, options.transform);
    const exactCentroid = centroid(triangle, options.transform);
    const interpolatedCentroid = a.cmyk.map((value, index) => (value + (b.cmyk[index] ?? 0) + (c.cmyk[index] ?? 0)) / 3);
    const error = Math.max(
      edgeError(a, b, { exact: ab, lab }),
      edgeError(b, c, { exact: bc, lab }),
      edgeError(c, a, { exact: ca, lab }),
      deltaE2000(lab(exactCentroid.cmyk), lab(interpolatedCentroid)),
    );
    if (error > 0.5 && depth < MAX_MESH_SUBDIVISION_DEPTH) {
      if ((pending.length + 4 + triangleCount) * recordBytes * 3 > options.maxBytes) {
        throw new ResourceLimitError('mesh subdivision exceeds maxMeshOutputBytes');
      }
      pending.push(
        { triangle: [a, ab, ca], depth: depth + 1 },
        { triangle: [ab, b, bc], depth: depth + 1 },
        { triangle: [ca, bc, c], depth: depth + 1 },
        { triangle: [ab, bc, ca], depth: depth + 1 },
      );
    } else {
      if (error > 0.5) cappedTriangles++;
      emit(triangle);
    }
  }
  return { data: writer.finish(options.maxBytes), coordinateBits, componentBits, triangles: triangleCount, cappedTriangles };
};
