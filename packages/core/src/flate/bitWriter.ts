export class BitWriter {
  private bytes = new Uint8Array(256);
  private used = 0;
  private bits = 0;
  private bitCount = 0;

  private reserve(additional: number): void {
    const needed = this.used + additional;
    if (needed <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
  }

  writeBits(value: number, count: number): void {
    this.bits |= value << this.bitCount;
    this.bitCount += count;
    while (this.bitCount >= 8) {
      this.writeByte(this.bits & 255);
      this.bits >>>= 8;
      this.bitCount -= 8;
    }
  }

  alignByte(): void {
    if (this.bitCount > 0) this.writeByte(this.bits & 255);
    this.bits = 0;
    this.bitCount = 0;
  }

  writeByte(byte: number): void {
    this.reserve(1);
    this.bytes[this.used++] = byte;
  }

  writeBytes(data: Uint8Array): void {
    this.reserve(data.length);
    this.bytes.set(data, this.used);
    this.used += data.length;
  }

  finish(): Uint8Array {
    this.alignByte();
    return this.bytes.slice(0, this.used);
  }
}
