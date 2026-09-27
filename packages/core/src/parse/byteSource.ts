import type { LexContext, LexWindow } from './lexer.ts';
import type { LoadWarning } from './loadWarning.ts';

import { WindowEndError } from './windowEndError.ts';

const MIN_COPY = 4096;

/**
 * The bytes of a file held as one or more segments, such as the chunks of a saved PDF, which are never joined.
 * Parsing runs inside the segment that holds an offset; an object that crosses into the next segment is parsed again from a copied window.
 */
export class ByteSource {
  readonly segments: readonly Uint8Array[];
  readonly length: number;
  private readonly starts: number[];

  constructor(input: Uint8Array | readonly Uint8Array[]) {
    const segments = input instanceof Uint8Array ? [input] : input.filter(segment => segment.length > 0);
    this.segments = segments;
    this.starts = [];
    let length = 0;
    for (const segment of segments) {
      this.starts.push(length);
      length += segment.length;
    }
    this.length = length;
  }

  private segmentIndex(offset: number): number {
    let low = 0;
    let high = this.segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  byteAt(offset: number): number | undefined {
    if (offset < 0 || offset >= this.length) return undefined;
    const index = this.segmentIndex(offset);
    return this.segments[index]?.[offset - (this.starts[index] ?? 0)];
  }

  /** The segment that holds `offset`, without copying. */
  window(offset: number): LexWindow {
    const index = this.segmentIndex(Math.min(Math.max(offset, 0), this.length - 1));
    const bytes = this.segments[index] ?? new Uint8Array();
    const base = this.starts[index] ?? 0;
    return { bytes, base, final: base + bytes.length >= this.length, sourceLength: this.length };
  }

  /** A copy of the bytes from `start` to `end` (clipped to the source), for parsing across segment boundaries. */
  copy(start: number, end: number): LexWindow {
    const from = Math.max(start, 0);
    const to = Math.min(end, this.length);
    const bytes = new Uint8Array(Math.max(to - from, 0));
    let offset = 0;
    for (const view of this.views(from, to)) {
      bytes.set(view, offset);
      offset += view.length;
    }
    return { bytes, base: from, final: to >= this.length, sourceLength: this.length, copied: true };
  }

  /** Views of the original segments covering `start` to `end`. */
  views(start: number, end: number): Uint8Array[] {
    const views: Uint8Array[] = [];
    if (start >= end || this.segments.length === 0) return views;
    for (let index = this.segmentIndex(start); index < this.segments.length; index++) {
      const segment = this.segments[index] ?? new Uint8Array();
      const base = this.starts[index] ?? 0;
      if (base >= end) break;
      views.push(segment.subarray(Math.max(start - base, 0), Math.min(end - base, segment.length)));
    }
    return views;
  }

  /**
   * Runs `parse` at `offset` in the segment that holds it, and again over larger copied windows while it reaches the end of a window before the end of the source.
   * Warnings from an attempt that ran out of bytes are dropped, so each is reported once.
   */
  parseAt<T>(offset: number, context: LexContext, parse: (window: LexWindow, local: number, context: LexContext) => T): T {
    let window = this.window(offset);
    let size = Math.max(MIN_COPY, 2 * (window.base + window.bytes.length - offset));
    for (;;) {
      const warnings: LoadWarning[] = [];
      const buffered: LexContext = {
        warn: warning => {
          warnings.push(warning);
        },
        names: context.names,
      };
      try {
        const result = parse(window, offset - window.base, buffered);
        for (const warning of warnings) context.warn(warning);
        return result;
      } catch (error: unknown) {
        if (!(error instanceof WindowEndError) || window.final) throw error;
      }
      window = this.copy(offset, offset + size);
      size *= 2;
    }
  }
}
