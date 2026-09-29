import { ByteWriter } from '../bytes/byteWriter.ts';
import { ResourceLimitError } from '../error/resourceLimitError.ts';

/** Decoder output that throws ResourceLimitError instead of growing past a limit. */
export class BoundedOutput {
  private readonly writer = new ByteWriter();
  private readonly limit: number;
  private readonly filter: string;

  constructor(limit: number, filter: string) {
    this.limit = limit;
    this.filter = filter;
  }

  private reserve(count: number): void {
    if (this.writer.length + count > this.limit) throw new ResourceLimitError(`${this.filter} output exceeds maxDecodedBytes (${String(this.limit)} bytes)`);
  }

  push(byte: number): void {
    this.reserve(1);
    this.writer.writeByte(byte);
  }

  pushBytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.writer.writeBytes(bytes);
  }

  toUint8Array(): Uint8Array {
    return this.writer.toUint8Array();
  }
}
