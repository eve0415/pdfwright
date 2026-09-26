import { ParseError } from '../error/parseError.ts';

export class BitReader {
  private position = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get bitPosition(): number {
    return this.position;
  }

  get availableBits(): number {
    return this.data.length * 8 - this.position;
  }

  peekBits(count: number): number {
    const offset = this.position >>> 3;
    const shift = this.position & 7;
    let value = (this.data[offset] ?? 0) >>> shift;
    if (count > 8 - shift) value |= (this.data[offset + 1] ?? 0) << (8 - shift);
    if (count > 16 - shift) value |= (this.data[offset + 2] ?? 0) << (16 - shift);
    return value & ((1 << count) - 1);
  }

  readBits(count: number): number {
    if (this.availableBits < count) throw new ParseError('truncated deflate stream', Math.ceil(this.position / 8));
    const value = this.peekBits(count);
    this.position += count;
    return value;
  }

  skipBits(count: number): void {
    if (this.availableBits < count) throw new ParseError('truncated deflate stream', Math.ceil(this.position / 8));
    this.position += count;
  }

  alignByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}
