import { ByteWriter } from '../bytes/byteWriter.ts';

// RFC 1951, 3.1.1: "Data elements are packed into bytes in order of increasing bit number within the byte, i.e., starting with the least-significant bit of the byte."
export class BitWriter {
  private readonly bytes = new ByteWriter();
  private bits = 0;
  private bitCount = 0;

  writeBits(value: number, count: number): void {
    this.bits |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.bytes.writeByte(this.bits & 255);
      this.bits >>>= 8;
      this.bitCount -= 8;
    }
  }

  alignByte(): void {
    if (this.bitCount > 0) this.bytes.writeByte(this.bits & 255);
    this.bits = 0;
    this.bitCount = 0;
  }

  writeByte(byte: number): void {
    this.bytes.writeByte(byte);
  }

  writeBytes(data: Uint8Array): void {
    this.bytes.writeBytes(data);
  }

  finish(): Uint8Array {
    this.alignByte();
    return this.bytes.toUint8Array();
  }

  drain(): Uint8Array {
    return this.bytes.drain();
  }
}
