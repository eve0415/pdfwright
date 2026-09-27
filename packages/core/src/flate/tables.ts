// RFC 1951, 3.2.5: base values and extra-bit counts for length symbols 257-285 and distance symbols 0-29.
export const LENGTH_BASE: readonly number[] = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
export const LENGTH_EXTRA: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
export const DISTANCE_BASE: readonly number[] = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12_289, 16_385, 24_577,
];
export const DISTANCE_EXTRA: readonly number[] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// RFC 1951, 3.2.7: the order in which code length code lengths are stored.
export const CODE_LENGTH_ORDER: readonly number[] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// RFC 1951, 3.2.6: fixed literal/length code lengths (8, 9, 7, 8 bits by symbol range) and five-bit distance codes.
export const FIXED_LITERAL_LENGTHS: readonly number[] = Array.from({ length: 288 }, (_, symbol) => {
  if (symbol < 144) return 8;
  if (symbol < 256) return 9;
  if (symbol < 280) return 7;
  return 8;
});
export const FIXED_DISTANCE_LENGTHS: readonly number[] = Array.from({ length: 32 }, () => 5);

// RFC 1951, 3.1.1: "Huffman codes are packed starting with the most-significant bit of the code", so writers and readers of the least-significant-bit-first stream use each code bit-reversed.
export const reverseBits = (code: number, length: number): number => {
  let reversed = 0;
  let remaining = code;
  for (let bit = 0; bit < length; bit++) {
    reversed = (reversed << 1) | (remaining & 1);
    remaining >>>= 1;
  }
  return reversed;
};
