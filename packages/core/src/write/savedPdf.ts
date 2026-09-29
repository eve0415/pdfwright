import type { SaveWarning } from '../save/saveWarning.ts';

/** A saved PDF held as ordered chunks: views of the source file and new buffers, never joined. */
export interface BufferedSavedPdf {
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

/** A repeatable full save whose Flate image bytes are generated while `toStream` is read; `toBytes` and `chunks` materialize output, while no fixed output-size limit is imposed by this type under ISO 32000-1:2008, 7.5. */
export interface StreamedSavedPdf extends SaveDetails {
  readonly kind: 'streamed';
  /** Generates the whole output again on every read, as one array of chunks. */
  readonly chunks: readonly Uint8Array[];
  readonly byteLength: number;
  readonly toBytes: () => Uint8Array;
  readonly toStream: () => ReadableStream<Uint8Array>;
  readonly measureByteLength: () => number;
}

/** Either buffered chunks or a repeatable streamed save, with mode and warnings; `toStream` reads the result and `toBytes` joins it under ISO 32000-1:2008, 7.5. */
export type SavedPdf = BufferedSavedPdf | StreamedSavedPdf;

export interface SaveDetails {
  readonly mode: 'incremental' | 'full';
  readonly warnings: readonly SaveWarning[];
}

const WRITTEN: SaveDetails = { mode: 'full', warnings: [] };

export const savedPdf = (input: readonly Uint8Array[], details: SaveDetails = WRITTEN): BufferedSavedPdf => {
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

/** A repeatable save whose output is generated as the reader consumes it. */
export const streamedPdf = (produce: () => Generator<Uint8Array>, details: SaveDetails): StreamedSavedPdf => ({
  kind: 'streamed',
  mode: details.mode,
  warnings: Object.freeze([...details.warnings]),
  get chunks(): readonly Uint8Array[] {
    return [...produce()];
  },
  get byteLength(): number {
    let length = 0;
    for (const chunk of produce()) length += chunk.length;
    return length;
  },
  toBytes: (): Uint8Array => {
    const chunks = [...produce()];
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  },
  toStream: (): ReadableStream<Uint8Array> => {
    const iterator = produce();
    return new ReadableStream<Uint8Array>({
      pull: controller => {
        const next = iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      },
    });
  },
  measureByteLength: (): number => {
    let length = 0;
    for (const chunk of produce()) length += chunk.length;
    return length;
  },
});
