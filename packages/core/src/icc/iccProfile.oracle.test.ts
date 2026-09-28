import type { ContentOperation } from '../content/contentOperations.ts';
import type { IccProfile } from './iccProfile.ts';

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { env, stdout } from 'node:process';

import { describe, expect, it } from 'vitest';

import { createColorTransform } from '../color/createColorTransform.ts';
import { xyzToLab } from '../color/pcs.ts';
import { sourceEvaluator } from '../color/profilePipeline.ts';
import { readContent } from '../content/contentOperations.ts';
import { pageContent } from '../content/pageContent.ts';
import { internalsOf } from '../document/documentInternals.ts';
import { loadDocument } from '../document/loadDocument.ts';

import { parseIccProfile } from './iccProfile.ts';

const fixture = async (name: string): Promise<Uint8Array> =>
  Uint8Array.from(await readFile(new URL(`../../../../tests/fixtures/icc/${name}`, import.meta.url)));

describe('committed ICC fixtures', () => {
  it.each(['fogra28l.icc', 'fogra28l-v4.icc', 'synthetic-cmyk.icc', 'sRGB.icm', 'sRGB-v4.icc', 'DisplayP3-v4.icc', 'Rec2020-v4.icc', 'ProPhoto-v4.icc'])(
    'parses %s and keeps its profile bytes',
    async name => {
      const bytes = await fixture(name);
      const profile = parseIccProfile(bytes);
      expect(profile.bytes).toStrictEqual(bytes);
      expect(profile.identity).toHaveLength(16);
    },
  );
});

describe('icc transform smoke oracle', () => {
  it('matches LittleCMS CMYK values for v2 and v4 destination tables', async () => {
    const source = parseIccProfile(await fixture('sRGB.icm'));
    const sourceV4 = parseIccProfile(await fixture('sRGB-v4.icc'));
    const destination = parseIccProfile(await fixture('fogra28l.icc'));
    const destinationV4 = parseIccProfile(await fixture('fogra28l-v4.icc'));
    const cases = [
      { source, destination, rgb: [0, 0, 0], cmyk: [99.986267, 62.825972, 37.1252, 100] },
      { source, destination, rgb: [128, 128, 128], cmyk: [14.896, 11.913, 13.776, 53.33] },
      { source: sourceV4, destination: destinationV4, rgb: [0, 0, 0], cmyk: [96.334785, 59.949642, 37.677577, 99.810791] },
      { source: sourceV4, destination: destinationV4, rgb: [128, 128, 128], cmyk: [15.994507, 12.813, 14.694437, 52.426946] },
    ];
    for (const item of cases) {
      const transform = createColorTransform({ kind: 'icc', profile: item.source }, item.destination, {
        intent: 'relativeColorimetric',
        blackPointCompensation: false,
      });
      const output = new Float64Array(4);
      transform.convert(
        Float64Array.from(item.rgb, value => value / 255),
        output,
      );
      for (let channel = 0; channel < 4; channel++) expect(Math.abs(Number(output[channel]) * 100 - Number(item.cmyk[channel]))).toBeLessThan(0.5);
    }
  });
});

const localDirectory = env['PDFWRIGHT_TEST_ICC_PROFILE_DIR'];
if (localDirectory === undefined) stdout.write('Local ICC profiles not run: PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset.\n');

const localProfiles = async (): Promise<Uint8Array[]> => {
  if (localDirectory === undefined) return [];
  const entries = await readdir(localDirectory);
  const names = entries.filter(name => /\.(?:icc|icm)$/iu.test(name));
  return Promise.all(names.map(async name => Uint8Array.from(await readFile(path.join(localDirectory, name)))));
};

interface Paint {
  readonly space: 'RGB' | 'CMYK' | 'Gray';
  readonly values: readonly number[];
}
interface Patch {
  readonly key: string;
  readonly paint: Paint;
}

const numeric = (operands: readonly { readonly kind: string }[], count: number): number[] | undefined => {
  if (operands.length !== count) return undefined;
  const values: number[] = [];
  for (const operand of operands) {
    if (operand.kind !== 'integer' && operand.kind !== 'real') return undefined;
    if (!('value' in operand) || typeof operand.value !== 'number') return undefined;
    values.push(operand.value);
  }
  return values;
};

const rectangleKey = (page: number, rectangle: readonly number[], stroke: boolean): string =>
  `${String(page)}:${rectangle.map(value => value.toFixed(3)).join(',')}:${stroke ? 'stroke' : 'fill'}`;

const colorOperators = new Set(['rg', 'RG', 'k', 'K', 'g', 'G']);
const pathEnds = new Set(['f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'n']);
const strokeEnds = new Set(['S', 's']);

const colorChange = (operation: ContentOperation): Paint | undefined => {
  const { operator } = operation;
  if (!colorOperators.has(operator)) return undefined;
  let space: Paint['space'] = 'Gray';
  let count = 1;
  if (operator === 'rg' || operator === 'RG') {
    space = 'RGB';
    count = 3;
  } else if (operator === 'k' || operator === 'K') {
    space = 'CMYK';
    count = 4;
  }
  const values = numeric(operation.operands, count);
  if (values === undefined) throw new Error(`invalid ${operator} operands`);
  return { space, values };
};

const readPagePaints = (config: { streams: readonly Uint8Array[]; maxNesting: number; page: number; paints: Map<string, Paint> }): void => {
  let fill: Paint = { space: 'Gray', values: [0] };
  let stroke: Paint = { space: 'Gray', values: [0] };
  const stack: { readonly fill: Paint; readonly stroke: Paint }[] = [];
  let rectangles: number[][] = [];
  for (const operation of readContent(config.streams, config.maxNesting)) {
    const { operator } = operation;
    if (operator === 'q') {
      stack.push({ fill, stroke });
      continue;
    }
    if (operator === 'Q') {
      const saved = stack.pop();
      if (saved === undefined) throw new Error('unbalanced graphics state');
      ({ fill, stroke } = saved);
      continue;
    }
    const changed = colorChange(operation);
    if (changed !== undefined) {
      if (operator === operator.toLowerCase()) fill = changed;
      else stroke = changed;
      continue;
    }
    if (operator === 're') {
      const rectangle = numeric(operation.operands, 4);
      if (rectangle !== undefined) rectangles.push(rectangle);
      continue;
    }
    if (!pathEnds.has(operator)) continue;
    const useStroke = strokeEnds.has(operator);
    for (const rectangle of rectangles) {
      const key = rectangleKey(config.page, rectangle, useStroke);
      if (config.paints.has(key)) throw new Error(`duplicate patch rectangle ${key}`);
      config.paints.set(key, useStroke ? stroke : fill);
    }
    rectangles = [];
  }
};

const paintsIn = async (file: string): Promise<Map<string, Paint>> => {
  const document = loadDocument(Uint8Array.from(await readFile(file)));
  const internals = internalsOf(document);
  if (internals === undefined) throw new Error('loaded document has no internals');
  const paints = new Map<string, Paint>();
  for (let page = 0; page < document.pageCount; page++) {
    const entry = internals.pages[page];
    if (entry === undefined) throw new Error('page missing from loaded document');
    const content = pageContent(internals, entry);
    if (content.problems.length > 0) throw new Error(content.problems.join('; '));
    readPagePaints({ streams: content.streams, maxNesting: internals.maxNesting, page: page + 1, paints });
  }
  return paints;
};

const numberArray = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries: readonly unknown[] = value;
  if (!entries.every((item): item is number => typeof item === 'number' && Number.isFinite(item))) return undefined;
  return entries;
};

const jsonPatch = (item: unknown): Patch | null | undefined => {
  if (typeof item !== 'object' || item === null || !('page' in item) || !('rectPt' in item) || !('kind' in item) || !('value' in item)) return undefined;
  const rectangle = numberArray(item.rectPt);
  const values = numberArray(item.value);
  if (typeof item.page !== 'number' || typeof item.kind !== 'string' || rectangle?.length !== 4 || values === undefined) return undefined;
  if (values.length !== 3) return null;
  return { key: rectangleKey(item.page, rectangle, item.kind === 'special-stroke'), paint: { space: 'RGB', values } };
};

const patchesFromJson = (value: unknown): Patch[] | undefined => {
  if (typeof value !== 'object' || value === null || !('patches' in value) || !Array.isArray(value.patches)) return undefined;
  const items: readonly unknown[] = value.patches;
  const patches: Patch[] = [];
  for (const item of items) {
    const patch = jsonPatch(item);
    if (patch === undefined) return undefined;
    if (patch !== null) patches.push(patch);
  }
  return patches;
};

const optionalText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const inputPatches = async (exportsDirectory: string): Promise<Patch[]> => {
  const input = await paintsIn(path.join(exportsDirectory, '_inputs', 'C-colour-oracle.pdf'));
  const candidates = [
    path.join(exportsDirectory, 'probes', 'C-colour-oracle.json'),
    path.join(exportsDirectory, '_inputs', 'C-colour-oracle.json'),
    path.join(exportsDirectory, '..', 'probes', 'C-colour-oracle.json'),
  ];
  const maps = await Promise.all(candidates.map(async candidate => ({ candidate, contents: await optionalText(candidate) })));
  const found = maps.find(item => item.contents !== undefined);
  if (found !== undefined) {
    const parsed: unknown = JSON.parse(found.contents ?? '');
    const patches = patchesFromJson(parsed);
    if (patches === undefined) throw new Error(`invalid patch map ${found.candidate}`);
    for (const patch of patches) expect(input.get(patch.key)).toStrictEqual(patch.paint);
    return patches;
  }
  return [...input].filter(([, paint]) => paint.space === 'RGB').map(([key, paint]) => ({ key, paint }));
};

// Sharma, Wu and Dalal, 2005, CIEDE2000 supplementary test data and equations.
const angle = (b: number, a: number): number => {
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

const hueDifference = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) return 0;
  const difference = second - first;
  if (difference > 180) return difference - 360;
  if (difference < -180) return difference + 360;
  return difference;
};

const meanHue = (first: number, second: number, chromaProduct: number): number => {
  if (chromaProduct === 0) return first + second;
  if (Math.abs(first - second) <= 180) return (first + second) / 2;
  const sum = first + second;
  if (sum < 360) return (sum + 360) / 2;
  return (sum - 360) / 2;
};

const deltaE2000 = (first: readonly number[], second: readonly number[]): number => {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const c1 = Math.hypot(a1 ?? 0, b1 ?? 0);
  const c2 = Math.hypot(a2 ?? 0, b2 ?? 0);
  const meanC = (c1 + c2) / 2;
  const meanC7 = meanC ** 7;
  const g = (1 - Math.sqrt(meanC7 / (meanC7 + 25 ** 7))) / 2;
  const ap1 = (a1 ?? 0) * (1 + g);
  const ap2 = (a2 ?? 0) * (1 + g);
  const cp1 = Math.hypot(ap1, b1 ?? 0);
  const cp2 = Math.hypot(ap2, b2 ?? 0);
  const h1 = angle(b1 ?? 0, ap1);
  const h2 = angle(b2 ?? 0, ap2);
  const deltaH = hueDifference(h1, h2, cp1 * cp2);
  const meanH = meanHue(h1, h2, cp1 * cp2);
  const meanCp = (cp1 + cp2) / 2;
  const t =
    1 -
    0.17 * Math.cos(((meanH - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * meanH * Math.PI) / 180) +
    0.32 * Math.cos(((3 * meanH + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * meanH - 63) * Math.PI) / 180);
  const deltaTheta = 30 * Math.exp(-(((meanH - 275) / 25) ** 2));
  const meanCp7 = meanCp ** 7;
  const rc = 2 * Math.sqrt(meanCp7 / (meanCp7 + 25 ** 7));
  const sl = 1 + (0.015 * (((l1 ?? 0) + (l2 ?? 0)) / 2 - 50) ** 2) / Math.sqrt(20 + (((l1 ?? 0) + (l2 ?? 0)) / 2 - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const dl = ((l2 ?? 0) - (l1 ?? 0)) / sl;
  const dc = (cp2 - cp1) / sc;
  const dh = (2 * Math.sqrt(cp1 * cp2) * Math.sin((deltaH * Math.PI) / 360)) / sh;
  return Math.sqrt(dl * dl + dc * dc + dh * dh - rc * Math.sin((2 * deltaTheta * Math.PI) / 180) * dc * dh);
};

const acrobatCases = [
  { prefix: 'C1-', description: 'Japan Color 2001 Coated', intent: 'relativeColorimetric', bpc: true, preserveBlack: false },
  { prefix: 'C2-', description: 'Coated FOGRA39', intent: 'relativeColorimetric', bpc: true, preserveBlack: false },
  { prefix: 'C3-', description: 'Japan Color 2001 Coated', intent: 'perceptual', bpc: true, preserveBlack: false },
  { prefix: 'C4-', description: 'Coated FOGRA39', intent: 'perceptual', bpc: true, preserveBlack: false },
  { prefix: 'C5-', description: 'Japan Color 2001 Coated', intent: 'relativeColorimetric', bpc: true, preserveBlack: true },
  { prefix: 'C6-', description: 'Japan Color 2001 Coated', intent: 'relativeColorimetric', bpc: false, preserveBlack: false },
] as const;

const normalizedDescription = (description: string): string => description.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();

const profileFor = (profiles: readonly IccProfile[], description: string): IccProfile => {
  const expected = normalizedDescription(description);
  const profile = profiles.find(candidate => candidate.description !== undefined && normalizedDescription(candidate.description).startsWith(expected));
  if (profile === undefined) throw new Error(`local profile ${description} missing`);
  return profile;
};

const localOracleProfiles = async (directory: string): Promise<IccProfile[]> => {
  const entries = await readdir(directory);
  const names = entries.filter(name => /\.(?:icc|icm)$/iu.test(name));
  return Promise.all(
    names.map(async name => {
      const bytes = await readFile(path.join(directory, name));
      return parseIccProfile(Uint8Array.from(bytes));
    }),
  );
};

const labOf = (pcs: ReturnType<ReturnType<typeof sourceEvaluator>>): readonly number[] => (pcs.space === 'Lab' ? pcs.values : xyzToLab(pcs.values));

const patchError = (
  patch: Patch,
  observed: Paint | undefined,
  config: { transform: ReturnType<typeof createColorTransform>; toPcs: ReturnType<typeof sourceEvaluator>; preserveBlack: boolean },
): number => {
  if (observed?.space !== 'CMYK') throw new Error(`CMYK patch ${patch.key} missing`);
  const output = new Float64Array(4);
  if (config.preserveBlack && patch.paint.values.every(value => value === 0)) output.set([0, 0, 0, 1]);
  else config.transform.convert(Float64Array.from(patch.paint.values), output);
  return deltaE2000(labOf(config.toPcs(observed.values)), labOf(config.toPcs(output)));
};

const measureAcrobatCase = async (
  entry: (typeof acrobatCases)[number],
  directories: { profiles: string | undefined; exports: string | undefined },
): Promise<{ maximum: number; mean: number; count: number }> => {
  const { profiles: profilesDirectory, exports: exportsDirectory } = directories;
  if (profilesDirectory === undefined || exportsDirectory === undefined) throw new Error('Acrobat oracle directories are unset');
  const source = parseIccProfile(await fixture('sRGB.icm'));
  const patches = await inputPatches(exportsDirectory);
  const profiles = await localOracleProfiles(profilesDirectory);
  const outputNames = await readdir(path.join(exportsDirectory, 'C-colour'));
  const name = outputNames.find(candidate => candidate.startsWith(entry.prefix) && candidate.endsWith('.pdf'));
  if (name === undefined) throw new Error(`Acrobat output ${entry.prefix} missing`);
  const destination = profileFor(profiles, entry.description);
  const observed = await paintsIn(path.join(exportsDirectory, 'C-colour', name));
  const transform = createColorTransform({ kind: 'icc', profile: source }, destination, {
    intent: entry.intent,
    blackPointCompensation: entry.bpc,
    lut8LabEncoding: 'adobe',
  });
  const toPcs = sourceEvaluator(destination, 'relativeColorimetric', 'icc');
  const errors = patches.map(patch => patchError(patch, observed.get(patch.key), { transform, toPcs, preserveBlack: entry.preserveBlack }));
  const maximum = Math.max(...errors);
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  return { maximum, mean, count: errors.length };
};

const exportsDirectory = env['PDFWRIGHT_ADOBE_EXPORTS_DIR'];
const oracleDirectories = { profiles: localDirectory, exports: exportsDirectory };
const missingOracleVariables = [
  ...(localDirectory === undefined ? ['PDFWRIGHT_TEST_ICC_PROFILE_DIR'] : []),
  ...(exportsDirectory === undefined ? ['PDFWRIGHT_ADOBE_EXPORTS_DIR'] : []),
];
if (missingOracleVariables.length > 0) stdout.write(`Acrobat lut8 Lab oracle not run: ${missingOracleVariables.join(' and ')} unset.\n`);

describe('ciede2000 oracle metric', () => {
  it.each([
    { first: [50, 2.6772, -79.7751], second: [50, 0, -82.7485], expected: 2.0425 },
    { first: [50, -1.3802, -84.2814], second: [50, 0, -82.7485], expected: 1 },
    { first: [50, 2.5, 0], second: [73, 25, -18], expected: 27.1492 },
  ])('matches a published pair with ΔE2000 $expected', ({ first, second, expected }) => {
    expect(deltaE2000(first, second)).toBeCloseTo(expected, 4);
  });
});

describe('local ICC profiles', () => {
  it.skipIf(localDirectory === undefined)('not run when PDFWRIGHT_TEST_ICC_PROFILE_DIR is unset', async () => {
    const files = await localProfiles();
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) {
      const profile = parseIccProfile(bytes);
      expect(profile.identity).toHaveLength(16);
    }
  });

  it.skipIf(missingOracleVariables.length > 0).each(acrobatCases)(
    'acrobat lut8 Lab oracle $prefix',
    async entry => {
      const measurement = await measureAcrobatCase(entry, oracleDirectories);
      stdout.write(
        `${entry.prefix.slice(0, 2)} n=${String(measurement.count)} ΔE2000 max=${measurement.maximum.toFixed(4)} mean=${measurement.mean.toFixed(4)}\n`,
      );
      expect(measurement.count).toBeGreaterThan(700);
      expect(measurement.maximum).toBeLessThanOrEqual(0.35);
      expect(measurement.mean).toBeLessThanOrEqual(0.06);
    },
    60_000,
  );
});
