// RFC 1950, 2.2 and 9 define Adler-32 as two sums modulo 65521, initialized to 1 and 0.
/** Continues an Adler-32 checksum over more data; the checksum of no data is 1. */
export const updateAdler32 = (checksum: number, data: Uint8Array): number => {
  let first = checksum % 65536;
  let second = Math.floor(checksum / 65536);
  for (let offset = 0; offset < data.length; offset += 5552) {
    const end = Math.min(offset + 5552, data.length);
    for (let index = offset; index < end; index++) {
      first += data[index] ?? 0;
      second += first;
    }
    first %= 65521;
    second %= 65521;
  }
  return second * 65536 + first;
};

export const adler32 = (data: Uint8Array): number => updateAdler32(1, data);
