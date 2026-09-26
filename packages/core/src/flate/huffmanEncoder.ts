interface TreeNode {
  readonly weight: number;
  readonly minimumSymbol: number;
  readonly symbol: number;
  readonly left?: TreeNode;
  readonly right?: TreeNode;
}

interface TreeLengths {
  lengths: number[];
  leaves: TreeNode[];
}

const treeCodeLengths = (frequencies: readonly number[]): TreeLengths => {
  const lengths = Array.from({ length: frequencies.length }, () => 0);
  const leaves: TreeNode[] = [];
  for (let symbol = 0; symbol < frequencies.length; symbol++) {
    const weight = frequencies[symbol] ?? 0;
    if (weight > 0) leaves.push({ weight, minimumSymbol: symbol, symbol });
  }
  if (leaves.length === 0) return { lengths, leaves };
  if (leaves.length === 1) {
    const [leaf] = leaves;
    if (leaf !== undefined) lengths[leaf.symbol] = 1;
    return { lengths, leaves };
  }
  // RFC 1951, 3.2.2 uses canonical Huffman codes; ties are broken by symbol so frequencies always yield the same tree.
  const queue = [...leaves];
  while (queue.length > 1) {
    queue.sort((left, right) => left.weight - right.weight || left.minimumSymbol - right.minimumSymbol);
    const left = queue.shift();
    const right = queue.shift();
    if (left === undefined || right === undefined) break;
    queue.push({ weight: left.weight + right.weight, minimumSymbol: Math.min(left.minimumSymbol, right.minimumSymbol), symbol: -1, left, right });
  }
  const visit = (node: TreeNode, depth: number): void => {
    if (node.symbol >= 0) lengths[node.symbol] = depth;
    else {
      if (node.left !== undefined) visit(node.left, depth + 1);
      if (node.right !== undefined) visit(node.right, depth + 1);
    }
  };
  const [root] = queue;
  if (root !== undefined) visit(root, 0);

  return { lengths, leaves };
};

const limitCodeLengths = (lengths: number[], leaves: TreeNode[], maxBits: number): number[] => {
  const counts = Array.from({ length: maxBits + 1 }, () => 0);
  for (const leaf of leaves) {
    const depth = lengths[leaf.symbol] ?? 0;
    const limited = Math.min(depth, maxBits);
    counts[limited] = (counts[limited] ?? 0) + 1;
  }
  // Split shorter codes until the clipped tree satisfies the Kraft equality at the bit limit.
  let usedSlots = counts.reduce((sum, count, bits) => sum + (bits === 0 ? 0 : count * 2 ** (maxBits - bits)), 0);
  while (usedSlots > 2 ** maxBits) {
    let bits = maxBits - 1;
    while (bits > 0 && counts[bits] === 0) bits--;
    counts[bits] = (counts[bits] ?? 0) - 1;
    counts[bits + 1] = (counts[bits + 1] ?? 0) + 2;
    counts[maxBits] = (counts[maxBits] ?? 0) - 1;
    usedSlots--;
  }
  leaves.sort((left, right) => left.weight - right.weight || left.symbol - right.symbol);
  let index = 0;
  for (let bits = maxBits; bits > 0; bits--) {
    for (let count = 0; count < (counts[bits] ?? 0); count++) {
      const leaf = leaves[index++];
      if (leaf !== undefined) lengths[leaf.symbol] = bits;
    }
  }
  return lengths;
};

export const buildCodeLengths = (frequencies: readonly number[], maxBits: number): number[] => {
  const tree = treeCodeLengths(frequencies);
  if (tree.leaves.length < 2) return tree.lengths;
  return limitCodeLengths(tree.lengths, tree.leaves, maxBits);
};

const reverseBits = (code: number, length: number): number => {
  let reversed = 0;
  let remaining = code;
  for (let bit = 0; bit < length; bit++) {
    reversed = (reversed << 1) | (remaining & 1);
    remaining >>>= 1;
  }
  return reversed;
};

export const canonicalCodes = (lengths: readonly number[]): number[] => {
  const maximum = Math.max(0, ...lengths);
  const counts = Array.from({ length: maximum + 1 }, () => 0);
  for (const length of lengths) if (length > 0) counts[length] = (counts[length] ?? 0) + 1;
  const next = Array.from({ length: maximum + 1 }, () => 0);
  let code = 0;
  for (let bits = 1; bits <= maximum; bits++) {
    code = (code + (counts[bits - 1] ?? 0)) << 1;
    next[bits] = code;
  }
  return lengths.map(length => {
    if (length === 0) return 0;
    const current = next[length] ?? 0;
    next[length] = current + 1;
    return reverseBits(current, length);
  });
};
