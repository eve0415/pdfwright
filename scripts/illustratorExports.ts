import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface IllustratorExportSample {
  readonly file: string;
  readonly blocks: number;
  readonly lastLength: number;
  readonly layers: number;
  readonly rasters: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly paint: readonly number[];
}

export interface IllustratorAcceptanceExport {
  readonly label: string;
  readonly file: string;
}

export interface IllustratorExportManifest {
  readonly samples: readonly IllustratorExportSample[];
  readonly ladderSample: number;
  readonly acceptance: readonly IllustratorAcceptanceExport[];
}

const fileInside = (directory: string, relative: string, extensions: readonly string[]): string => {
  const root = path.resolve(directory);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`) || !extensions.includes(path.extname(file).toLowerCase())) {
    throw new Error('Illustrator export file must be inside the selected directory');
  }
  return path.relative(root, file);
};

const numberField = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid Illustrator export ${name}`);
  return value;
};

const sampleFrom = (value: unknown, directory: string): IllustratorExportSample => {
  if (typeof value !== 'object' || value === null || !('file' in value) || typeof value.file !== 'string') {
    throw new Error('invalid Illustrator export sample');
  }
  const paint: number[] = [];
  if (!('paint' in value) || !Array.isArray(value.paint) || value.paint.length !== 5) throw new Error('invalid Illustrator paint counts');
  for (const entry of value.paint) paint.push(numberField(entry, 'paint count'));
  return {
    file: fileInside(directory, value.file, ['.pdf']),
    blocks: numberField('blocks' in value ? value.blocks : undefined, 'block count'),
    lastLength: numberField('lastLength' in value ? value.lastLength : undefined, 'last block length'),
    layers: numberField('layers' in value ? value.layers : undefined, 'layer count'),
    rasters: numberField('rasters' in value ? value.rasters : undefined, 'raster count'),
    widthMm: numberField('widthMm' in value ? value.widthMm : undefined, 'width'),
    heightMm: numberField('heightMm' in value ? value.heightMm : undefined, 'height'),
    paint,
  };
};

const acceptanceFrom = (value: unknown, directory: string): IllustratorAcceptanceExport => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('label' in value) ||
    typeof value.label !== 'string' ||
    !('file' in value) ||
    typeof value.file !== 'string'
  ) {
    throw new Error('invalid Illustrator export acceptance entry');
  }
  return { label: value.label, file: fileInside(directory, value.file, ['.pdf', '.ai']) };
};

/** Reads local sample selection and measurements from the selected export directory. */
export const readIllustratorExportManifest = async (directory: string): Promise<IllustratorExportManifest> => {
  const input: unknown = JSON.parse(await readFile(path.join(directory, 'illustrator-samples.json'), 'utf8'));
  if (
    typeof input !== 'object' ||
    input === null ||
    !('samples' in input) ||
    !Array.isArray(input.samples) ||
    !('ladderSample' in input) ||
    !('acceptance' in input) ||
    !Array.isArray(input.acceptance)
  ) {
    throw new Error('invalid Illustrator export manifest');
  }
  const samples: IllustratorExportSample[] = [];
  for (const entry of input.samples) samples.push(sampleFrom(entry, directory));
  const acceptance: IllustratorAcceptanceExport[] = [];
  for (const entry of input.acceptance) acceptance.push(acceptanceFrom(entry, directory));
  if (
    samples.length === 0 ||
    typeof input.ladderSample !== 'number' ||
    !Number.isInteger(input.ladderSample) ||
    input.ladderSample < 0 ||
    input.ladderSample >= samples.length
  ) {
    throw new Error('invalid Illustrator export ladder sample');
  }
  return { samples, ladderSample: input.ladderSample, acceptance };
};
