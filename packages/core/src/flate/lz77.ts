import { DISTANCE_BASE, DISTANCE_CODE, LENGTH_BASE, LENGTH_CODE } from './tables.ts';

interface LevelLimits {
  chain: number;
  lazy: number;
}

const DEFAULT_LIMITS: LevelLimits = { chain: 128, lazy: 2 };

// Chain limits and lazy-match thresholds for levels 1-9; both bounds increase with compression effort.
const LEVEL_LIMITS: readonly LevelLimits[] = [
  { chain: 0, lazy: 0 },
  { chain: 4, lazy: 0 },
  { chain: 8, lazy: 0 },
  { chain: 16, lazy: 1 },
  { chain: 32, lazy: 1 },
  { chain: 64, lazy: 1 },
  DEFAULT_LIMITS,
  { chain: 256, lazy: 2 },
  { chain: 512, lazy: 2 },
  { chain: 1024, lazy: 2 },
];

const hashAt = (data: Uint8Array, position: number): number =>
  ((data[position] ?? 0) * 251 + (data[position + 1] ?? 0) * 31 + (data[position + 2] ?? 0)) & 65535;

// Indexed loops over words, because iterating a typed array with for...of allocates an iterator result per element in unoptimized code.
export interface TokenList {
  readonly words: Uint32Array;
  readonly count: number;
}

// A token is one 32-bit word: bits 0-8 hold the literal/length symbol (a literal byte is below 256), and for a match bits 9-13 hold the distance symbol, bits 14-18 the length extra value and bits 19-31 the distance extra value (RFC 1951, 3.2.5).
export const matchToken = (length: number, distance: number): number => {
  const lengthCode = LENGTH_CODE[length - 3] ?? 0;
  const distanceCode = DISTANCE_CODE[distance <= 256 ? distance - 1 : 256 + ((distance - 1) >>> 7)] ?? 0;
  return (257 + lengthCode) | (distanceCode << 9) | ((length - (LENGTH_BASE[lengthCode] ?? 0)) << 14) | ((distance - (DISTANCE_BASE[distanceCode] ?? 0)) << 19);
};

// Writes the tokens for data into tokens, which holds at least data.length entries, and returns how many were written.
export const tokenize = (data: Uint8Array, level: number, tokens: Uint32Array): number => {
  // RFC 1951, 3.2 limits backward distances to 32 KiB and match lengths to 258 bytes.
  const end = data.length;
  const heads = new Int32Array(65536).fill(-1);
  const previous = new Int32Array(end).fill(-1);
  const limits = LEVEL_LIMITS[level] ?? DEFAULT_LIMITS;
  let count = 0;
  let foundDistance = 0;

  const insert = (position: number): void => {
    if (position + 2 >= end) return;
    const hash = hashAt(data, position);
    previous[position] = heads[hash] ?? -1;
    heads[hash] = position;
  };

  // Returns the best match length at position and leaves its distance in foundDistance.
  const find = (position: number): number => {
    foundDistance = 0;
    if (position + 2 >= end) return 0;
    let candidate = heads[hashAt(data, position)] ?? -1;
    let bestLength = 2;
    const limit = Math.min(258, end - position);
    let searched = 0;
    while (candidate >= 0 && position - candidate <= 32768 && searched < limits.chain) {
      let length = 0;
      while (length < limit && data[candidate + length] === data[position + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        foundDistance = position - candidate;
        if (length === limit) break;
      }
      candidate = previous[candidate] ?? -1;
      searched++;
    }
    return bestLength;
  };

  let position = 0;
  while (position < end) {
    const length = find(position);
    const distance = foundDistance;
    insert(position);
    if (length >= 3) {
      if (limits.lazy > 0 && find(position + 1) > length + limits.lazy) {
        tokens[count++] = data[position] ?? 0;
        position++;
        continue;
      }
      tokens[count++] = matchToken(length, distance);
      for (let index = 1; index < length; index++) insert(position + index);
      position += length;
    } else {
      tokens[count++] = data[position] ?? 0;
      position++;
    }
  }
  return count;
};
