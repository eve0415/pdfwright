// RFC 1321, 3 processes padded input in 512-bit blocks with four rounds of 32-bit operations.
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16,
  23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const CONSTANTS = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122,
  0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6,
  0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60,
  0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

export interface Md5 {
  update: (bytes: Uint8Array) => Md5;
  digest: () => Uint8Array;
}

// RFC 1321, 3.3 initializes the four-word buffer; 3.4 processes each 16-word block with four rounds.
const processBlocks = (state: Uint32Array, view: DataView, end: number): void => {
  let stateA = state[0] ?? 0;
  let stateB = state[1] ?? 0;
  let stateC = state[2] ?? 0;
  let stateD = state[3] ?? 0;
  for (let block = 0; block < end; block += 64) {
    let a = stateA;
    let b = stateB;
    let c = stateC;
    let d = stateD;
    for (let step = 0; step < 64; step++) {
      let combined = (b & c) | (~b & d);
      let wordIndex = step;
      if (step >= 16 && step < 32) {
        combined = (d & b) | (~d & c);
        wordIndex = (5 * step + 1) % 16;
      } else if (step >= 32 && step < 48) {
        combined = b ^ c ^ d;
        wordIndex = (3 * step + 5) % 16;
      } else if (step >= 48) {
        combined = c ^ (b | ~d);
        wordIndex = (7 * step) % 16;
      }
      const shift = SHIFTS[step] ?? 0;
      const sum = (a + combined + view.getUint32(block + wordIndex * 4, true) + (CONSTANTS[step] ?? 0)) >>> 0;
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) >>> 0;
    }
    stateA = (stateA + a) >>> 0;
    stateB = (stateB + b) >>> 0;
    stateC = (stateC + c) >>> 0;
    stateD = (stateD + d) >>> 0;
  }
  state.set([stateA, stateB, stateC, stateD]);
};

// Hashes input supplied in any number of pieces, holding at most one partial 64-byte block between calls.
export const createMd5 = (): Md5 => {
  const state = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);
  const pending = new Uint8Array(64);
  const pendingView = new DataView(pending.buffer);
  let pendingLength = 0;
  let totalLength = 0;
  const hash: Md5 = {
    update: bytes => {
      totalLength += bytes.length;
      let offset = 0;
      if (pendingLength > 0) {
        offset = Math.min(64 - pendingLength, bytes.length);
        pending.set(bytes.subarray(0, offset), pendingLength);
        pendingLength += offset;
        if (pendingLength < 64) return hash;
        processBlocks(state, pendingView, 64);
        pendingLength = 0;
      }
      const whole = Math.floor((bytes.length - offset) / 64) * 64;
      if (whole > 0) processBlocks(state, new DataView(bytes.buffer, bytes.byteOffset + offset, whole), whole);
      pending.set(bytes.subarray(offset + whole));
      pendingLength = bytes.length - offset - whole;
      return hash;
    },
    digest: () => {
      // RFC 1321, 3.1 and 3.2 append a one bit, zeros to 56 bytes modulo 64, then the 64-bit bit length in little-endian order.
      const final = new Uint8Array(pendingLength < 56 ? 64 : 128);
      final.set(pending.subarray(0, pendingLength));
      final[pendingLength] = 0x80;
      const view = new DataView(final.buffer);
      view.setUint32(final.length - 8, (totalLength % 0x20000000) * 8, true);
      view.setUint32(final.length - 4, Math.floor(totalLength / 0x20000000), true);
      const finalState = Uint32Array.from(state);
      processBlocks(finalState, view, final.length);
      const result = new Uint8Array(16);
      const output = new DataView(result.buffer);
      for (let word = 0; word < 4; word++) output.setUint32(word * 4, finalState[word] ?? 0, true);
      return result;
    },
  };
  return hash;
};

/** Returns the 16-byte MD5 digest of the input bytes. */
export const md5 = (data: Uint8Array): Uint8Array => createMd5().update(data).digest();
