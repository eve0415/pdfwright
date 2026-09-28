import { ByteWriter } from '../bytes/byteWriter.ts';

/** Keeps lexical tokens separate where a page's Contents array splits an operation. */
export const combineContentStreams = (streams: readonly Uint8Array[]): Uint8Array => {
  const writer = new ByteWriter();
  for (const [index, stream] of streams.entries()) {
    if (index > 0) writer.writeByte(0x0a);
    writer.writeBytes(stream);
  }
  return writer.toUint8Array();
};
