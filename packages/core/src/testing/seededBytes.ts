// Generates repeatable pseudo-random bytes for tests that need data without structure, such as compressor and digest inputs.

/**
 * `length` bytes from the linear congruential generator state' = (1664525 × state + 1013904223) mod 2^32, advanced once before each byte.
 * Each byte is the top eight bits of the state, because the low bits of a generator with a power-of-two modulus repeat with short periods (the lowest byte every 256 steps).
 */
export const seededBytes = (length: number, seed: number): Uint8Array => {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`length ${String(length)} is not a non-negative integer`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xff_ff_ff_ff) {
    throw new RangeError(`seed ${String(seed)} is not a 32-bit unsigned integer`);
  }
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
};
