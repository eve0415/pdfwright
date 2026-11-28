// Builds small ICC profiles from tag data for colour transform tests.

const D50 = [0.9642, 1, 0.8249] as const;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

// ICC.1:2022, 4.7 and 7.2: a signature is four bytes, written here from four printable ASCII characters; a shorter one would shift every later field.
const signature = (text: string): Uint8Array => {
  if (!/^[\u0020-\u007E]{4}$/u.test(text)) {
    throw new RangeError(`${JSON.stringify(text)} is not a four-character signature`);
  }
  return ascii(text);
};

// ICC.1:2022, 7.3.4 and 7.4: tag data elements start on 4-byte boundaries, padded with up to three bytes.
const padded = (length: number): number => Math.ceil(length / 4) * 4;

const setFixed = (view: DataView, offset: number, value: number): void => {
  // ICC.1:2022, 4.6: s15Fixed16Number, from -32768 to 32767 + 65535/65536; setInt32 would wrap anything outside it.
  const fixed = Math.round(value * 65_536);
  if (!Number.isFinite(value) || fixed < -(2 ** 31) || fixed >= 2 ** 31) {
    throw new RangeError(`${String(value)} is outside s15Fixed16Number`);
  }
  view.setInt32(offset, fixed);
};

/** An XYZType tag holding one XYZ number under ICC.1:2022, 10.31. */
export const xyzTag = (values: readonly [number, number, number]): Uint8Array => {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('XYZ '));
  for (const [index, value] of values.entries()) {
    setFixed(view, 8 + index * 4, value);
  }
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
export const sampledCurveTag = (samples: ReadonlyArray<number>): Uint8Array => {
  // ICC.1:2022, 10.6: a count of 0 or 1 means identity or a gamma, not samples.
  if (samples.length < 2 || !samples.every(sample => Number.isInteger(sample) && sample >= 0 && sample <= 0xff_ff)) {
    throw new RangeError('a sampled curve needs two or more integer samples from 0 to 65535');
  }
  const bytes = new Uint8Array(12 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set(ascii('curv'));
  view.setUint32(8, samples.length);
  for (const [index, sample] of samples.entries()) {
    view.setUint16(12 + index * 2, sample);
  }
  return bytes;
};

/** A three-channel lutAToBType or lutBToAType that holds only identity curves and a matrix e1..e12, under ICC.1:2022, 10.12 and 10.13. */
export const matrixLutTag = (type: 'mAB ' | 'mBA ', elements: ReadonlyArray<number>): Uint8Array => {
  if (elements.length !== 12) {
    throw new RangeError(`a matrix has 12 elements, not ${String(elements.length)}`);
  }
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
  for (const [index, value] of elements.entries()) {
    setFixed(view, matrixOffset + index * 4, value);
  }
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
  for (const [index, unit] of units.entries()) {
    view.setUint16(28 + index * 2, unit);
  }
  return bytes;
};

export interface IccProfileInput {
  /** The four-character profile class signature, such as `mntr`. */
  readonly profileClass: string;
  /** The four-character data colour space signature, such as `RGB ` or `GRAY`. */
  readonly colorSpace: string;
  readonly pcs: 'XYZ ' | 'Lab ';
  /** Tag signatures with their tag data; the description, copyright and D50 media white point tags are added. */
  readonly tags: ReadonlyArray<readonly [string, Uint8Array]>;
}

interface HeaderFields {
  readonly profileClass: string;
  readonly colorSpace: string;
  readonly pcs: string;
  readonly version?: readonly [number, number];
}

// ICC.1:2022, 7.2: the size, version, class, colour spaces, file signature, rendering intent 1 and a D50 illuminant; the caller writes the tag count.
const writeHeader = (bytes: Uint8Array, fields: HeaderFields): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [major, minor] = fields.version ?? [4, 0x40];
  view.setUint32(0, bytes.length);
  view.setUint8(8, major);
  view.setUint8(9, minor);
  bytes.set(signature(fields.profileClass), 12);
  bytes.set(signature(fields.colorSpace), 16);
  bytes.set(signature(fields.pcs), 20);
  bytes.set(ascii('acsp'), 36);
  view.setUint32(64, 1);
  for (const [index, value] of D50.entries()) {
    setFixed(view, 68 + index * 4, value);
  }
};

/** A version 4.4 ICC profile under ICC.1:2022, 7.2 and 7.3, with tag data 4-byte aligned. */
export const iccProfileBytes = (input: IccProfileInput): Uint8Array => {
  const tags: ReadonlyArray<readonly [string, Uint8Array]> = [
    ['desc', textTag('Test profile')],
    ['cprt', textTag('No copyright, use freely')],
    ['wtpt', xyzTag(D50)],
    ...input.tags,
  ];
  const duplicate = tags.find(([name], index) => tags.findIndex(([other]) => other === name) !== index);
  if (duplicate !== undefined) {
    throw new RangeError(`the tag ${duplicate[0]} is listed twice`);
  }
  let cursor = 132 + tags.length * 12;
  const bytes = new Uint8Array(cursor + tags.reduce((sum, [, data]) => sum + padded(data.length), 0));
  const view = new DataView(bytes.buffer);
  writeHeader(bytes, input);
  view.setUint32(128, tags.length);
  for (const [index, [name, data]] of tags.entries()) {
    bytes.set(signature(name), 132 + index * 12);
    view.setUint32(136 + index * 12, cursor);
    view.setUint32(140 + index * 12, data.length);
    bytes.set(data, cursor);
    cursor += padded(data.length);
  }
  return bytes;
};
