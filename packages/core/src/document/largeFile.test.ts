import { describe, expect, it } from 'vitest';

import { compareDocuments } from '../compare/compareDocuments.ts';
import { pt } from '../length/length.ts';
import { largeFile } from '../testing/largePdf.ts';

import { loadDocument } from './loadDocument.ts';
import { rect } from './rect.ts';

const copiedBytes = (chunks: readonly Uint8Array[], source: Uint8Array): number =>
  chunks.filter(chunk => chunk.buffer !== source.buffer).reduce((sum, chunk) => sum + chunk.length, 0);

describe('large files', () => {
  const source = largeFile(20, 1_000_000);

  it('saves an edit of a large file incrementally without copying it', () => {
    const document = loadDocument(source);
    document.page(7).setBox('TrimBox', rect(pt(10), pt(10), pt(600), pt(780)));
    const saved = document.save();
    const reloaded = loadDocument(saved.chunks);
    expect([saved.chunks[0] === source, copiedBytes(saved.chunks, source) < 4096, reloaded.pageCount]).toStrictEqual([true, true, 20]);
    expect(compareDocuments(loadDocument(source), reloaded).differences.map(difference => difference.kind)).toStrictEqual(['page-box']);
  });

  it('rewrites a large file from views of its source', () => {
    const saved = loadDocument(source).save({ mode: 'full' });
    expect([saved.byteLength > source.length - 64, copiedBytes(saved.chunks, source) < 8192, saved.chunks.length < 16]).toStrictEqual([true, true, true]);
  });
});
