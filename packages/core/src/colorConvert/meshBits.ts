import { ParseError } from '../error/parseError.ts';

export const validateMeshBits = (bits: number): void => {
  if (!Number.isInteger(bits) || bits < 1 || bits > 32) throw new ParseError('mesh field width must be from 1 to 32 bits', 0);
};

export class MeshBitReader {
  private readonly data: Uint8Array;
  private position = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remainingBits(): number {
    return this.data.length * 8 - this.position;
  }

  read(bits: number): number {
    validateMeshBits(bits);
    if (bits > this.remainingBits) throw new ParseError('truncated mesh record', Math.floor(this.position / 8));
    let value = 0;
    for (let index = 0; index < bits; index++) {
      const offset = this.position + index;
      const byte = this.data[Math.floor(offset / 8)] ?? 0;
      value = value * 2 + (Math.floor(byte / 2 ** (7 - (offset % 8))) % 2);
    }
    this.position += bits;
    return value;
  }

  alignByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}
