export interface SavedPdf {
  readonly chunks: readonly Uint8Array[];
  readonly byteLength: number;
  toBytes: () => Uint8Array;
  toStream: () => ReadableStream<Uint8Array>;
}

export const savedPdf = (input: readonly Uint8Array[]): SavedPdf => {
  const chunks = Object.freeze([...input]);
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    chunks,
    byteLength,
    toBytes: (): Uint8Array => {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    },
    toStream: (): ReadableStream<Uint8Array> => {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull: controller => {
          const chunk = chunks[index++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      });
    },
  };
};
