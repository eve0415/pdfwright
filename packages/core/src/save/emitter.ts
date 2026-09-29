import { ByteWriter } from '../bytes/byteWriter.ts';

export type EmittedPart = Uint8Array | { readonly length: number; readonly produce: () => Generator<Uint8Array> };

export const emittedChunks = function* (parts: readonly EmittedPart[]): Generator<Uint8Array> {
  for (const part of parts) {
    if (part instanceof Uint8Array) yield part;
    else yield* part.produce();
  }
};

/** Collects output as chunks: views of existing bytes, and new bytes written into a buffer; `offset` is the position of the next byte. */
export class PdfEmitter {
  private readonly chunks: EmittedPart[] = [];
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

  /** Reserves the measured space of a repeatable stream without retaining its bytes. */
  produced(length: number, produce: () => Generator<Uint8Array>): void {
    this.flush();
    this.chunks.push({ length, produce });
    this.flushed += length;
  }

  finishParts(): readonly EmittedPart[] {
    this.flush();
    return this.chunks;
  }

  /** The chunks emitted so far, finishing the current buffer. */
  finish(): Uint8Array[] {
    this.flush();
    if (this.chunks.some(part => !(part instanceof Uint8Array))) throw new Error('produced output requires a streamed save');
    return this.chunks.filter((part): part is Uint8Array => part instanceof Uint8Array);
  }
}
