import type { IccHeader, IccTagRecord, IccWarning, Xyz } from './iccStructure.ts';
import type { Curve, Matrix3 } from './iccTags.ts';

import { parseIccStructure } from './iccStructure.ts';
import { readCurve, readSf32, readXyz } from './iccTags.ts';

export interface IccProfile {
  readonly header: IccHeader;
  readonly description: string | undefined;
  readonly mediaWhitePoint: Xyz | undefined;
  readonly mediaBlackPoint: Xyz | undefined;
  readonly chromaticAdaptation: Matrix3 | undefined;
  readonly colorants: { readonly red: Xyz; readonly green: Xyz; readonly blue: Xyz } | undefined;
  readonly trc: { readonly red: Curve; readonly green: Curve; readonly blue: Curve } | { readonly gray: Curve } | undefined;
  readonly identity: Uint8Array;
  readonly bytes: Uint8Array;
  readonly warnings: readonly IccWarning[];
}

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
  const red = xyz('rXYZ');
  const green = xyz('gXYZ');
  const blue = xyz('bXYZ');
  const redTrc = curve('rTRC');
  const greenTrc = curve('gTRC');
  const blueTrc = curve('bTRC');
  const grayTrc = curve('kTRC');
  const chad = tags.get('chad');
  const trc = (): IccProfile['trc'] => {
    if (redTrc !== undefined && greenTrc !== undefined && blueTrc !== undefined) return { red: redTrc, green: greenTrc, blue: blueTrc };
    if (grayTrc !== undefined) return { gray: grayTrc };
    return undefined;
  };
  return {
    header: structure.header,
    description: undefined,
    mediaWhitePoint: xyz('wtpt'),
    mediaBlackPoint: xyz('bkpt'),
    chromaticAdaptation: chad === undefined ? undefined : readSf32(structure.bytes, chad.offset, chad.offset + chad.size),
    colorants: red === undefined || green === undefined || blue === undefined ? undefined : { red, green, blue },
    trc: trc(),
    identity: structure.identity,
    bytes: structure.bytes,
    warnings: structure.warnings,
  };
};
