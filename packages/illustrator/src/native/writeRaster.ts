import type { RasterItem } from '../model/illustratorDocument.ts';
import type { NativeWriter } from './nativeWriter.ts';

import { coordinateNumber } from '../model/coordinateNumber.ts';

import { formatNativeNumber } from './formatNativeNumber.ts';
import { nameBasedUuid } from './nameBasedUuid.ts';
import { escapeNativeString } from './nativeString.ts';

export interface NativeRasterOptions {
  readonly itemPath: string;
  readonly yOffset?: number;
}

const encoder = new TextEncoder();
const number = coordinateNumber;

const writeUuid = (writer: NativeWriter, key: string, uuid: string): void => {
  writer.raw(encoder.encode('%_'));
  writer.raw(escapeNativeString(uuid, 'ascii'));
  writer.line(` /UnicodeString (${key}) ,`);
};

/** Writes one CMYK or Separation raster with raw colour bytes and a separate alpha plane. */
export const writeRaster = (writer: NativeWriter, item: RasterItem, options: NativeRasterOptions): void => {
  const spot = item.color.space === 'spot';
  const samples = spot ? (item.color.samples ?? new Uint8Array(item.width * item.height).fill(255)) : item.color.samples;
  const scaleX = number(item.bounds.width) / item.width;
  const scaleY = number(item.bounds.height) / item.height;
  const tx = number(item.bounds.x);
  const ty = number(item.bounds.y) + number(item.bounds.height) + (options.yOffset ?? 0);
  const matrix = `[ ${[scaleX, 0, 0, scaleY, tx, ty].map(value => formatNativeNumber(value)).join(' ')} ]`;
  if (item.color.space === 'spot') {
    writer.line('0 O');
    writer.line(...item.color.spot.alternate.map(component => formatNativeNumber(component)), { utf8: item.color.spot.name }, '0 x');
  }
  writer.line('0 1 0 0 0 Xy');
  writer.line('0 J 0 j 1 w 10 M []0 d');
  writer.line('0 XR');
  writer.line('%AI5_File:');
  writer.line('%AI5_BeginRaster');
  writer.line(spot ? '() 1 XG' : '() 0 XG');
  if (item.color.space === 'cmyk') writer.line('/DeviceCMYK XN');
  else {
    writer.raw(encoder.encode(`1 [${item.color.spot.alternate.map(component => formatNativeNumber(component)).join(' ')} /DeviceCMYK `));
    writer.raw(escapeNativeString(item.color.spot.name));
    writer.line(' /Separation] XC');
  }
  writer.line(`${matrix} ${String(item.width)} ${String(item.height)} ${spot ? '3' : '0'} Xh`);
  writer.line(
    `${matrix} 0 0 ${String(item.width)} ${String(item.height)} ${String(item.width)} ${String(item.height)} 8 ${spot ? '1' : '4'} 1 ${spot ? '16' : '18'} 1 ${spot ? '3' : '0'} 4 4 0 0`,
  );
  writer.line(`%%BeginData: ${String(3 + samples.length)}`);
  writer.raw(encoder.encode('XI\n'));
  writer.raw(samples);
  writer.raw(item.alpha);
  writer.line('%%EndData');
  writer.line('XH');
  writer.line('%AI17_Begin_Content_if_version_gt:24 17');
  writer.line('72 72 Xr');
  writer.line('%AI17_End_Versioned_Content');
  writer.line('%AI5_EndRaster');
  writer.line(spot ? 'F' : 'N');
  writer.line('%_/ArtDictionary :');
  writer.line(`%_${formatNativeNumber(scaleX)} /Real (Raster Art Original Scale) ,`);
  writeUuid(writer, 'AI24 ImageRawDataUUID', nameBasedUuid('raster-color', samples, options.itemPath));
  writeUuid(writer, 'AI24 ImageAlphaRawDataUUID', nameBasedUuid('raster-alpha', item.alpha, options.itemPath));
  writer.line('%_;');
  writer.line('%_');
};
