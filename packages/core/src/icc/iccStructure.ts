import { InvalidProfileError } from '../error/invalidProfileError.ts';
import { UnsupportedFeatureError } from '../error/unsupportedFeatureError.ts';

import { iccIdentity } from './iccIdentity.ts';

export type ProfileClass = 'input' | 'display' | 'output' | 'deviceLink' | 'colorSpace' | 'abstract' | 'namedColor';
export type DataColorSpace = 'XYZ' | 'Lab' | 'Gray' | 'RGB' | 'CMYK' | 'CMY' | 'Luv' | 'YCbCr' | 'Yxy' | 'HSV' | 'HLS' | { readonly colorants: number };
export type RenderingIntent = 'perceptual' | 'relativeColorimetric' | 'saturation' | 'absoluteColorimetric';
export interface Xyz {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface IccHeader {
  readonly size: number;
  readonly version: { readonly major: number; readonly minor: number; readonly bugfix: number };
  readonly profileClass: ProfileClass;
  readonly colorSpace: DataColorSpace;
  readonly pcs: DataColorSpace;
  readonly renderingIntent: RenderingIntent;
  readonly illuminant: Xyz;
  readonly profileId: Uint8Array;
}

export interface IccTagRecord {
  readonly signature: string;
  readonly offset: number;
  readonly size: number;
}

export interface IccWarning {
  readonly code: 'trailing-data' | 'tag-misaligned' | 'profile-id-mismatch';
  readonly offset: number;
}

export interface IccStructure {
  readonly header: IccHeader;
  readonly tags: readonly IccTagRecord[];
  readonly identity: Uint8Array;
  readonly bytes: Uint8Array;
  readonly warnings: readonly IccWarning[];
}

const classes = new Map<string, ProfileClass>([
  ['scnr', 'input'],
  ['mntr', 'display'],
  ['prtr', 'output'],
  ['link', 'deviceLink'],
  ['spac', 'colorSpace'],
  ['abst', 'abstract'],
  ['nmcl', 'namedColor'],
]);
const spaces = new Map<string, DataColorSpace>([
  ['XYZ ', 'XYZ'],
  ['Lab ', 'Lab'],
  ['GRAY', 'Gray'],
  ['RGB ', 'RGB'],
  ['CMYK', 'CMYK'],
  ['CMY ', 'CMY'],
  ['Luv ', 'Luv'],
  ['YCbr', 'YCbCr'],
  ['Yxy ', 'Yxy'],
  ['HSV ', 'HSV'],
  ['HLS ', 'HLS'],
]);
const intents: readonly RenderingIntent[] = ['perceptual', 'relativeColorimetric', 'saturation', 'absoluteColorimetric'];

const signature = (bytes: Uint8Array, offset: number): string =>
  String.fromCodePoint(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);

const space = (text: string, offset: number): DataColorSpace => {
  const known = spaces.get(text);
  if (known !== undefined) return known;
  if (text.length === 4 && text.endsWith('CLR')) {
    const channels = Number.parseInt(text.charAt(0), 16);
    if (channels >= 2 && channels <= 15) return { colorants: channels };
  }
  throw new InvalidProfileError(`unknown ICC colour space ${text}`, 'unknown-color-space', { offset });
};

const fixed = (view: DataView, offset: number): number => view.getInt32(offset) / 65536;

const readHeader = (bytes: Uint8Array, view: DataView): IccHeader => {
  // ICC.1:2022, 7.2.1 Table 17 fixes all header field positions and the 128-byte header length.
  const size = view.getUint32(0);
  if (size < 132 || size > bytes.length) throw new InvalidProfileError('ICC profile size exceeds supplied bytes', 'size-mismatch', { offset: 0 });
  if (signature(bytes, 36) !== 'acsp') throw new InvalidProfileError('missing ICC acsp signature', 'bad-signature', { offset: 36 });
  const major = bytes[8] ?? 0;
  if (major === 5) throw new UnsupportedFeatureError('ICC version 5 is unsupported', 'icc-version-5');
  if (major !== 2 && major !== 4) throw new InvalidProfileError('unsupported ICC version', 'unsupported-version', { offset: 8 });
  const profileClass = classes.get(signature(bytes, 12));
  if (profileClass === undefined) throw new InvalidProfileError('unknown ICC profile class', 'unknown-class', { offset: 12 });
  const colorSpace = space(signature(bytes, 16), 16);
  const pcs = space(signature(bytes, 20), 20);
  if (profileClass !== 'deviceLink' && pcs !== 'XYZ' && pcs !== 'Lab') throw new InvalidProfileError('invalid ICC PCS', 'unknown-color-space', { offset: 20 });
  const renderingIntent = intents[view.getUint32(64)];
  if (renderingIntent === undefined) throw new InvalidProfileError('invalid ICC rendering intent', 'bad-tag-data', { offset: 64 });
  return {
    size,
    version: { major, minor: Math.floor((bytes[9] ?? 0) / 16), bugfix: (bytes[9] ?? 0) % 16 },
    profileClass,
    colorSpace,
    pcs,
    renderingIntent,
    illuminant: { x: fixed(view, 68), y: fixed(view, 72), z: fixed(view, 76) },
    profileId: bytes.slice(84, 100),
  };
};

const readTags = (bytes: Uint8Array, view: DataView, warnings: IccWarning[]): IccTagRecord[] => {
  // ICC.1:2022, 7.3.1 Table 24 gives 12-byte records; 7.3.1 permits complete sharing but forbids partial overlap and duplicate signatures.
  const count = view.getUint32(128);
  if (count > Math.floor((bytes.length - 132) / 12)) {
    throw new InvalidProfileError('ICC tag table exceeds profile size', 'tag-table-out-of-bounds', { offset: 128 });
  }
  const tableEnd = 132 + 12 * count;
  const tags: IccTagRecord[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index++) {
    const record = 132 + index * 12;
    const name = signature(bytes, record);
    const offset = view.getUint32(record + 4);
    const size = view.getUint32(record + 8);
    if (seen.has(name)) throw new InvalidProfileError('duplicate ICC tag', 'duplicate-tag', { offset: record, tag: name });
    seen.add(name);
    if (offset < tableEnd || size < 8 || offset > bytes.length || size > bytes.length - offset) {
      throw new InvalidProfileError('ICC tag exceeds profile size', 'tag-out-of-bounds', { offset: record + 4, tag: name });
    }
    // ICC.1:2022, 7.3.4 requires four-byte alignment; misaligned tags are kept with a warning for interoperability.
    if (offset % 4 !== 0) warnings.push({ code: 'tag-misaligned', offset: record + 4 });
    for (const earlier of tags) {
      if (offset < earlier.offset + earlier.size && earlier.offset < offset + size && (offset !== earlier.offset || size !== earlier.size)) {
        throw new InvalidProfileError('ICC tags overlap', 'tag-overlap', { offset: record + 4, tag: name });
      }
    }
    tags.push({ signature: name, offset, size });
  }
  return tags;
};

export const parseIccStructure = (source: Uint8Array): IccStructure => {
  if (source.length < 132) throw new InvalidProfileError('truncated ICC profile', 'truncated', { offset: source.length });
  const copy = Uint8Array.from(source);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const header = readHeader(copy, view);
  const bytes = copy.subarray(0, header.size);
  const warnings: IccWarning[] = [];
  if (copy.length > header.size) warnings.push({ code: 'trailing-data', offset: header.size });
  const tags = readTags(bytes, view, warnings);
  const identity = iccIdentity(bytes);
  if (header.profileId.some(byte => byte !== 0) && header.profileId.some((byte, index) => byte !== identity[index])) {
    warnings.push({ code: 'profile-id-mismatch', offset: 84 });
  }
  return { header, tags, identity, bytes, warnings };
};
