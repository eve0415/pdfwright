/** One step of an alignment: an intended item matched with a found one, an intended item with no counterpart, or a found item with no counterpart. */
export type AlignmentStep =
  | { readonly kind: 'equal'; readonly intended: number; readonly found: number }
  | { readonly kind: 'missing'; readonly intended: number }
  | { readonly kind: 'extra'; readonly found: number };

type Equal = (intended: number, found: number) => boolean;

interface Range {
  readonly aLow: number;
  readonly aHigh: number;
  readonly bLow: number;
  readonly bHigh: number;
}

/** The state of one bisection: the range, the furthest x each diagonal reached from either end, and the diagonals still inside the range. */
interface Search {
  readonly range: Range;
  readonly n: number;
  readonly m: number;
  readonly offset: number;
  readonly forward: Int32Array;
  readonly reverse: Int32Array;
  readonly delta: number;
  readonly bounds: { forwardStart: number; forwardEnd: number; reverseStart: number; reverseEnd: number };
}

// A diagonal's furthest x, or −1 when it lies outside the arrays or has not been reached.
const at = (values: Int32Array, index: number): number => values[index] ?? -1;

class Aligner {
  readonly steps: AlignmentStep[] = [];
  private readonly equal: Equal;

  constructor(equal: Equal) {
    this.equal = equal;
  }

  private unmatched({ aLow, aHigh, bLow, bHigh }: Range): void {
    for (let index = aLow; index < aHigh; index++) this.steps.push({ kind: 'missing', intended: index });
    for (let index = bLow; index < bHigh; index++) this.steps.push({ kind: 'extra', found: index });
  }

  // The middle of a range whose first and last items differ: the searches from both ends step one edit at a time until their paths overlap, and the range is split there.
  private bisect(range: Range): void {
    const n = range.aHigh - range.aLow;
    const m = range.bHigh - range.bLow;
    const most = Math.ceil((n + m) / 2);
    const search: Search = {
      range,
      n,
      m,
      offset: most,
      forward: new Int32Array(2 * most).fill(-1),
      reverse: new Int32Array(2 * most).fill(-1),
      delta: n - m,
      bounds: { forwardStart: 0, forwardEnd: 0, reverseStart: 0, reverseEnd: 0 },
    };
    search.forward[most + 1] = 0;
    search.reverse[most + 1] = 0;
    for (let d = 0; d < most; d++) {
      const meeting = this.forwardStep(search, d) ?? this.reverseStep(search, d);
      if (meeting !== undefined) {
        this.split(range, meeting[0], meeting[1]);
        return;
      }
    }
    this.unmatched(range);
  }

  // One edit further from the start; with an odd delta, this search finds where the paths overlap.
  private forwardStep(search: Search, d: number): readonly [number, number] | undefined {
    const { range, n, m, offset, forward, reverse, delta, bounds } = search;
    for (let k = -d + bounds.forwardStart; k <= d - bounds.forwardEnd; k += 2) {
      const index = offset + k;
      let x = k === -d || (k !== d && at(forward, index - 1) < at(forward, index + 1)) ? at(forward, index + 1) : at(forward, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && this.equal(range.aLow + x, range.bLow + y)) {
        x++;
        y++;
      }
      forward[index] = x;
      const opposite = offset + delta - k;
      if (x > n) bounds.forwardEnd += 2;
      else if (y > m) bounds.forwardStart += 2;
      else if (delta % 2 !== 0 && at(reverse, opposite) !== -1 && x >= n - at(reverse, opposite)) return [x, y];
    }
    return undefined;
  }

  // One edit further from the end; with an even delta, this search finds where the paths overlap.
  private reverseStep(search: Search, d: number): readonly [number, number] | undefined {
    const { range, n, m, offset, forward, reverse, delta, bounds } = search;
    for (let k = -d + bounds.reverseStart; k <= d - bounds.reverseEnd; k += 2) {
      const index = offset + k;
      let x = k === -d || (k !== d && at(reverse, index - 1) < at(reverse, index + 1)) ? at(reverse, index + 1) : at(reverse, index - 1) + 1;
      let y = x - k;
      while (x < n && y < m && this.equal(range.aLow + n - x - 1, range.bLow + m - y - 1)) {
        x++;
        y++;
      }
      reverse[index] = x;
      const opposite = offset + delta - k;
      const forwardX = at(forward, opposite);
      if (x > n) bounds.reverseEnd += 2;
      else if (y > m) bounds.reverseStart += 2;
      else if (delta % 2 === 0 && forwardX !== -1 && forwardX >= n - x) return [forwardX, offset + forwardX - opposite];
    }
    return undefined;
  }

  private split({ aLow, aHigh, bLow, bHigh }: Range, x: number, y: number): void {
    this.diff({ aLow, aHigh: aLow + x, bLow, bHigh: bLow + y });
    this.diff({ aLow: aLow + x, aHigh, bLow: bLow + y, bHigh });
  }

  diff({ aLow, aHigh, bLow, bHigh }: Range): void {
    const { equal, steps } = this;
    let [a0, a1, b0, b1] = [aLow, aHigh, bLow, bHigh];
    while (a0 < a1 && b0 < b1 && equal(a0, b0)) {
      steps.push({ kind: 'equal', intended: a0, found: b0 });
      a0++;
      b0++;
    }
    const suffix: AlignmentStep[] = [];
    while (a0 < a1 && b0 < b1 && equal(a1 - 1, b1 - 1)) {
      a1--;
      b1--;
      suffix.push({ kind: 'equal', intended: a1, found: b1 });
    }
    const middle = { aLow: a0, aHigh: a1, bLow: b0, bHigh: b1 };
    if (a0 === a1 || b0 === b1) this.unmatched(middle);
    else this.bisect(middle);
    for (const step of suffix.toReversed()) steps.push(step);
  }
}

/**
 * Aligns two sequences by Myers' O(ND) difference algorithm ("An O(ND) Difference Algorithm and Its Variations", Algorithmica 1, 1986), searching from both ends at once so that memory stays linear: common prefixes and suffixes are matched first, and the rest is split where the forward and reverse searches meet.
 * The result lists every item of both sequences once, in order.
 */
export const align = (intendedLength: number, foundLength: number, equal: Equal): readonly AlignmentStep[] => {
  const aligner = new Aligner(equal);
  aligner.diff({ aLow: 0, aHigh: intendedLength, bLow: 0, bHigh: foundLength });
  return aligner.steps;
};
