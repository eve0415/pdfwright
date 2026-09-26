// RFC 1950, 2.2 and 9 define Adler-32 as two sums modulo 65521, initialized to 1 and 0.
export const adler32 = (data: Uint8Array): number => {
  let first = 1;
  let second = 0;
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
