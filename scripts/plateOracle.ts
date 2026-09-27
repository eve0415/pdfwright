import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir } from 'node:fs/promises';
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
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(encoded.codePointAt(index) ?? 0);
  }
  return Uint8Array.from(bytes);
};

export const renderPlates = async (pdfFile: string, directory: string, includeProcess = false): Promise<PlateFile[]> => {
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'o.tif');
  const child = spawn('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiffsep', '-sCompression=none', '-r72', `-sOutputFile=${output}`, pdfFile]);
  const [closed, stderr] = await Promise.all([once(child, 'close'), text(child.stderr)]);
  if (closed[0] !== 0) throw new Error(`Ghostscript exited ${String(closed[0])}: ${stderr}`);
  const files = await readdir(directory);
  const process = new Set(['o(Cyan).tif', 'o(Magenta).tif', 'o(Yellow).tif', 'o(Black).tif']);
  return files
    .filter(file => file.startsWith('o(') && file.endsWith(').tif') && (includeProcess || !process.has(file)))
    .map(file => ({ name: decodePlateName(file), file: path.join(directory, file) }));
};

/** The spot plates tiffsep made for each page, by 1-based page number, and the pages Ghostscript reported it could not draw. */
export interface PagePlates {
  readonly plates: ReadonlyMap<number, readonly Uint8Array[]>;
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
  if (closed[0] !== 0) throw new Error(`Ghostscript exited ${String(closed[0])}: ${stderr}`);
  const failed = new Set<number>();
  let page = 0;
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const started = /^Page (\d+)$/u.exec(line.trim());
    if (started !== null) page = Number(started[1]);
    else if (line.includes('Page drawing error')) failed.add(page);
  }
  const plates = new Map<number, Uint8Array[]>();
  for (const file of await readdir(directory)) {
    const match = /^p(\d+)\((.*)\)\.tif$/u.exec(file);
    if (match === null) continue;
    const name = decodePlateName(`p(${match[2] ?? ''}).tif`);
    if (PROCESS_PLATES.has(new TextDecoder('latin1').decode(name))) continue;
    const number = Number(match[1]);
    plates.set(number, [...(plates.get(number) ?? []), name]);
  }
  return { plates, failed };
};

interface TiffData {
  width: number;
  height: number;
  data: Uint8Array;
  samplesPerPixel: number;
}

const tiffValues = (...[bytes, view, littleEndian, entryOffset]: [Uint8Array, DataView, boolean, number]): number[] => {
  const type = view.getUint16(entryOffset + 2, littleEndian);
  const count = view.getUint32(entryOffset + 4, littleEndian);
  let elementSize = 1;
  if (type === 3) elementSize = 2;
  if (type === 4) elementSize = 4;
  const dataOffset = count * elementSize <= 4 ? entryOffset + 8 : view.getUint32(entryOffset + 8, littleEndian);
  const values: number[] = [];
  for (let item = 0; item < count; item++) {
    if (type === 3) values.push(view.getUint16(dataOffset + item * 2, littleEndian));
    else if (type === 4) values.push(view.getUint32(dataOffset + item * 4, littleEndian));
    else values.push(bytes[dataOffset + item] ?? 0);
  }
  return values;
};

const readTags = (bytes: Uint8Array, view: DataView, littleEndian: boolean): Map<number, number[]> => {
  const ifd = view.getUint32(4, littleEndian);
  const entries = view.getUint16(ifd, littleEndian);
  const tags = new Map<number, number[]>();
  for (let index = 0; index < entries; index++) {
    const offset = ifd + 2 + 12 * index;
    tags.set(view.getUint16(offset, littleEndian), tiffValues(bytes, view, littleEndian, offset));
  }
  return tags;
};

const readTiff = async (file: string): Promise<TiffData> => {
  const bytes = await readFile(file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!littleEndian && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new Error('invalid TIFF byte order');
  const tags = readTags(bytes, view, littleEndian);
  const width = tags.get(256)?.[0];
  const height = tags.get(257)?.[0];
  const compression = tags.get(259)?.[0] ?? 1;
  const samplesPerPixel = tags.get(277)?.[0] ?? 1;
  const offsets = tags.get(273);
  const counts = tags.get(279);
  if (width === undefined || height === undefined || offsets === undefined || counts === undefined || compression !== 1) {
    throw new Error('unsupported TIFF plate');
  }
  const data = new Uint8Array(counts.reduce((sum, count) => sum + count, 0));
  let cursor = 0;
  for (let index = 0; index < offsets.length; index++) {
    const strip = bytes.subarray(offsets[index] ?? 0, (offsets[index] ?? 0) + (counts[index] ?? 0));
    data.set(strip, cursor);
    cursor += strip.length;
  }
  return { width, height, data, samplesPerPixel };
};

export const readPlate = async (files: readonly PlateFile[], name: Uint8Array): Promise<Plate> => {
  const file = files.find(plate => plate.name.length === name.length && plate.name.every((byte, index) => byte === name[index]));
  if (file === undefined) throw new Error('missing separation plate');
  const tiff = await readTiff(file.file);
  return {
    ...file,
    width: tiff.width,
    height: tiff.height,
    inkAt: (x, y): number => 255 - (tiff.data[(y * tiff.width + x) * tiff.samplesPerPixel] ?? 255),
  };
};

export const renderRgbPixel = async (...[pdfFile, output, x, y]: [string, string, number, number]): Promise<readonly [number, number, number]> => {
  const child = spawn('mutool', ['draw', '-q', '-O', '2', '-c', 'rgb', '-F', 'pam', '-o', output, pdfFile]);
  const [closed, stderr] = await Promise.all([once(child, 'close'), text(child.stderr)]);
  if (closed[0] !== 0) throw new Error(`MuPDF exited ${String(closed[0])}: ${stderr}`);
  const bytes = await readFile(output);
  const header = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 200)));
  const end = header.indexOf('ENDHDR\n');
  const widthText = /^WIDTH (\d+)$/mu.exec(header)?.[1];
  const depthText = /^DEPTH (\d+)$/mu.exec(header)?.[1];
  if (end === -1 || widthText === undefined || depthText === undefined) throw new Error('invalid MuPDF PAM output');
  const width = Number(widthText);
  const depth = Number(depthText);
  const offset = end + 7 + (y * width + x) * depth;
  const red = bytes[offset];
  const green = bytes[offset + 1];
  const blue = bytes[offset + 2];
  if (depth !== 3 || red === undefined || green === undefined || blue === undefined) throw new Error('invalid MuPDF RGB pixel');
  return [red, green, blue];
};

export const renderGsCmykPixel = async (...[pdfFile, output, x, y]: [string, string, number, number]): Promise<readonly [number, number, number, number]> => {
  const child = spawn('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=tiff32nc', '-sCompression=none', '-r72', `-sOutputFile=${output}`, pdfFile]);
  const [closed, stderr] = await Promise.all([once(child, 'close'), text(child.stderr)]);
  if (closed[0] !== 0) throw new Error(`Ghostscript exited ${String(closed[0])}: ${stderr}`);
  const tiff = await readTiff(output);
  const offset = (y * tiff.width + x) * tiff.samplesPerPixel;
  const cyan = tiff.data[offset];
  const magenta = tiff.data[offset + 1];
  const yellow = tiff.data[offset + 2];
  const black = tiff.data[offset + 3];
  if (tiff.samplesPerPixel !== 4 || cyan === undefined || magenta === undefined || yellow === undefined || black === undefined) {
    throw new Error('invalid Ghostscript CMYK TIFF pixel');
  }
  return [cyan, magenta, yellow, black];
};
