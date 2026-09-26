export type Token = { kind: 'literal'; byte: number } | { kind: 'match'; length: number; distance: number };

interface LevelLimits {
  chain: number;
  lazy: number;
}

interface Match {
  length: number;
  distance: number;
}

// Chain limits and lazy-match thresholds for levels 1-9; both bounds increase with compression effort.
const LEVEL_LIMITS: readonly LevelLimits[] = [
  { chain: 0, lazy: 0 },
  { chain: 4, lazy: 0 },
  { chain: 8, lazy: 0 },
  { chain: 16, lazy: 1 },
  { chain: 32, lazy: 1 },
  { chain: 64, lazy: 1 },
  { chain: 128, lazy: 2 },
  { chain: 256, lazy: 2 },
  { chain: 512, lazy: 2 },
  { chain: 1024, lazy: 2 },
];

const hashAt = (data: Uint8Array, position: number): number =>
  ((data[position] ?? 0) * 251 + (data[position + 1] ?? 0) * 31 + (data[position + 2] ?? 0)) & 65535;

export const tokenize = (data: Uint8Array, level: number): Token[] => {
  // RFC 1951, 3.2 limits backward distances to 32 KiB and match lengths to 258 bytes.
  const start = 0;
  const end = data.length;
  const heads = new Int32Array(65536).fill(-1);
  const previous = new Int32Array(end - start).fill(-1);
  const tokens: Token[] = [];
  const limits = LEVEL_LIMITS[level] ?? LEVEL_LIMITS[6];
  if (limits === undefined) return tokens;

  const insert = (position: number): void => {
    if (position + 2 >= end) return;
    const hash = hashAt(data, position);
    previous[position - start] = heads[hash] ?? -1;
    heads[hash] = position;
  };

  const find = (position: number): Match => {
    if (position + 2 >= end) return { length: 0, distance: 0 };
    let candidate = heads[hashAt(data, position)] ?? -1;
    let bestLength = 2;
    let bestDistance = 0;
    const limit = Math.min(258, end - position);
    let searched = 0;
    while (candidate >= start && position - candidate <= 32768 && searched < limits.chain) {
      let length = 0;
      while (length < limit && data[candidate + length] === data[position + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        bestDistance = position - candidate;
        if (length === limit) break;
      }
      candidate = previous[candidate - start] ?? -1;
      searched++;
    }
    return { length: bestLength, distance: bestDistance };
  };

  let position = start;
  while (position < end) {
    const best = find(position);
    insert(position);
    if (best.length >= 3) {
      const next = limits.lazy > 0 ? find(position + 1) : { length: 0, distance: 0 };
      if (next.length > best.length + limits.lazy) {
        tokens.push({ kind: 'literal', byte: data[position] ?? 0 });
        position++;
        continue;
      }
      tokens.push({ kind: 'match', length: best.length, distance: best.distance });
      for (let index = 1; index < best.length; index++) insert(position + index);
      position += best.length;
    } else {
      tokens.push({ kind: 'literal', byte: data[position] ?? 0 });
      position++;
    }
  }
  return tokens;
};
