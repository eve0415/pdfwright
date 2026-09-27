import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

export class ChunkedInflateOutput {
  private readonly window = new Uint8Array(32768);
  private chunk = new Uint8Array(65536);
  private used = 0;
  private total = 0;
  private ready: Uint8Array[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(byte: number): void {
    if (this.total >= this.limit) throw new ResourceLimitError(`inflated data exceeds maxOutputBytes (${String(this.limit)} bytes)`);
    this.window[this.total & 32767] = byte;
    this.total++;
    this.chunk[this.used++] = byte;
    if (this.used === this.chunk.length) {
      this.ready.push(this.chunk);
      this.chunk = new Uint8Array(65536);
      this.used = 0;
    }
  }

  copy(distance: number, length: number, offset: number): void {
    if (distance < 1 || distance > this.total || distance > 32768) throw new ParseError('invalid backward distance', offset);
    for (let index = 0; index < length; index++) this.push(this.window[(this.total - distance) & 32767] ?? 0);
  }

  drain(): Uint8Array[] {
    const result = this.ready;
    this.ready = [];
    return result;
  }

  finish(): Uint8Array {
    return this.chunk.slice(0, this.used);
  }
}
