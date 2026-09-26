export class ByteWriter {
  private buffer = new Uint8Array(256);
  private used = 0;

  get length(): number {
    return this.used;
  }

  private reserve(additional: number): void {
    const needed = this.used + additional;
    if (needed <= this.buffer.length) return;
    let capacity = this.buffer.length;
    while (capacity < needed) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer);
    this.buffer = grown;
  }

  writeByte(byte: number): void {
    this.reserve(1);
    this.buffer[this.used++] = byte;
  }

  writeBytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.used);
    this.used += bytes.length;
  }

  writeAscii(text: string): void {
    this.reserve(text.length);
    for (let index = 0; index < text.length; index++) this.buffer[this.used++] = text.codePointAt(index) ?? 0;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }
}
