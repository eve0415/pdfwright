import type { TableLut } from './iccLut.ts';
import type { MultiLut } from './iccMultiLut.ts';
import type { IccHeader, IccTagRecord, IccWarning, Xyz } from './iccStructure.ts';
import type { Curve, Matrix3 } from './iccTags.ts';

import { InvalidProfileError } from '../error/invalidProfileError.ts';

import { readLut } from './iccLut.ts';
import { readMultiLut } from './iccMultiLut.ts';
import { parseIccStructure } from './iccStructure.ts';
import { readCurve, readSf32, readXyz } from './iccTags.ts';
import { readIccText } from './iccText.ts';

export interface IccProfile {
  readonly header: IccHeader;
  readonly description: string | undefined;
  readonly copyright: string | undefined;
  readonly mediaWhitePoint: Xyz | undefined;
  readonly mediaBlackPoint: Xyz | undefined;
  readonly chromaticAdaptation: Matrix3 | undefined;
  readonly colorants: { readonly red: Xyz; readonly green: Xyz; readonly blue: Xyz } | undefined;
  readonly trc: { readonly red: Curve; readonly green: Curve; readonly blue: Curve } | { readonly gray: Curve } | undefined;
  readonly deviceToPcs: Readonly<Partial<Record<0 | 1 | 2, LutTag>>>;
  readonly pcsToDevice: Readonly<Partial<Record<0 | 1 | 2, LutTag>>>;
  readonly identity: Uint8Array;
  readonly bytes: Uint8Array;
  readonly warnings: readonly IccWarning[];
}

export type LutTag = TableLut | MultiLut;

const channels = (space: IccHeader['colorSpace']): number => {
  if (typeof space === 'object') return space.colorants;
  if (space === 'Gray') return 1;
  if (space === 'CMYK') return 4;
  return 3;
};

export const parseIccProfile = (source: Uint8Array): IccProfile => {
  const structure = parseIccStructure(source);
  const tags = new Map<string, IccTagRecord>(structure.tags.map(tag => [tag.signature, tag]));
  const xyz = (name: string): Xyz | undefined => {
    const tag = tags.get(name);
    return tag === undefined ? undefined : readXyz(structure.bytes, tag.offset, tag.offset + tag.size);
  };
  const curve = (name: string): Curve | undefined => {
    const tag = tags.get(name);
    return tag === undefined ? undefined : readCurve(structure.bytes, tag.offset, tag.offset + tag.size).curve;
  };
  const text = (name: string): string | undefined => {
    const tag = tags.get(name);
    return tag === undefined ? undefined : readIccText(structure.bytes, tag.offset, tag.offset + tag.size);
  };
  const red = xyz('rXYZ');
  const green = xyz('gXYZ');
  const blue = xyz('bXYZ');
  const redTrc = curve('rTRC');
  const greenTrc = curve('gTRC');
  const blueTrc = curve('bTRC');
  const grayTrc = curve('kTRC');
  const chad = tags.get('chad');
  const readDirection = (prefix: 'A2B' | 'B2A'): Partial<Record<0 | 1 | 2, LutTag>> => {
    const result: Partial<Record<0 | 1 | 2, LutTag>> = {};
    for (const intent of [0, 1, 2] as const) {
      const tag = tags.get(`${prefix}${String(intent)}`);
      if (tag === undefined) continue;
      const type = new TextDecoder('ascii').decode(structure.bytes.subarray(tag.offset, tag.offset + 4));
      if ((type === 'mAB ' && prefix === 'B2A') || (type === 'mBA ' && prefix === 'A2B')) {
        throw new InvalidProfileError('ICC LUT type disagrees with direction', 'tag-type-mismatch', { offset: tag.offset, tag: tag.signature });
      }
      const lut =
        type === 'mAB ' || type === 'mBA '
          ? readMultiLut(structure.bytes, tag.offset, tag.offset + tag.size)
          : readLut(structure.bytes, tag.offset, tag.offset + tag.size);
      const input = prefix === 'A2B' ? channels(structure.header.colorSpace) : channels(structure.header.pcs);
      const output = prefix === 'A2B' ? channels(structure.header.pcs) : channels(structure.header.colorSpace);
      if (structure.bytes[tag.offset + 8] !== input || structure.bytes[tag.offset + 9] !== output) {
        throw new InvalidProfileError('ICC LUT channel count disagrees with header', 'channel-mismatch', { offset: tag.offset, tag: tag.signature });
      }
      result[intent] = lut;
    }
    return result;
  };
  const trc = (): IccProfile['trc'] => {
    if (redTrc !== undefined && greenTrc !== undefined && blueTrc !== undefined) return { red: redTrc, green: greenTrc, blue: blueTrc };
    if (grayTrc !== undefined) return { gray: grayTrc };
    return undefined;
  };
  return {
    header: structure.header,
    description: text('desc'),
    copyright: text('cprt'),
    mediaWhitePoint: xyz('wtpt'),
    mediaBlackPoint: xyz('bkpt'),
    chromaticAdaptation: chad === undefined ? undefined : readSf32(structure.bytes, chad.offset, chad.offset + chad.size),
    colorants: red === undefined || green === undefined || blue === undefined ? undefined : { red, green, blue },
    trc: trc(),
    deviceToPcs: readDirection('A2B'),
    pcsToDevice: readDirection('B2A'),
    identity: structure.identity,
    bytes: structure.bytes,
    warnings: structure.warnings,
  };
};
