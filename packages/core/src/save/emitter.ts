import { ByteWriter } from '../bytes/byteWriter.ts';
import { isUint8Array } from '../bytes/isUint8Array.ts';

export type EmittedPart = Uint8Array | { readonly length: number; readonly produce: () => Generator<Uint8Array> };

export const emittedChunks = function* (parts: ReadonlyArray<EmittedPart>): Generator<Uint8Array> {
  for (const part of parts) {
    if (isUint8Array(part)) {
      yield part;
    } else {
      yield* part.produce();
    }
  }
};

/** Collects output as chunks: views of existing bytes, and new bytes written into a buffer; `offset` is the position of the next byte. */
export class PdfEmitter {
  private readonly chunks: Array<EmittedPart> = [];
  private flushed = 0;
  writer: ByteWriter = new ByteWriter();

  get offset(): number {
    return this.flushed + this.writer.length;
  }

  private flush(): void {
    if (this.writer.length === 0) {
      return;
    }
    const bytes = this.writer.toUint8Array();
    this.chunks.push(bytes);
    this.flushed += bytes.length;
    this.writer = new ByteWriter();
  }

  /** Emits existing bytes as their own chunk, without copying them. */
  view(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }
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

  finishParts(): ReadonlyArray<EmittedPart> {
    this.flush();
    return this.chunks;
  }

  /** The chunks emitted so far, finishing the current buffer. */
  finish(): Array<Uint8Array> {
    this.flush();
    const bytes = this.chunks.filter(part => isUint8Array(part));
    if (bytes.length !== this.chunks.length) {
      throw new Error('produced output requires a streamed save');
    }
    return bytes;
  }
}
