import { ByteWriter } from '../bytes/byteWriter.ts';

/** Collects output as chunks: views of existing bytes, and new bytes written into a buffer; `offset` is the position of the next byte. */
export class PdfEmitter {
  private readonly chunks: Uint8Array[] = [];
  private flushed = 0;
  writer: ByteWriter = new ByteWriter();

  get offset(): number {
    return this.flushed + this.writer.length;
  }

  private flush(): void {
    if (this.writer.length === 0) return;
    const bytes = this.writer.toUint8Array();
    this.chunks.push(bytes);
    this.flushed += bytes.length;
    this.writer = new ByteWriter();
  }

  /** Emits existing bytes as their own chunk, without copying them. */
  view(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.flush();
    this.chunks.push(bytes);
    this.flushed += bytes.length;
  }

  /** The chunks emitted so far, finishing the current buffer. */
  finish(): Uint8Array[] {
    this.flush();
    return this.chunks;
  }
}
