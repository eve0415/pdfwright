// Builds small ICC profiles from tag data for colour transform tests.

const D50 = [0.9642, 1, 0.8249] as const;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

// ICC.1:2022, 7.3.4 and 7.4: tag data elements start on 4-byte boundaries, padded with up to three bytes.
const padded = (length: number): number => Math.ceil(length / 4) * 4;

const setFixed = (view: DataView, offset: number, value: number): void => {
  // ICC.1:2022, 4.6: s15Fixed16Number.
  view.setInt32(offset, Math.round(value * 65536));
};

/** An XYZType tag holding one XYZ number under ICC.1:2022, 10.31. */
export const xyzTag = (values: readonly [number, number, number]): Uint8Array => {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('XYZ '));
  for (const [index, value] of values.entries()) setFixed(view, 8 + index * 4, value);
  return bytes;
};

/** A parametricCurveType function type 0, y = x^gamma, under ICC.1:2022, 10.18. */
export const gammaCurveTag = (gamma: number): Uint8Array => {
  const bytes = new Uint8Array(16);
  bytes.set(ascii('para'));
  setFixed(new DataView(bytes.buffer), 12, gamma);
  return bytes;
};

/** A curveType with two or more 16-bit samples under ICC.1:2022, 10.6. */
export const sampledCurveTag = (samples: readonly number[]): Uint8Array => {
  const bytes = new Uint8Array(12 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('curv'));
  view.setUint32(8, samples.length);
  for (const [index, sample] of samples.entries()) view.setUint16(12 + index * 2, sample);
  return bytes;
};

/** A three-channel lutAToBType or lutBToAType that holds only identity curves and a matrix e1..e12, under ICC.1:2022, 10.12 and 10.13. */
export const matrixLutTag = (type: 'mAB ' | 'mBA ', elements: readonly number[]): Uint8Array => {
  const curve = gammaCurveTag(1);
  const bOffset = 32;
  const matrixOffset = bOffset + 3 * curve.length;
  const mOffset = matrixOffset + 48;
  const bytes = new Uint8Array(mOffset + 3 * curve.length);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii(type));
  bytes[8] = 3;
  bytes[9] = 3;
  view.setUint32(12, bOffset);
  view.setUint32(16, matrixOffset);
  view.setUint32(20, mOffset);
  for (let index = 0; index < 3; index++) {
    bytes.set(curve, bOffset + index * curve.length);
    bytes.set(curve, mOffset + index * curve.length);
  }
  for (const [index, value] of elements.entries()) setFixed(view, matrixOffset + index * 4, value);
  return bytes;
};

const textTag = (text: string): Uint8Array => {
  // ICC.1:2022, 10.15: multiLocalizedUnicodeType with one en-US record.
  const units = Array.from(text, character => character.codePointAt(0) ?? 0);
  const bytes = new Uint8Array(28 + units.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('mluc'));
  view.setUint32(8, 1);
  view.setUint32(12, 12);
  bytes.set(ascii('enUS'), 16);
  view.setUint32(20, units.length * 2);
  view.setUint32(24, 28);
  for (const [index, unit] of units.entries()) view.setUint16(28 + index * 2, unit);
  return bytes;
};

export interface IccProfileInput {
  /** The four-character profile class signature, such as `mntr`. */
  readonly profileClass: string;
  /** The four-character data colour space signature, such as `RGB ` or `GRAY`. */
  readonly colorSpace: string;
  readonly pcs: 'XYZ ' | 'Lab ';
  /** Tag signatures with their tag data; the description, copyright and D50 media white point tags are added. */
  readonly tags: readonly (readonly [string, Uint8Array])[];
}

/** A version 4.4 ICC profile under ICC.1:2022, 7.2 and 7.3, with tag data 4-byte aligned. */
export const iccProfileBytes = (input: IccProfileInput): Uint8Array => {
  const tags: readonly (readonly [string, Uint8Array])[] = [
    ['desc', textTag('Test profile')],
    ['cprt', textTag('No copyright, use freely')],
    ['wtpt', xyzTag(D50)],
    ...input.tags,
  ];
  let cursor = 132 + tags.length * 12;
  const bytes = new Uint8Array(cursor + tags.reduce((sum, [, data]) => sum + padded(data.length), 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes[8] = 4;
  bytes[9] = 0x40;
  bytes.set(ascii(input.profileClass + input.colorSpace + input.pcs), 12);
  bytes.set(ascii('acsp'), 36);
  view.setUint32(64, 1);
  for (const [index, value] of D50.entries()) setFixed(view, 68 + index * 4, value);
  view.setUint32(128, tags.length);
  for (const [index, [signature, data]] of tags.entries()) {
    bytes.set(ascii(signature), 132 + index * 12);
    view.setUint32(136 + index * 12, cursor);
    view.setUint32(140 + index * 12, data.length);
    bytes.set(data, cursor);
    cursor += padded(data.length);
  }
  return bytes;
};
