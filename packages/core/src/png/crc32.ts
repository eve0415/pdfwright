// PNG Third Edition (W3C), 5.5: the CRC is ISO 3309 / ITU-T V.42 CRC-32 with polynomial x^32+x^26+x^23+x^22+x^16+x^12+x^11+x^10+x^8+x^7+x^5+x^4+x^2+x+1, reflected as 0xedb88320, starting from all ones and complemented at the end.
const TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

/** Computes the CRC-32 of `bytes` as PNG chunks use it, continuing from `crc` when given. */
export const crc32 = (bytes: Uint8Array, crc = 0): number => {
  let value = ~crc >>> 0;
  for (const byte of bytes) value = (TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return ~value >>> 0;
};
