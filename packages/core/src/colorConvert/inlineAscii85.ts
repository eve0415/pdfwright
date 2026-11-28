/**
 * The Filter entry of a Flate inline image that conversion writes (ISO 32000-1:2008, 8.9.7, Table 94 abbreviations).
 * Filtered inline data ends at the first EI between white-space characters, and ASCII85 text holds no white space, so the data cannot end early.
 */
export const INLINE_FLATE_FILTER = '/F [/A85 /Fl]';

// ISO 32000-1:2008, 7.4.3: four bytes become five base-85 digits from !, four zero bytes become z, and a final group of n bytes is padded with zeros and cut to n + 1 digits before the ~> end marker.
/** Encodes data as ASCII85 text with its end marker. */
export const encodeAscii85 = (data: Uint8Array): Uint8Array => {
  const output = new Uint8Array(Math.ceil(data.length / 4) * 5 + 2);
  let used = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const count = Math.min(4, data.length - offset);
    let value = 0;
    for (let index = 0; index < 4; index++) {
      value = value * 256 + (index < count ? (data[offset + index] ?? 0) : 0);
    }
    if (count === 4 && value === 0) {
      output[used++] = 0x7a;
      continue;
    }
    for (let index = 4; index >= 0; index--) {
      output[used + index] = 0x21 + (value % 85);
      value = Math.floor(value / 85);
    }
    used += count + 1;
  }
  output[used++] = 0x7e;
  output[used++] = 0x3e;
  return output.subarray(0, used);
};
