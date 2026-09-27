import { memoryUsage } from 'node:process';

import { describe, expect, it } from 'vitest';

import { compareDocuments } from '../compare/compareDocuments.ts';
import { pt } from '../length/length.ts';
import { largeFile } from '../testing/largePdf.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

interface Growth {
  readonly inputBytes: number;
  /** Saves, reloaded documents and comparisons still held when memory is read. */
  readonly held: number;
  /** Growth of memory held by array buffers, which a copy of the input would show. */
  readonly bufferBytes: number;
  readonly heapBytes: number;
}

// Loads an 80 MB file, edits it, saves it both ways, reloads each save from its chunks and compares it with the source, all while the input is held.
const measure = (): Growth => {
  const source = largeFile(80, 1_000_000);
  const before = memoryUsage();
  const document = loadDocument(source);
  document.page(40).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
  const kept: unknown[] = [];
  for (const mode of ['incremental', 'full'] as const) {
    const saved = document.save({ mode });
    const reloaded = loadDocument(saved.chunks);
    kept.push(saved, reloaded, compareDocuments(document, reloaded));
  }
  const after = memoryUsage();
  return { inputBytes: source.length, held: kept.length, bufferBytes: after.arrayBuffers - before.arrayBuffers, heapBytes: after.heapUsed - before.heapUsed };
};

describe('memory for a large file', () => {
  it('edits, saves, reloads and compares an 80 MB file without copying it', () => {
    const growth = measure();
    expect([growth.inputBytes > 80_000_000, growth.held, growth.bufferBytes < 16_000_000, growth.heapBytes < 64_000_000]).toStrictEqual([true, 6, true, true]);
  });
});
