import { ParseError } from '../error/parseError.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

import { validateMeshBits } from './meshBits.ts';

export class MeshBitWriter {
  private readonly bytes: number[] = [];
  private position = 0;

  write(bits: number, value: number): void {
    validateMeshBits(bits);
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits) throw new ParseError('mesh field value exceeds its bit width', 0);
    for (let index = bits - 1; index >= 0; index--) {
      const byte = Math.floor(this.position / 8);
      if (this.bytes[byte] === undefined) this.bytes.push(0);
      const bit = Math.floor(value / 2 ** index) % 2;
      this.bytes[byte] = (this.bytes[byte] ?? 0) + bit * 2 ** (7 - (this.position % 8));
      this.position++;
    }
  }

  alignByte(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }

  finish(maxBytes: number): Uint8Array {
    if (this.bytes.length > maxBytes) throw new ResourceLimitError(`converted mesh exceeds maxDecodedBytes (${String(maxBytes)} bytes)`);
    return Uint8Array.from(this.bytes);
  }
}
