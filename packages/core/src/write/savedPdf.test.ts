import type { SaveWarning } from '../save/saveWarning.ts';

import { describe, expect, it } from 'vitest';

import { savedPdf, streamedPdf } from './savedPdf.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Array<Uint8Array>> => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

const warning: SaveWarning = { code: 'version-raised', detail: 'raised to 1.7' };

describe('buffered saved PDFs', () => {
  it('defaults to a full save with no warnings', () => {
    const saved = savedPdf([Uint8Array.of(1)]);
    expect([saved.kind, saved.mode, saved.warnings]).toStrictEqual(['buffered', 'full', []]);
  });

  it('keeps frozen copies of the chunk list and the warnings', () => {
    const input = [Uint8Array.of(1)];
    const warnings = [warning];
    const saved = savedPdf(input, { mode: 'incremental', warnings });
    input.push(Uint8Array.of(2));
    warnings.push({ code: 'junk-dropped', detail: 'dropped' });
    expect([saved.mode, saved.chunks, saved.warnings, Object.isFrozen(saved.chunks), Object.isFrozen(saved.warnings)]).toStrictEqual([
      'incremental',
      [Uint8Array.of(1)],
      [warning],
      true,
      true,
    ]);
  });

  it('joins every chunk, the empty one included, in order', () => {
    const saved = savedPdf([Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(3)]);
    expect([saved.byteLength, saved.toBytes()]).toStrictEqual([3, Uint8Array.of(1, 2, 3)]);
  });

  it('streams every chunk on each read, and nothing for an empty save', async () => {
    const chunks = [Uint8Array.of(1, 2), new Uint8Array(), Uint8Array.of(3)];
    const saved = savedPdf(chunks);
    const empty = savedPdf([]);
    expect([await readAll(saved.toStream()), await readAll(saved.toStream()), empty.byteLength, await readAll(empty.toStream())]).toStrictEqual([
      chunks,
      chunks,
      0,
      [],
    ]);
  });
});

interface CountedOutput {
  readonly produce: () => Generator<Uint8Array>;
  readonly runs: () => number;
  readonly produced: () => number;
}

// Counts how often the output is generated and how many chunks have been produced.
const counted = (): CountedOutput => {
  let runs = 0;
  let produced = 0;
  return {
    *produce() {
      runs++;
      for (const chunk of [Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)]) {
        produced++;
        yield chunk;
      }
    },
    runs: () => runs,
    produced: () => produced,
  };
};

describe('streamed saved PDFs', () => {
  it('generates the output again for each read, and every read agrees', () => {
    const counter = counted();
    const saved = streamedPdf(counter.produce, { mode: 'full', warnings: [] });
    const reads = [saved.chunks, saved.byteLength, saved.toBytes(), saved.toBytes(), saved.measureByteLength()];
    expect([reads, counter.runs()]).toStrictEqual([
      [[Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5, 6)], 6, Uint8Array.of(1, 2, 3, 4, 5, 6), Uint8Array.of(1, 2, 3, 4, 5, 6), 6],
      5,
    ]);
  });

  it('keeps a frozen copy of the warnings', () => {
    const warnings = [warning];
    const saved = streamedPdf(counted().produce, { mode: 'incremental', warnings });
    warnings.push({ code: 'junk-dropped', detail: 'dropped' });
    expect([saved.kind, saved.mode, saved.warnings, Object.isFrozen(saved.warnings)]).toStrictEqual(['streamed', 'incremental', [warning], true]);
  });

  // WHATWG Streams: a read of an empty stream calls pull, whose enqueue fulfils that read directly, and the next pull waits until the promise pull returned has settled.
  it('generates chunks only as the stream is read', async () => {
    const counter = counted();
    const reader = streamedPdf(counter.produce, { mode: 'full', warnings: [] }).toStream().getReader();
    const first = await reader.read();
    const producedAfterFirst = counter.produced();
    const rest = [await reader.read(), await reader.read(), await reader.read()];
    expect([first.value, producedAfterFirst, rest.map(result => result.done), counter.runs()]).toStrictEqual([Uint8Array.of(1, 2), 1, [false, false, true], 1]);
  });
});
