import type { SaveWarning } from '../save/saveWarning.ts';

/** A saved PDF held as ordered chunks: views of the source file and new buffers, never joined. */
export interface SavedPdf {
  readonly kind: 'buffered';
  readonly chunks: readonly Uint8Array[];
  readonly byteLength: number;
  /** How the file was written: as an update appended to the source, or in full. */
  readonly mode: 'incremental' | 'full';
  readonly warnings: readonly SaveWarning[];
  /** Joins the chunks into one new array, which doubles the memory a large file needs. */
  toBytes: () => Uint8Array;
  toStream: () => ReadableStream<Uint8Array>;
}

export interface SaveDetails {
  readonly mode: 'incremental' | 'full';
  readonly warnings: readonly SaveWarning[];
}

const WRITTEN: SaveDetails = { mode: 'full', warnings: [] };

export const savedPdf = (input: readonly Uint8Array[], details: SaveDetails = WRITTEN): SavedPdf => {
  const chunks = Object.freeze([...input]);
  const byteLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    kind: 'buffered',
    chunks,
    byteLength,
    mode: details.mode,
    warnings: Object.freeze([...details.warnings]),
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
