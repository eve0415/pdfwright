import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';

export interface PlateFile {
  name: Uint8Array;
  file: string;
}

export interface Plate extends PlateFile {
  width: number;
  height: number;
  inkAt: (x: number, y: number) => number;
}

const decodePlateName = (fileName: string): Uint8Array => {
  const encoded = fileName.slice(2, -5);
  const bytes: Array<number> = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.codePointAt(index) ?? 0);
    }
  }
  return Uint8Array.from(bytes);
};

// Ghostscript exits 0 when it cannot draw a page and writes blank output, which would read as "no ink", so its notice is an error here.
const DRAWING_ERROR = 'Page drawing error';

const runGhostscript = async (args: ReadonlyArray<string>): Promise<void> => {
  const child = spawn('gs', args);
  const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  if (closed[0] !== 0 || `${stdout}${stderr}`.includes(DRAWING_ERROR)) {
    throw new Error(`Ghostscript exited ${String(closed[0])}: ${stdout}${stderr}`);
  }
};

const isPlateFile = (file: string): boolean => file.startsWith('o(') && file.endsWith(').tif');

/** Renders every plate of page 1 with tiffsep at 72 dpi into `directory`, after removing plates an earlier render left there. */
export const renderPlates = async (pdfFile: string, directory: string, includeProcess = false): Promise<Array<PlateFile>> => {
  await mkdir(directory, { recursive: true });
  await Promise.all((await readdir(directory)).filter(file => file === 'o.tif' || isPlateFile(file)).map(async file => rm(path.join(directory, file))));
  await runGhostscript([
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-dFirstPage=1',
    '-dLastPage=1',
    '-sDEVICE=tiffsep',
    '-sCompression=none',
    '-r72',
    `-sOutputFile=${path.join(directory, 'o.tif')}`,
    pdfFile,
  ]);
  const files = await readdir(directory);
  const process = new Set(['o(Cyan).tif', 'o(Magenta).tif', 'o(Yellow).tif', 'o(Black).tif']);
  return files
    .filter(file => isPlateFile(file) && (includeProcess || !process.has(file)))
    .map(file => ({ name: decodePlateName(file), file: path.join(directory, file) }));
};

/** The spot plates tiffsep made for each page, by 1-based page number, and the pages Ghostscript reported it could not draw. */
export interface PagePlates {
  readonly plates: ReadonlyMap<number, ReadonlyArray<Uint8Array>>;
  readonly failed: ReadonlySet<number>;
}

const PROCESS_PLATES = new Set(['Cyan', 'Magenta', 'Yellow', 'Black']);

// tiffsep needs %d in the output name to write more than one page; each page N then gives pN.tif and one pN(name).tif per plate.
export const renderPagePlates = async (pdfFile: string, directory: string, resolution = 20): Promise<PagePlates> => {
  await mkdir(directory, { recursive: true });
  const child = spawn('gs', [
    '-dNOPAUSE',
    '-dBATCH',
    '-sDEVICE=tiffsep',
    '-sCompression=none',
    `-r${String(resolution)}`,
    `-sOutputFile=${path.join(directory, 'p%d.tif')}`,
    pdfFile,
  ]);
  const [closed, stdout, stderr] = await Promise.all([once(child, 'close'), text(child.stdout), text(child.stderr)]);
  if (closed[0] !== 0) {
    throw new Error(`Ghostscript exited ${String(closed[0])}: ${stderr}`);
  }
  const failed = new Set<number>();
  let page = 0;
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const started = /^Page (\d+)$/u.exec(line.trim());
    if (started !== null) {
      page = Number(started[1]);
    } else if (line.includes('Page drawing error')) {
      failed.add(page);
    }
  }
  const plates = new Map<number, Array<Uint8Array>>();
  for (const file of await readdir(directory)) {
    const match = /^p(\d+)\((.*)\)\.tif$/u.exec(file);
    if (match === null) {
      continue;
    }
    const name = decodePlateName(`p(${match[2] ?? ''}).tif`);
    if (PROCESS_PLATES.has(new TextDecoder('latin1').decode(name))) {
      continue;
    }
    const number = Number(match[1]);
    plates.set(number, [...(plates.get(number) ?? []), name]);
  }
  return { plates, failed };
};

export interface TiffData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly samplesPerPixel: number;
}

// TIFF 6.0, section 2: BYTE (1), SHORT (3) and LONG (4) values, stored in the entry itself when they fit in four bytes. Other types are not read.
const TYPE_SIZES = new Map([
  [1, 1],
  [3, 2],
  [4, 4],
]);

const tiffValues = (...[view, littleEndian, entryOffset]: [DataView, boolean, number]): Array<number> => {
  const type = view.getUint16(entryOffset + 2, littleEndian);
  const count = view.getUint32(entryOffset + 4, littleEndian);
  const size = TYPE_SIZES.get(type);
  if (size === undefined) {
    return [];
  }
  const dataOffset = count * size <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, littleEndian);
  return Array.from({ length: count }, (_, item) => {
    const at = dataOffset + item * size;
    return size === 1 ? view.getUint8(at) : size === 2 ? view.getUint16(at, littleEndian) : view.getUint32(at, littleEndian);
  });
};

/** The pixels of an uncompressed 8-bit TIFF as tiffsep and tiff32nc write it; anything else, or strips that do not hold exactly width × height pixels, is refused. */
export const parseTiff = (bytes: Uint8Array): TiffData => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  if ((!littleEndian && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) || view.getUint16(2, littleEndian) !== 42) {
    throw new Error('invalid TIFF header');
  }
  const ifd = view.getUint32(4, littleEndian);
  const tags = new Map<number, Array<number>>();
  for (let index = 0; index < view.getUint16(ifd, littleEndian); index++) {
    const entry = ifd + 2 + 12 * index;
    tags.set(view.getUint16(entry, littleEndian), tiffValues(view, littleEndian, entry));
  }
  const width = tags.get(256)?.[0];
  const height = tags.get(257)?.[0];
  const samplesPerPixel = tags.get(277)?.[0] ?? 1;
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  const bits = tags.get(258) ?? [1];
  if (width === undefined || height === undefined || (tags.get(259)?.[0] ?? 1) !== 1 || (tags.get(284)?.[0] ?? 1) !== 1 || offsets.length !== counts.length) {
    throw new Error('unsupported TIFF plate: it must be uncompressed, chunky and have one byte count per strip');
  }
  if (bits.length !== samplesPerPixel || bits.some(depth => depth !== 8)) {
    throw new Error(`unsupported TIFF plate: ${JSON.stringify(bits)} bits per sample`);
  }
  const data = new Uint8Array(counts.reduce((sum, count) => sum + count, 0));
  if (data.length !== width * height * samplesPerPixel) {
    throw new Error(
      `TIFF strips hold ${String(data.length)} bytes, not the ${String(width * height * samplesPerPixel)} of ${String(width)} × ${String(height)} pixels`,
    );
  }
  let cursor = 0;
  for (const [index, offset] of offsets.entries()) {
    const strip = bytes.subarray(offset, offset + (counts[index] ?? 0));
    if (strip.length !== counts[index]) {
      throw new Error(`TIFF strip ${String(index)} runs past the end of the file`);
    }
    data.set(strip, cursor);
    cursor += strip.length;
  }
  return { width, height, data, samplesPerPixel };
};

/** The index of the first sample of pixel (x, y); a coordinate that is not a pixel of the image is refused rather than read from a neighbouring row or past the end. */
export const sampleIndex = (image: { readonly width: number; readonly height: number; readonly samplesPerPixel: number }, x: number, y: number): number => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new RangeError(`(${String(x)}, ${String(y)}) is not a pixel of a ${String(image.width)} × ${String(image.height)} image`);
  }
  return (y * image.width + x) * image.samplesPerPixel;
};

export const readPlate = async (files: ReadonlyArray<PlateFile>, name: Uint8Array): Promise<Plate> => {
  const file = files.find(plate => plate.name.length === name.length && plate.name.every((byte, index) => byte === name[index]));
  if (file === undefined) {
    throw new Error('missing separation plate');
  }
  const tiff = parseTiff(await readFile(file.file));
  if (tiff.samplesPerPixel !== 1) {
    throw new Error(`a separation plate has one sample per pixel, not ${String(tiff.samplesPerPixel)}`);
  }
  // tiffsep writes each separation with 0 for full ink and 255 for none.
  return { ...file, width: tiff.width, height: tiff.height, inkAt: (x, y): number => 255 - (tiff.data[sampleIndex(tiff, x, y)] ?? 255) };
};

/** The pixels of a binary PAM image with 8-bit samples (MAXVAL 255), as MuPDF writes it; a header it cannot read or data of the wrong length is refused. */
export const parsePam = (bytes: Uint8Array): TiffData => {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const end = header.indexOf('ENDHDR\n');
  const field = (name: string): number => Number(new RegExp(`^${name} (\\d+)$`, 'mu').exec(header.slice(0, Math.max(0, end)))?.[1]);
  const [width = Number.NaN, height = Number.NaN, samplesPerPixel = Number.NaN, maximum = Number.NaN] = ['WIDTH', 'HEIGHT', 'DEPTH', 'MAXVAL'].map(field);
  if (!header.startsWith('P7\n') || end === -1 || maximum !== 255) {
    throw new Error('invalid MuPDF PAM output');
  }
  const data = bytes.subarray(end + 'ENDHDR\n'.length);
  if (![width, height, samplesPerPixel].every(Number.isInteger) || data.length !== width * height * samplesPerPixel) {
    throw new Error('MuPDF PAM data does not match its header');
  }
  return { width, height, data, samplesPerPixel };
};

/** The RGB value of one pixel of page 1 as MuPDF draws it at 72 dpi. */
export const renderRgbPixel = async (...[pdfFile, output, x, y]: [string, string, number, number]): Promise<readonly [number, number, number]> => {
  const child = spawn('mutool', ['draw', '-q', '-O', '2', '-c', 'rgb', '-F', 'pam', '-o', output, pdfFile, '1']);
  const [closed, stderr] = await Promise.all([once(child, 'close'), text(child.stderr)]);
  if (closed[0] !== 0) {
    throw new Error(`MuPDF exited ${String(closed[0])}: ${stderr}`);
  }
  const image = parsePam(await readFile(output));
  if (image.samplesPerPixel !== 3) {
    throw new Error('invalid MuPDF RGB pixel');
  }
  const offset = sampleIndex(image, x, y);
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
};

/** The CMYK value of one pixel of page 1 as Ghostscript draws it at 72 dpi with tiff32nc. */
export const renderGsCmykPixel = async (...[pdfFile, output, x, y]: [string, string, number, number]): Promise<readonly [number, number, number, number]> => {
  await runGhostscript([
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    '-dFirstPage=1',
    '-dLastPage=1',
    '-sDEVICE=tiff32nc',
    '-sCompression=none',
    '-r72',
    `-sOutputFile=${output}`,
    pdfFile,
  ]);
  const tiff = parseTiff(await readFile(output));
  if (tiff.samplesPerPixel !== 4) {
    throw new Error('invalid Ghostscript CMYK TIFF pixel');
  }
  const offset = sampleIndex(tiff, x, y);
  return [tiff.data[offset] ?? 0, tiff.data[offset + 1] ?? 0, tiff.data[offset + 2] ?? 0, tiff.data[offset + 3] ?? 0];
};
